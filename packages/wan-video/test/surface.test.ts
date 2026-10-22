import assert from "node:assert/strict";
import test from "node:test";

import { blobTypes } from "@hypit/blob";
import { parseStructuredElement } from "@hypit/markup";
import type { SurfaceResolvedReference } from "@hypit/hypit/markup";
import { textTypes } from "@hypit/text";

import { wanVideoEndpoints, wanVideoMarkupSurfaces } from "../src/index.js";
import { decodeWanVideoSurface } from "../src/surface.js";

const refs = new Map<string, SurfaceResolvedReference>([
  ["direction", {
    path: "direction",
    ref: { kind: "component-output", component: "assembled-direction", output: "text" },
    type: textTypes.text,
  }],
  ...["first.image", "last.image"].map((path) => [path, {
    path,
    ref: { kind: "component-output" as const, component: path.split(".")[0]!, output: path.split(".")[1]! },
    type: blobTypes.blob,
  }] as const),
]);

async function decode(source: string) {
  const element = parseStructuredElement({ name: "wan-video.svml", text: source }, 0).element;
  return await decodeWanVideoSurface({
    sourceName: "wan-video.svml",
    element,
    resolveReference: (path) => refs.get(path),
    resolveAsset: () => { throw new Error("no asset"); },
  });
}

test("Video decodes with both keyframes and publishes both binding records", async () => {
  const result = await decode(
    '<wanVideo:Video id="shot" prompt={direction} seconds="5" resolution="480p" aspect-ratio="16:9" seed="7">'
    + "<wanVideo:FirstFrame image={first.image}/><wanVideo:LastFrame image={last.image}/></wanVideo:Video>",
  );
  assert.deepEqual(result.records.map((record) => record.id).sort(),
    ["shot.draft", "shot.firstFrame.binding", "shot.lastFrame.binding"].sort());
  const component = result.components[0]!;
  assert.equal(component.outputs.video, "shot.video");
  assert.deepEqual(component.inputs["draft"], { kind: "record", id: "shot.draft" });
  const artifactInputs = Object.entries(component.inputs)
    .filter(([, value]) => JSON.stringify(value).includes("component-output"))
    .map(([name]) => name);
  assert.equal(artifactInputs.length, 3, "prompt plus two keyframe artifacts");
});

test("a non-image keyframe artifact is rejected at decode", async () => {
  const admitted = new Map(refs);
  admitted.set("last.image", {
    ...refs.get("last.image")!,
    record: {
      id: "last", type: blobTypes.blob,
      value: { kind: "blob", resource: "res_video_1", size: 8, mediaType: "video/mp4" },
    },
  });
  const element = parseStructuredElement({
    name: "wan-video.svml",
    text: '<wanVideo:Video id="shot" prompt={direction}><wanVideo:LastFrame image={last.image}/></wanVideo:Video>',
  }, 0).element;
  await assert.rejects(async () => decodeWanVideoSurface({
    sourceName: "wan-video.svml",
    element,
    resolveReference: (path) => admitted.get(path),
    resolveAsset: () => { throw new Error("no asset"); },
  }), /must reference an image Artifact/);
});

test("the Surface outputs declaration covers both keyframe binding types", () => {
  const outputs = wanVideoMarkupSurfaces[0]!.outputs;
  assert.ok(outputs.includes(wanVideoEndpoints.video!.mediaBindings.firstFrame!.type));
  assert.ok(outputs.includes(wanVideoEndpoints.video!.mediaBindings.lastFrame!.type));
});
