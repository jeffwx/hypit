import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigActionLimits,
  runtimeConfigBoolean,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-local/extension";
import type { CanonicalValue } from "@hypit/protocol";

import { createComfyUiProvider } from "./provider.js";
import type { ComfyUiNodeMap, ComfyUiWorkflowSpec } from "./workflow.js";

const NODE_SLOTS = ["prompt", "negative", "seed", "width", "height", "image", "firstFrame", "lastFrame", "frames"] as const;

function workflowSpec(value: CanonicalValue, name: string): ComfyUiWorkflowSpec {
  const spec = runtimeConfigObject(value, `ComfyUI workflows["${name}"]`);
  const template = runtimeConfigString(spec.template, `ComfyUI workflows["${name}"].template`);
  if (template === undefined) throw new Error(`ComfyUI workflows["${name}"].template (path to a workflow_api.json) is required`);
  if (spec.nodes === undefined) throw new Error(`ComfyUI workflows["${name}"].nodes is required`);
  const nodesValue = runtimeConfigObject(spec.nodes, `ComfyUI workflows["${name}"].nodes`);
  const nodes: Record<string, string> = {};
  for (const slot of NODE_SLOTS) {
    const ref = runtimeConfigString(nodesValue[slot], `ComfyUI workflows["${name}"].nodes.${slot}`);
    if (ref !== undefined) nodes[slot] = ref;
  }
  if (nodes.prompt === undefined || nodes.seed === undefined) {
    throw new Error(`ComfyUI workflows["${name}"].nodes requires at least prompt and seed slots ("<nodeId>.<inputName>")`);
  }
  const fps = runtimeConfigPositiveInteger(spec.fps, `ComfyUI workflows["${name}"].fps`);
  return { template, nodes: nodes as unknown as ComfyUiNodeMap, ...(fps === undefined ? {} : { fps }) };
}

function workflowSpecs(value: CanonicalValue | undefined): Readonly<Record<string, ComfyUiWorkflowSpec>> {
  if (value === undefined) return {};
  const workflows = runtimeConfigObject(value, "ComfyUI workflows");
  const result: Record<string, ComfyUiWorkflowSpec> = {};
  for (const name of Object.keys(workflows)) result[name] = workflowSpec(workflows[name]!, name);
  return result;
}

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@local/provider-comfyui",
  activate(context) {
    if (context.pool === undefined) throw new Error("ComfyUI Provider Pool is required");
    const config = runtimeConfigObject(context.config, "ComfyUI")!;
    runtimeConfigExact(config, [
      "baseUrl",
      "allowHttp",
      "defaultConcurrency",
      "actionLimits",
      "pollIntervalMs",
      "requestTimeoutMs",
      "operationTimeoutMs",
      "workflows",
    ], "ComfyUI");
    const baseUrl = runtimeConfigString(config.baseUrl, "ComfyUI baseUrl");
    if (baseUrl !== undefined) {
      const url = new URL(baseUrl);
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !loopback) {
        const allowed = runtimeConfigBoolean(config.allowHttp, "ComfyUI allowHttp");
        if (allowed !== true) {
          throw new Error("ComfyUI baseUrl must use HTTPS or loopback HTTP; set allowHttp=true to reach a plain-HTTP instance");
        }
      }
    }
    const workflows = workflowSpecs(config.workflows);
    return {
      endpoint: createComfyUiProvider({
        instance: context.instance,
        pool: context.pool,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(runtimeConfigPositiveInteger(config.defaultConcurrency, "ComfyUI defaultConcurrency") === undefined
          ? {} : { defaultConcurrency: runtimeConfigPositiveInteger(config.defaultConcurrency, "ComfyUI defaultConcurrency")! }),
        ...(runtimeConfigActionLimits(config.actionLimits) === undefined
          ? {} : { actionLimits: runtimeConfigActionLimits(config.actionLimits)! }),
        ...(runtimeConfigPositiveInteger(config.pollIntervalMs, "ComfyUI pollIntervalMs") === undefined
          ? {} : { pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "ComfyUI pollIntervalMs")! }),
        ...(runtimeConfigPositiveInteger(config.requestTimeoutMs, "ComfyUI requestTimeoutMs") === undefined
          ? {} : { requestTimeoutMs: runtimeConfigPositiveInteger(config.requestTimeoutMs, "ComfyUI requestTimeoutMs")! }),
        ...(runtimeConfigPositiveInteger(config.operationTimeoutMs, "ComfyUI operationTimeoutMs") === undefined
          ? {} : { operationTimeoutMs: runtimeConfigPositiveInteger(config.operationTimeoutMs, "ComfyUI operationTimeoutMs")! }),
        workflows,
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [adapter],
};

export default hypitPackage;
