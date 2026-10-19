import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertMappingCoversPorts, verifyGeneratedImageSet, verifyGeneratedVideoSet } from "@hypit/generation";
import type { CanonicalValue } from "@hypit/protocol";
import type { BlobRef } from "@hypit/protocol";
import { wanPorts, sealWanRequest } from "@hypit/wan";
import { wanVideoPorts, sealWanVideoRequest } from "@local/wan-video";

import { comfyUiMappings } from "../src/mapping.js";
import { createComfyUiProvider, createComfyUiRoutes, comfyUiRouteForCapability } from "../src/provider.js";
import type { ComfyUiRoute, CreateComfyUiProviderOptions } from "../src/provider.js";
import { frameCount, imageDimensions, videoDimensions } from "../src/workflow.js";
import type { ComfyUiWorkflowSpec } from "../src/workflow.js";

const image: BlobRef = { kind: "blob", resource: "res_comfyui_1", size: 4, mediaType: "image/png" };
const png = new Uint8Array([137, 80, 78, 71]);
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const constraints = (request: unknown) => request as CanonicalValue;

const routes = createComfyUiRoutes();
const route = (moduleName: string, name: string): ComfyUiRoute =>
  comfyUiRouteForCapability(routes, { module: { name: moduleName, version: "1" }, name })!;

/** The EndpointRegistrar contract is how execution reaches an AsyncEndpoint; capture one capability. */
type AsyncLike = { start(context: unknown): Promise<unknown>; poll(context: unknown): Promise<unknown>; collect(context: unknown): Promise<unknown> };
function registeredEndpoint(options: CreateComfyUiProviderOptions, capabilityName: string): AsyncLike {
  const provider = createComfyUiProvider(options);
  let found: AsyncLike | undefined;
  provider.install({
    registerImmediateEndpoint() { /* this Provider registers none */ },
    registerAsyncEndpoint(_id, capability, _returns, endpoint) {
      if (capability.name === capabilityName) found = endpoint as AsyncLike;
    },
  });
  if (found === undefined) throw new Error(`capability ${capabilityName} was not registered`);
  return found;
}

/** Serve a scripted ComfyUI over one fake fetch; history moves once told to. */
function fakeComfyUi(options: {
  readonly output: { readonly key: "images" | "videos"; readonly filename: string };
  state?: "pending" | "done" | "error";
}) {
  let state = options.state ?? "done";
  const submitted: Array<{ prompt: Record<string, { inputs: Record<string, unknown> }> }> = [];
  const stored = new Map<string, Uint8Array>([[image.resource, png]]);
  let next = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === "POST" && url.pathname === "/upload/image") {
      return Response.json({ name: "hypit-ref.png", subfolder: "" });
    }
    if (init?.method === "POST" && url.pathname === "/prompt") {
      submitted.push(JSON.parse(String(init.body)));
      return Response.json({ prompt_id: "p1", number: 1, node_errors: {} });
    }
    if (url.pathname === "/history/p1") {
      if (state === "pending") return Response.json({});
      if (state === "error") {
        return Response.json({ p1: { outputs: {}, status: { status_str: "error", completed: false,
          messages: [["execution_error", { node_type: "KSampler", node_id: "3", exception_message: "model not found" }]] } } });
      }
      return Response.json({ p1: { outputs: { "9": { [options.output.key]: [
        { filename: options.output.filename, subfolder: "", type: "output" },
      ] } }, status: { status_str: "success", completed: true, messages: [] } } });
    }
    if (url.pathname === "/view") {
      return new Response(options.output.key === "images" ? png : mp4, {
        headers: { "content-type": options.output.key === "images" ? "image/png" : "video/mp4" },
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const resources = {
    get: async (id: string) => stored.get(id),
    put: async (bytes: Uint8Array, mediaType: string) => {
      const resource = `res_out_${++next}`;
      stored.set(resource, bytes);
      return { kind: "blob" as const, resource, size: bytes.byteLength, mediaType };
    },
  };
  return { fetcher, submitted, resources, setState: (next: typeof state) => { state = next; } };
}

function invocationContext(need: unknown, resources: unknown) {
  const checkpoints: unknown[] = [];
  const base = {
    command: { kind: "fulfill-need", id: "cmd_1", need: {} },
    need,
    resources,
    credentials: {},
    checkpoint: async (checkpoint: unknown) => { checkpoints.push(checkpoint); },
  };
  return { base, checkpoints };
}

const imageInstance: CreateComfyUiProviderOptions = { instance: "comfyui.test", pool: "comfyui.test" };

test("every ComfyUI mapping covers its model's ports", () => {
  const tables = { ...wanPorts, "wan-2.2-video": wanVideoPorts["wan-2.2-video"] };
  for (const mapping of comfyUiMappings) {
    assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
  }
});

test("image and video dimensions follow the Wan bands", () => {
  assert.deepEqual(imageDimensions("1K"), { width: 1024, height: 1024 });
  assert.deepEqual(videoDimensions("480p", "16:9"), { width: 832, height: 480 });
  assert.deepEqual(videoDimensions("480p", "9:16"), { width: 480, height: 832 });
  assert.deepEqual(videoDimensions("720p", "1:1"), { width: 960, height: 960 });
  assert.equal(frameCount(5, 16), 80);
});

test("watermark and unconfigured video workflows are refused before submission", () => {
  const marked = route("@hypit/wan", "wan-2.7-image");
  const withWatermark = sealWanRequest("wan-2.7-image", { prompt: ["cat"], watermark: [true] });
  assert.equal(marked.supports({
    capability: marked.capability, returns: marked.returns, constraints: constraints(withWatermark),
  }).status, "unsupported");

  const video = route("@local/wan-video", "wan-2.2-video");
  const verdict = video.supports({
    capability: video.capability, returns: video.returns,
    constraints: constraints(sealWanVideoRequest("wan-2.2-video", { prompt: ["run"] })),
  });
  assert.equal(verdict.status, "unsupported");
  assert.match(verdict.status === "unsupported" ? verdict.reason : "", /no workflow configured/);
});

test("image-set is refused rather than degraded to independent seeds", () => {
  const imageRoute = route("@hypit/wan", "wan-2.7-image");
  const verdict = imageRoute.supports({
    capability: imageRoute.capability, returns: imageRoute.returns,
    constraints: constraints(sealWanRequest("wan-2.7-image", { prompt: ["cat"], imageSet: [true], count: [6] })),
  });
  assert.equal(verdict.status, "unsupported");
  assert.match(verdict.status === "unsupported" ? verdict.reason : "", /storyline/);
});

test("an image request runs the built-in template through submit, poll and collect", async () => {
  const fake = fakeComfyUi({ output: { key: "images", filename: "hypit_00001_.png" } });
  const endpoint = registeredEndpoint({ ...imageInstance, fetch: fake.fetcher }, "wan-2.7-image");
  const request = sealWanRequest("wan-2.7-image", { prompt: ["a red fox"], resolution: ["1K"], seed: [7] });
  const need = { capability: { module: { name: "@hypit/wan", version: "1" }, name: "wan-2.7-image" }, constraints: constraints(request) };
  const { base, checkpoints } = invocationContext(need, fake.resources);

  const started = await endpoint.start({ ...base, operation: "op_1" }) as { status: string; handle: unknown };
  assert.equal(started.status, "pending");
  assert.equal(checkpoints.length, 1);
  const submitted = fake.submitted[0]!;
  assert.equal(submitted.prompt["6"]!.inputs.text, "a red fox");
  assert.equal(submitted.prompt["3"]!.inputs.seed, 7);
  assert.equal(submitted.prompt["5"]!.inputs.width, 1024);

  fake.setState("pending");
  assert.equal((await endpoint.poll({ ...base, operation: "op_1", handle: started.handle }) as { status: string }).status, "pending");
  fake.setState("done");
  assert.equal((await endpoint.poll({ ...base, operation: "op_1", handle: started.handle }) as { status: string }).status, "ready");

  const collected = await endpoint.collect({ ...base, operation: "op_1", handle: started.handle }) as {
    status: string; result: { value: { value: unknown } };
  };
  assert.equal(collected.status, "completed");
  verifyGeneratedImageSet(collected.result.value.value as Parameters<typeof verifyGeneratedImageSet>[0]);
});

test("a video request uploads its keyframe and sets frames from seconds", async () => {
  const fake = fakeComfyUi({ output: { key: "videos", filename: "shot_00001.mp4" } });
  const spec: ComfyUiWorkflowSpec = {
    template: fileURLToPath(new URL("./fixtures/video.json", import.meta.url)),
    nodes: { prompt: "2.text", seed: "3.seed", width: "1.width", height: "1.height", frames: "1.length", firstFrame: "5.image" },
    fps: 16,
  };
  const endpoint = registeredEndpoint({ ...imageInstance, fetch: fake.fetcher, workflows: { "wan-2.2-video": spec } }, "wan-2.2-video");
  const request = sealWanVideoRequest("wan-2.2-video", {
    prompt: ["a fox runs"], firstFrame: [{ role: "image", artifact: image }],
    seconds: [5], resolution: ["480p"], aspectRatio: ["16:9"], seed: [11],
  });
  const need = { capability: { module: { name: "@local/wan-video", version: "1" }, name: "wan-2.2-video" }, constraints: constraints(request) };
  const { base } = invocationContext(need, fake.resources);

  const started = await endpoint.start({ ...base, operation: "op_2" }) as { status: string; handle: unknown };
  assert.equal(started.status, "pending");
  const submitted = fake.submitted[0]!;
  assert.equal(submitted.prompt["2"]!.inputs.text, "a fox runs");
  assert.equal(submitted.prompt["5"]!.inputs.image, "hypit-ref.png");
  assert.equal(submitted.prompt["1"]!.inputs.length, 80);
  assert.equal(submitted.prompt["1"]!.inputs.width, 832);
  assert.equal(submitted.prompt["1"]!.inputs.height, 480);
  assert.equal(submitted.prompt["3"]!.inputs.seed, 11);

  assert.equal((await endpoint.poll({ ...base, operation: "op_2", handle: started.handle }) as { status: string }).status, "ready");
  const collected = await endpoint.collect({ ...base, operation: "op_2", handle: started.handle }) as {
    status: string; result: { value: { value: unknown } };
  };
  assert.equal(collected.status, "completed");
  verifyGeneratedVideoSet(collected.result.value.value as Parameters<typeof verifyGeneratedVideoSet>[0]);
});

test("an execution error in history fails the operation with the node named", async () => {
  const fake = fakeComfyUi({ output: { key: "images", filename: "hypit_00001_.png" }, state: "error" });
  const endpoint = registeredEndpoint({ ...imageInstance, fetch: fake.fetcher }, "wan-2.7-image");
  const request = sealWanRequest("wan-2.7-image", { prompt: ["boom"] });
  const need = { capability: { module: { name: "@hypit/wan", version: "1" }, name: "wan-2.7-image" }, constraints: constraints(request) };
  const { base } = invocationContext(need, fake.resources);
  const started = await endpoint.start({ ...base, operation: "op_3" }) as { handle: unknown };
  const failed = await endpoint.poll({ ...base, operation: "op_3", handle: started.handle }) as {
    status: string; failure: { code: string; message: string };
  };
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.code, "COMFYUI_EXECUTION_ERROR");
  assert.match(failed.failure.message, /KSampler.*model not found/);
});

test("count fans out to several prompts with consecutive seeds", async () => {
  const fake = fakeComfyUi({ output: { key: "images", filename: "hypit_00001_.png" } });
  const endpoint = registeredEndpoint({ ...imageInstance, fetch: fake.fetcher }, "wan-2.7-image");
  const request = sealWanRequest("wan-2.7-image", { prompt: ["cats"], count: [3], seed: [100] });
  const need = { capability: { module: { name: "@hypit/wan", version: "1" }, name: "wan-2.7-image" }, constraints: constraints(request) };
  const { base } = invocationContext(need, fake.resources);
  await endpoint.start({ ...base, operation: "op_4" });
  const seeds = fake.submitted.map((item) => item.prompt["3"]!.inputs.seed);
  assert.deepEqual(seeds, [100, 101, 102]);
});
