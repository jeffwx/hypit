import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * A ComfyUI workflow (API-format) graph: node id -> { class_type, inputs }. Node ids are the exact
 * keys of the exported workflow_api.json; every slot reference below is `"<nodeId>.<inputName>"`.
 */
export type WorkflowGraph = Readonly<Record<string, {
  readonly class_type: string;
  readonly inputs: Record<string, unknown>;
}>>;

/** Which workflow inputs receive which generated-request values. */
export type ComfyUiNodeMap = {
  readonly prompt: string;
  readonly negative?: string;
  readonly seed: string;
  readonly width?: string;
  readonly height?: string;
  readonly image?: string;
  readonly firstFrame?: string;
  readonly lastFrame?: string;
  readonly frames?: string;
};

export type ComfyUiWorkflowSpec = {
  /** Path to a workflow_api.json; relative paths resolve against the directory hypit runs in. */
  readonly template: string;
  readonly nodes: ComfyUiNodeMap;
  /** Frames per second of the target workflow, used to turn `seconds` into a frame count. */
  readonly fps?: number;
};

export const defaultVideoFps = 16;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}

export function parseWorkflowGraph(value: unknown, subject: string): WorkflowGraph {
  const graph = object(value, subject);
  for (const [id, node] of Object.entries(graph)) {
    const record = object(node, `${subject} node ${id}`);
    assert(typeof record.class_type === "string" && record.class_type.length > 0,
      `${subject} node ${id} has no class_type`);
    object(record.inputs, `${subject} node ${id} inputs`);
  }
  return graph as WorkflowGraph;
}

const templateCache = new Map<string, WorkflowGraph>();

/** Load and cache one template file. Relative paths resolve against the hypit process directory. */
export async function loadWorkflowTemplate(path: string): Promise<WorkflowGraph> {
  const resolved = isAbsolute(path) ? path : resolve(path);
  const cached = templateCache.get(resolved);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`ComfyUI workflow template is unreadable at ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`ComfyUI workflow template ${resolved} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const graph = parseWorkflowGraph(value, `ComfyUI workflow template ${resolved}`);
  templateCache.set(resolved, graph);
  return graph;
}

export function workflowNodeIds(graph: WorkflowGraph): readonly string[] {
  return Object.keys(graph).sort((left, right) => Number(left) - Number(right));
}

/** Resolve and write one `nodeId.inputName` slot. Returns the written copy, leaving the template intact. */
export function setWorkflowInput(graph: WorkflowGraph, ref: string, value: string | number): WorkflowGraph {
  const separator = ref.indexOf(".");
  assert(separator > 0 && separator < ref.length - 1, `Workflow slot reference ${ref} must be "<nodeId>.<inputName>"`);
  const nodeId = ref.slice(0, separator);
  const inputName = ref.slice(separator + 1);
  const node = graph[nodeId];
  assert(node !== undefined, `Workflow has no node ${nodeId} (available: ${workflowNodeIds(graph).join(", ")})`);
  assert(Object.hasOwn(node.inputs, inputName), `Workflow node ${nodeId} (${node.class_type}) has no input ${inputName}`);
  return { ...graph, [nodeId]: { ...node, inputs: { ...node.inputs, [inputName]: value } } };
}

/** Fail early, naming the node ids the template actually has, when a configured slot is absent. */
export function validateNodeMap(graph: WorkflowGraph, nodes: ComfyUiNodeMap, subject: string): void {
  const available = `available node ids: ${workflowNodeIds(graph).join(", ")}`;
  const refs = [
    nodes.prompt, nodes.seed, nodes.negative, nodes.width, nodes.height,
    nodes.image, nodes.firstFrame, nodes.lastFrame, nodes.frames,
  ];
  for (const ref of refs) {
    if (ref === undefined) continue;
    const separator = ref.indexOf(".");
    assert(separator > 0, `${subject} slot ${ref} must be "<nodeId>.<inputName>"`);
    const node = graph[ref.slice(0, separator)];
    assert(node !== undefined, `${subject} references missing node ${ref.slice(0, separator)}; ${available}`);
    assert(Object.hasOwn(node.inputs, ref.slice(separator + 1)),
      `${subject} references ${ref} but node ${ref.slice(0, separator)} (${node.class_type}) has no such input`);
  }
}

const IMAGE_BANDS: Readonly<Record<string, number>> = { "1K": 1024, "2K": 1536, "4K": 2048 };

/** Wan image bands render square when no reference image drives the shape. */
export function imageDimensions(band: string): { readonly width: number; readonly height: number } {
  const side = IMAGE_BANDS[band];
  if (side === undefined) throw new Error(`Unknown image resolution band ${band}`);
  return { width: side, height: side };
}

/** The dimension pairs Wan workflows conventionally use per band and aspect. */
const VIDEO_DIMENSIONS: Readonly<Record<string, Readonly<Record<string, { width: number; height: number }>>>> = {
  "480p": { "16:9": { width: 832, height: 480 }, "9:16": { width: 480, height: 832 }, "1:1": { width: 608, height: 608 } },
  "720p": { "16:9": { width: 1280, height: 720 }, "9:16": { width: 720, height: 1280 }, "1:1": { width: 960, height: 960 } },
  "1080p": { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1440, height: 1440 } },
};

export function videoDimensions(band: string, aspect: string): { readonly width: number; readonly height: number } {
  const size = VIDEO_DIMENSIONS[band]?.[aspect];
  if (size === undefined) {
    throw new Error(`Unknown video resolution band ${band} or aspect ${aspect}`);
  }
  return size;
}

export function frameCount(seconds: number, fps: number): number {
  assert(Number.isSafeInteger(fps) && fps > 0, "Video fps must be a positive integer");
  return Math.max(1, Math.round(seconds * fps));
}
