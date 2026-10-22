import { blobTypes } from "@hypit/hypit/blob";
import { sealGenerationPortRequest, sealGenerationPortTable } from "@hypit/generation";
import type { GenerationPortTable, GenerationPortValue, GenerationRequest } from "@hypit/generation";
import type { SurfaceAttributeVocabulary, SurfaceChildVocabulary } from "@hypit/hypit/markup";
import { defineExactModelModule } from "@hypit/generation/model";
import { textTypes } from "@hypit/hypit/text";

/**
 * An exact-model package for self-hosted Wan-style video generation. The capability name is the
 * authoring vocabulary; which checkpoint and workflow actually render it belongs to the serving
 * Provider (see @local/provider-comfyui), exactly as hosted models name a catalogue entry.
 */
export const wanVideoModuleRef = { name: "@local/wan-video", version: "1" } as const;
export const wanVideoModels = ["wan-2.2-video"] as const;
export type WanVideoModel = typeof wanVideoModels[number];

const WAN_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const WAN_VIDEO_ASPECTS = ["16:9", "9:16", "1:1"] as const;

function wanVideoPortTable(model: WanVideoModel): GenerationPortTable {
  return sealGenerationPortTable({
    model,
    result: "video",
    ports: [
      { name: "prompt", value: { kind: "text", maxChars: 5_000 }, minItems: 1, maxItems: 1 },
      // First and last keyframes are separate ports because a workflow wires them to separate nodes.
      { name: "firstFrame", value: { kind: "media", accepts: ["image"] }, minItems: 0, maxItems: 1 },
      { name: "lastFrame", value: { kind: "media", accepts: ["image"] }, minItems: 0, maxItems: 1 },
      { name: "seconds", value: { kind: "number", integer: true, minimum: 1, maximum: 20 }, minItems: 0, maxItems: 1 },
      { name: "resolution", value: { kind: "enum", values: [...WAN_VIDEO_RESOLUTIONS] }, minItems: 0, maxItems: 1 },
      { name: "aspectRatio", value: { kind: "enum", values: [...WAN_VIDEO_ASPECTS] }, minItems: 0, maxItems: 1 },
      { name: "seed", value: { kind: "number", integer: true, minimum: 0, maximum: 2_147_483_647 }, minItems: 0, maxItems: 1 },
    ],
    requires: [
      { kind: "requiresPresent", port: "aspectRatio", needs: ["resolution"] },
      { kind: "requiresPresent", port: "resolution", needs: ["aspectRatio"] },
    ],
  });
}

export const wanVideoPorts: Readonly<Record<WanVideoModel, GenerationPortTable>> = {
  "wan-2.2-video": wanVideoPortTable("wan-2.2-video"),
};

export function sealWanVideoRequest(
  model: WanVideoModel,
  ports: Readonly<Record<string, readonly GenerationPortValue[]>>,
): GenerationRequest {
  return sealGenerationPortRequest(wanVideoPorts[model], ports);
}

const base = defineExactModelModule({
  module: wanVideoModuleRef,
  endpoints: [{
    key: "video",
    requestTypeName: "WanVideoRequest",
    producerName: "request-wan-2.2-video",
    ports: wanVideoPorts["wan-2.2-video"],
  }],
});

export const wanVideoEndpoints = base.endpoints;
export const wanVideoComponent = base.component;

const attributes: readonly SurfaceAttributeVocabulary[] = [
  { name: "id", kind: "identifier", required: true,
    summary: "Names this generation and prefixes the bindings it publishes." },
  { name: "prompt", kind: "reference", required: true, accepts: [textTypes.text],
    summary: "The Text edge describing the shot: subject, action, camera and style." },
  { name: "seconds", kind: "literal", required: false,
    summary: "Target duration in whole seconds; the serving workflow's fps sets the frame count." },
  { name: "resolution", kind: "literal", required: false, values: [...WAN_VIDEO_RESOLUTIONS],
    summary: "The resolution band the shot renders at; state it together with aspect-ratio." },
  { name: "aspect-ratio", kind: "literal", required: false, values: [...WAN_VIDEO_ASPECTS],
    summary: "Frame aspect; state it together with resolution." },
  { name: "seed", kind: "literal", required: false,
    summary: "Seeds sampling so a rerun stays close to this one." },
];

const children: readonly SurfaceChildVocabulary[] = [
  { tag: "FirstFrame", cardinality: "optional",
    summary: "One image Artifact the shot opens on.",
    attributes: [
      { name: "image", kind: "reference", required: true, accepts: [blobTypes.blob],
        summary: "Selects the image Artifact this keyframe contributes." },
    ] },
  { tag: "LastFrame", cardinality: "optional",
    summary: "One image Artifact the shot ends on.",
    attributes: [
      { name: "image", kind: "reference", required: true, accepts: [blobTypes.blob],
        summary: "Selects the image Artifact this keyframe contributes." },
    ] },
];

export const wanVideoMarkupSurfaces = [{
  name: "video",
  tag: "Video",
  mode: "structured" as const,
  outputs: [
    wanVideoEndpoints.video!.draftType,
    wanVideoEndpoints.video!.mediaBindings.firstFrame!.type,
    wanVideoEndpoints.video!.mediaBindings.lastFrame!.type,
  ],
  vocabulary: {
    summary: "Generates one video shot with a self-hosted Wan-style model from a Text prompt and optional first/last keyframes.",
    attributes,
    children,
    ports: [{
      name: "video",
      type: blobTypes.blob,
      summary: "The primary generated video, addressed as `<id>.video`.",
    }],
    example: `<wanVideo:Video
  id="shot"
  prompt={shotPrompt}
  seconds="5"
  resolution="720p"
  aspect-ratio="16:9"
>
  <wanVideo:FirstFrame image={draft.image}/>
</wanVideo:Video>`,
    notes: [
      "The element accepts at most one FirstFrame and one LastFrame child and no text content.",
      "The Surface lowers the element into the package's exact model request and selects no Provider; a Runtime Profile binding routes it to a serving Endpoint.",
    ],
  },
}] as const;

export const wanVideoManifest = { ...base.manifest };
export const wanVideoDefinition = { ...base, manifest: wanVideoManifest };
