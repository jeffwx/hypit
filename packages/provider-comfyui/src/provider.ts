import { fileURLToPath } from "node:url";
import type { AsyncEndpoint, EndpointActionLimits, EndpointOutcome, EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { EndpointServiceError, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import { EndpointHttpError, EndpointResponseError, EndpointTransportError, withRequestDeadline } from "@hypit/hypit/endpoint/http";
import type { GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { compileWireRequest, generationTypes, mappingSupportsRequest, sealGeneratedImageSet, sealGeneratedVideoSet, selectWireModelForRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CanonicalValue, CapabilityRef, StoredValue, TypeRef } from "@hypit/hypit/protocol";
import { comfyUiMappings } from "./mapping.js";
import { ComfyUiHttpError, ComfyUiServiceError, comfyUiExecutionFailure } from "./errors.js";
import {
  defaultVideoFps, frameCount, imageDimensions, loadWorkflowTemplate, setWorkflowInput,
  validateNodeMap, videoDimensions,
} from "./workflow.js";
import type { ComfyUiNodeMap, ComfyUiWorkflowSpec, WorkflowGraph } from "./workflow.js";

export const comfyUiProviderModuleRef = { name: "@local/provider-comfyui", version: "1" } as const;

/**
 * The bundled image template uses only core ComfyUI nodes, so a stock install can serve the image
 * capabilities before any workflow is configured. Its checkpoint name still has to match a model
 * the instance actually has; the README shows where to change it.
 */
const builtinImageNodes: ComfyUiNodeMap = {
  prompt: "6.text", negative: "7.text", seed: "3.seed", width: "5.width", height: "5.height",
};
const builtinImageSpec: ComfyUiWorkflowSpec = {
  template: fileURLToPath(new URL("../workflows/default-image.json", import.meta.url)),
  nodes: builtinImageNodes,
};

export type CreateComfyUiProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly baseUrl?: string;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  /** Workflow template per capability name; capabilities without an entry fall back as documented. */
  readonly workflows?: Readonly<Record<string, ComfyUiWorkflowSpec>>;
  readonly fetch?: typeof globalThis.fetch;
};

type Handle = {
  readonly contract: "hypit.comfyui-operation@1";
  readonly promptIds: readonly string[];
  readonly route: string;
  readonly startedAt: number;
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, subject: string): string {
  assert(typeof value === "string" && value.length > 0, `${subject} must be nonempty text`);
  return value;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(error: unknown): EndpointOutcome {
  if (!(error instanceof EndpointServiceError || error instanceof EndpointHttpError
    || error instanceof EndpointTransportError || error instanceof EndpointResponseError)) throw error;
  const code = error instanceof EndpointServiceError || error instanceof EndpointHttpError ? error.code : "COMFYUI_ERROR";
  return { status: "failed", failure: { code, message: failureMessage(error) } };
}
function retrying(error: unknown, handle: CanonicalValue, pollIntervalMs: number, deadlineAt?: number): EndpointOutcome | undefined {
  const delay = error instanceof EndpointTransportError ? pollIntervalMs
    : error instanceof EndpointHttpError && (error.status === 429 || error.status >= 500)
      ? error.retryAfterMs ?? pollIntervalMs : undefined;
  if (delay === undefined) return undefined;
  const now = Date.now();
  return { status: "pending", handle, wakeAt: Math.min(now + delay, deadlineAt ?? Number.MAX_SAFE_INTEGER), progress: { phase: "retrying" } };
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
};
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
};

class ComfyUiClient {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}

  async json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(`${this.baseUrl}${path}`, { ...init, signal }));
      const body = await wait(response.text());
      if (!response.ok) throw new ComfyUiHttpError(response.status, response, body, { method: init.method ?? "GET", path });
      if (body.trim().length === 0) return {};
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new EndpointResponseError(`ComfyUI returned invalid JSON from ${path}`); }
      return object(value, "ComfyUI response");
    }, () => new EndpointTransportError(`ComfyUI request to ${path} timed out`, { timeout: true }));
  }

  /** Upload one reference image; the returned `subfolder/name` marker addresses it in a LoadImage node. */
  async uploadImage(artifact: BlobRef, bytes: Uint8Array): Promise<string> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const mediaType = artifact.mediaType.split(";", 1)[0] ?? "image/png";
      const extension = IMAGE_EXTENSIONS[mediaType] ?? ".png";
      const form = new FormData();
      form.append("image", new Blob([bytes as unknown as BlobPart], { type: mediaType }), `${artifact.resource}${extension}`);
      form.append("overwrite", "true");
      const response = await wait(this.fetcher(`${this.baseUrl}/upload/image`, { method: "POST", body: form, signal }));
      const body = await wait(response.text());
      if (!response.ok) throw new ComfyUiHttpError(response.status, response, body, { method: "POST", path: "/upload/image" });
      const uploaded = object(JSON.parse(body), "ComfyUI upload response");
      const name = text(uploaded.name, "ComfyUI upload name");
      const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
      return subfolder.length === 0 ? name : `${subfolder}/${name}`;
    }, () => new EndpointTransportError("ComfyUI image upload timed out", { timeout: true }));
  }

  async download(path: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(`${this.baseUrl}${path}`, { signal }));
      if (!response.ok) throw new ComfyUiHttpError(response.status, response, "", { method: "GET", path });
      const bytes = new Uint8Array(await wait(response.arrayBuffer()));
      // The output's own filename is the most reliable type evidence; /view carries no usable suffix.
      const filename = new URL(path, this.baseUrl).searchParams.get("filename") ?? "";
      const dot = filename.lastIndexOf(".");
      const declared = dot === -1 ? undefined : MEDIA_TYPES[filename.slice(dot).toLowerCase()];
      const mediaType = declared ?? response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
      return { bytes, mediaType };
    }, () => new EndpointTransportError("ComfyUI download timed out", { timeout: true }));
  }
}

export type ComfyUiRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly spec: () => ComfyUiWorkflowSpec | undefined;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}
function itemCount(request: GenerationRequest, port: string): number {
  return request.ports[port]?.length ?? 0;
}

/**
 * What this Endpoint can honestly run, decided from the Profile's workflow configuration alone.
 * The template file itself is validated at submission, where its evidence is available.
 */
function rejection(route: Omit<ComfyUiRoute, "supports">, request: GenerationRequest): string | undefined {
  const name = route.capability.name;
  const spec = route.spec();
  if (spec === undefined) {
    return `ComfyUI has no workflow configured for ${name}; set workflows["${name}"] in this Endpoint's Profile`;
  }
  if (scalar(request, "watermark") === true) {
    return `ComfyUI workflows render unmarked media; ${name} cannot apply watermark=true`;
  }
  if (route.result === "image") {
    if (scalar(request, "extendedReasoning") === true) {
      return `ComfyUI has no extended-reasoning mode for ${name}`;
    }
    if (itemCount(request, "images") > 0 && spec.nodes.image === undefined) {
      return `This ComfyUI image workflow takes no reference images; configure an image node for ${name}`;
    }
    if (itemCount(request, "images") > 1) {
      return `This ComfyUI image workflow accepts one reference image, not ${itemCount(request, "images")}`;
    }
    if (scalar(request, "resolution") !== undefined && (spec.nodes.width === undefined || spec.nodes.height === undefined)) {
      return `This ComfyUI image workflow has no width/height slots for a ${String(scalar(request, "resolution"))} band`;
    }
  } else {
    if (itemCount(request, "firstFrame") > 0 && spec.nodes.firstFrame === undefined) {
      return `This ComfyUI video workflow has no first-frame slot; configure one for ${name}`;
    }
    if (itemCount(request, "lastFrame") > 0 && spec.nodes.lastFrame === undefined) {
      return `This ComfyUI video workflow has no last-frame slot; configure one for ${name}`;
    }
    if (scalar(request, "seconds") !== undefined && spec.nodes.frames === undefined) {
      return `This ComfyUI video workflow has a fixed length; configure a frames slot for ${name} to state seconds`;
    }
    const resolution = scalar(request, "resolution");
    const aspect = scalar(request, "aspectRatio");
    if (aspect !== undefined && resolution === undefined) {
      return `State resolution together with aspect-ratio for ${name}`;
    }
    if (resolution !== undefined && (spec.nodes.width === undefined || spec.nodes.height === undefined)) {
      return `This ComfyUI video workflow has no width/height slots for a ${String(resolution)} band`;
    }
  }
  return undefined;
}

export function createComfyUiRoutes(workflows: Readonly<Record<string, ComfyUiWorkflowSpec>> = {}): readonly ComfyUiRoute[] {
  return comfyUiMappings.map((mapping) => {
    const base: Omit<ComfyUiRoute, "supports"> = {
      ...mapping,
      key: capabilityKey(mapping.capability),
      returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
      spec: () => workflows[mapping.capability.name] ?? (mapping.result === "image" ? builtinImageSpec : undefined),
    };
    const supports = (request: EndpointRequest): EndpointSupport => {
      const reason = rejection(base, request.constraints as unknown as GenerationRequest);
      if (reason !== undefined) return { status: "unsupported", reason };
      return mappingSupportsRequest(mapping, request.constraints)
        ? { status: "supported" }
        : { status: "unsupported", reason: `This Endpoint does not accept one of the requested ${mapping.capability.name} inputs` };
    };
    return { ...base, supports };
  });
}

const byCapability = (routes: readonly ComfyUiRoute[]) => new Map(routes.map((route) => [route.key, route]));
export function comfyUiRouteForCapability(routes: readonly ComfyUiRoute[], capability: CapabilityRef): ComfyUiRoute | undefined {
  return byCapability(routes).get(capabilityKey(capability));
}

type PreparedWorkflow = {
  readonly graphs: readonly WorkflowGraph[];
  readonly spec: ComfyUiWorkflowSpec;
};

/** Turn the compiled wire input into submitted graphs: shared values first, then per-copy seeds. */
function buildGraphs(route: ComfyUiRoute, spec: ComfyUiWorkflowSpec, template: WorkflowGraph, input: Record<string, unknown>): PreparedWorkflow {
  validateNodeMap(template, spec.nodes, `ComfyUI workflow for ${route.capability.name}`);
  const nodes = spec.nodes;
  let shared = template;
  shared = setWorkflowInput(shared, nodes.prompt, text(input.prompt, "ComfyUI prompt"));
  if (route.result === "image") {
    const reference = strings(input.images)[0];
    if (reference !== undefined && nodes.image !== undefined) shared = setWorkflowInput(shared, nodes.image, reference);
    const band = input.resolution;
    if (typeof band === "string" && nodes.width !== undefined && nodes.height !== undefined) {
      const size = imageDimensions(band);
      shared = setWorkflowInput(shared, nodes.width, size.width);
      shared = setWorkflowInput(shared, nodes.height, size.height);
    }
  } else {
    const first = typeof input.firstFrame === "string" ? input.firstFrame : undefined;
    const last = typeof input.lastFrame === "string" ? input.lastFrame : undefined;
    if (first !== undefined && nodes.firstFrame !== undefined) shared = setWorkflowInput(shared, nodes.firstFrame, first);
    if (last !== undefined && nodes.lastFrame !== undefined) shared = setWorkflowInput(shared, nodes.lastFrame, last);
    const band = typeof input.resolution === "string" ? input.resolution : undefined;
    const aspect = typeof input.aspectRatio === "string" ? input.aspectRatio : "16:9";
    if (band !== undefined && nodes.width !== undefined && nodes.height !== undefined) {
      const size = videoDimensions(band, aspect);
      shared = setWorkflowInput(shared, nodes.width, size.width);
      shared = setWorkflowInput(shared, nodes.height, size.height);
    }
    const seconds = input.seconds;
    if (typeof seconds === "number" && nodes.frames !== undefined) {
      shared = setWorkflowInput(shared, nodes.frames, frameCount(seconds, spec.fps ?? defaultVideoFps));
    }
  }
  const count = typeof input.count === "number" ? Math.min(Math.max(Math.trunc(input.count), 1), 12) : 1;
  const baseSeed = typeof input.seed === "number" ? Math.trunc(input.seed) : Math.floor(Math.random() * 2_147_483_647);
  const graphs = Array.from({ length: count }, (_, index) =>
    setWorkflowInput(shared, nodes.seed, (baseSeed + index) % 2_147_483_648));
  return { graphs, spec };
}

function endpoint(client: ComfyUiClient, routes: readonly ComfyUiRoute[], pollIntervalMs: number, maxOperationMs: number): AsyncEndpoint {
  const routeFor = (capability: CapabilityRef): ComfyUiRoute => {
    const route = comfyUiRouteForCapability(routes, capability);
    assert(route !== undefined, "ComfyUI does not implement this exact capability");
    return route;
  };
  return {
    async start(context) {
      try {
        const route = routeFor(context.need.capability);
        const request = context.need.constraints as unknown as GenerationRequest;
        const verdict = route.supports({
          capability: context.need.capability, returns: context.need.returns, constraints: context.need.constraints,
        });
        assert(verdict.status === "supported", verdict.status === "unsupported" ? verdict.reason : "unsupported");
        const spec = route.spec();
        assert(spec !== undefined, `ComfyUI has no workflow configured for ${route.capability.name}`);
        const template = await loadWorkflowTemplate(spec.template);
        await context.reportProgress?.({ phase: `Preparing ComfyUI workflow: ${selectWireModelForRequest(route, request)}` });
        const uploads = new Map<string, Promise<string>>();
        const input = (await compileWireRequest(route, request, (artifact) => {
          const existing = uploads.get(artifact.resource);
          if (existing !== undefined) return existing;
          const promise = (async () => {
            const bytes = await context.resources.get(artifact.resource);
            assert(bytes !== undefined && bytes.byteLength === artifact.size, `Reference image ${artifact.resource} is unavailable`);
            return await client.uploadImage(artifact, new Uint8Array(bytes));
          })();
          uploads.set(artifact.resource, promise);
          return promise;
        })).input as Record<string, unknown>;
        const prepared = buildGraphs(route, spec, template, input);
        const promptIds: string[] = [];
        for (const graph of prepared.graphs) {
          await context.reportProgress?.({ phase: promptIds.length === 0 ? "Submitting ComfyUI prompt" : `Submitting ComfyUI prompt ${promptIds.length + 1}` });
          const response = await client.json("/prompt", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: graph, client_id: context.operation }),
          });
          const id = text(response.prompt_id, "ComfyUI prompt_id");
          const errors = object(response.node_errors ?? {}, "ComfyUI node_errors");
          assert(Object.keys(errors).length === 0, `ComfyUI rejected workflow nodes: ${Object.keys(errors).join(", ")}`);
          promptIds.push(id);
        }
        const handle: Handle = { contract: "hypit.comfyui-operation@1", promptIds, route: route.key, startedAt: Date.now() };
        const receipt = { id: promptIds[0] ?? "" };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "queued" }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async poll(context) {
      let operationDeadlineAt: number | undefined;
      try {
        const handle = object(context.handle, "ComfyUI handle") as unknown as Handle;
        const route = routeFor(context.need.capability);
        assert(handle.contract === "hypit.comfyui-operation@1" && handle.route === route.key, "ComfyUI handle is invalid");
        const receipt = { id: handle.promptIds[0] ?? "" };
        operationDeadlineAt = handle.startedAt + maxOperationMs;
        if (Date.now() >= operationDeadlineAt) {
          return { status: "failed", receipt, failure: { code: "COMFYUI_OPERATION_TIMEOUT", message: `ComfyUI prompts ${handle.promptIds.join(", ")} exceeded this Provider's operationTimeoutMs (${maxOperationMs}); remote outcome is unknown` } };
        }
        let finished = 0;
        for (const promptId of handle.promptIds) {
          const history = await client.json(`/history/${encodeURIComponent(promptId)}`);
          const entry = object(history[promptId] ?? {}, `ComfyUI history ${promptId}`);
          if (Object.keys(entry).length === 0) continue;
          const status = object(entry.status ?? {}, `ComfyUI history ${promptId} status`);
          const rejected = comfyUiExecutionFailure(status, promptId);
          if (rejected !== undefined) return { ...failure(rejected), receipt };
          if (status.completed === true) finished += 1;
        }
        if (finished < handle.promptIds.length) {
          return { ...wakeAfter(context.handle, pollIntervalMs, Date.now(), { phase: `${finished}/${handle.promptIds.length} prompts finished` }), receipt };
        }
        return { status: "ready", handle: context.handle, receipt };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs, operationDeadlineAt) ?? failure(error);
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "ComfyUI handle") as unknown as Handle;
        const route = routeFor(context.need.capability);
        assert(handle.contract === "hypit.comfyui-operation@1" && handle.route === route.key, "ComfyUI collection route differs");
        await context.reportProgress?.({ phase: "Receiving generated media" });
        const artifacts: BlobRef[] = [];
        for (const promptId of handle.promptIds) {
          const history = await client.json(`/history/${encodeURIComponent(promptId)}`);
          const entry = object(history[promptId] ?? {}, `ComfyUI history ${promptId}`);
          const outputs = object(entry.outputs ?? {}, `ComfyUI history ${promptId} outputs`);
          for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
            const files = object(nodeOutput, `ComfyUI output ${nodeId}`);
            for (const key of ["images", "gifs", "videos", "video"]) {
              const list = files[key];
              if (!Array.isArray(list)) continue;
              for (const item of list) {
                const file = object(item, `ComfyUI output ${nodeId} ${key} entry`);
                if (file.type !== undefined && file.type !== "output") continue;
                const filename = text(file.filename, `ComfyUI output ${nodeId} filename`);
                const subfolder = typeof file.subfolder === "string" ? file.subfolder : "";
                const path = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
                const downloaded = await client.download(path);
                artifacts.push(await context.resources.put(downloaded.bytes, downloaded.mediaType));
              }
            }
          }
        }
        assert(artifacts.length > 0, `ComfyUI produced no output files for prompts ${handle.promptIds.join(", ")}`);
        return {
          status: "completed",
          result: { value: {
            kind: "inline",
            value: canonicalize(route.result === "image"
              ? sealGeneratedImageSet({ images: artifacts })
              : sealGeneratedVideoSet({ videos: artifacts })),
          } },
          receipt: { id: handle.promptIds[0] ?? "" },
        };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs) ?? failure(error);
      }
    },
  };
}

export function createComfyUiProvider(options: CreateComfyUiProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 2 * 60 * 60_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, operationTimeoutMs })) {
    assert(Number.isSafeInteger(value) && value > 0, `ComfyUI ${name} must be a positive integer`);
  }
  let base = (options.baseUrl ?? "http://127.0.0.1:8188").trim();
  while (base.endsWith("/")) base = base.slice(0, -1);
  assert(base.length > 0, "ComfyUI base URL is empty");
  const client = new ComfyUiClient(base, requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const routes = createComfyUiRoutes(options.workflows);
  const asyncEndpoint = endpoint(client, routes, options.pollIntervalMs ?? 3_000, operationTimeoutMs);
  return defineEndpoint({
    instance: options.instance ?? "comfyui.default", pool: options.pool ?? options.instance ?? "comfyui.default",
    // Generation runs on the operator's own machine or rental; there is no Provider charge to read.
    pricing: { kind: "local" },
    defaultConcurrency: options.defaultConcurrency ?? 1,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: routes.map((route) => ({
      capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const,
      endpoint: asyncEndpoint, capacity: route.capability.name, supports: route.supports,
    })),
  });
}
