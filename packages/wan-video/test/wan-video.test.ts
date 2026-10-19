import assert from "node:assert/strict";
import test from "node:test";
import { assertGenerationPortTable, verifyRequestAgainstPorts } from "@hypit/generation";

import { sealWanVideoRequest, wanVideoPorts } from "../src/index.js";
import { wanVideoModuleRef, wanVideoModels } from "../src/index.js";

test("the wan-video port table is well-formed", () => {
  assertGenerationPortTable(wanVideoPorts["wan-2.2-video"]);
});

test("a complete request validates against the port table", () => {
  const request = sealWanVideoRequest("wan-2.2-video", {
    prompt: ["a fox runs across snow"],
    seconds: [5], resolution: ["480p"], aspectRatio: ["16:9"], seed: [42],
  });
  verifyRequestAgainstPorts(wanVideoPorts["wan-2.2-video"], request);
});

test("seconds beyond the model's ceiling are rejected at seal time", () => {
  assert.throws(() => sealWanVideoRequest("wan-2.2-video", { prompt: ["run"], seconds: [30] }));
  assert.throws(() => sealWanVideoRequest("wan-2.2-video", { prompt: ["run"], resolution: ["4K"] }));
});

test("module identity matches what the ComfyUI Provider maps", () => {
  assert.equal(wanVideoModuleRef.name, "@local/wan-video");
  assert.deepEqual([...wanVideoModels], ["wan-2.2-video"]);
});
