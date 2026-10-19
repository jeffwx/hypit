import type { GenerationWireMapping } from "@hypit/generation";

/**
 * ComfyUI is not a catalogue service: each capability routes to one workflow template chosen in the
 * Runtime Profile. The `routes` model string is therefore only diagnostic labelling; the field
 * names below are the internal wire the workflow injector reads (`prompt`, `images`, `seconds`...).
 * Media fields resolve through this Provider's uploader, so their "urls" are ComfyUI
 * `subfolder/name` upload markers, never network addresses.
 */

const WAN = { name: "@hypit/wan", version: "1" } as const;
const WAN_VIDEO = { name: "@local/wan-video", version: "1" } as const;

const imageFields = {
  prompt: { as: "value", field: "prompt" },
  images: { as: "urlArray", field: "images" },
  resolution: { as: "value", field: "resolution" },
  count: { as: "value", field: "count" },
  imageSet: { as: "value", field: "imageSet" },
  extendedReasoning: { as: "value", field: "extendedReasoning" },
  watermark: { as: "value", field: "watermark" },
  seed: { as: "value", field: "seed" },
} as const;

const videoFields = {
  prompt: { as: "value", field: "prompt" },
  firstFrame: { as: "url", field: "firstFrame" },
  lastFrame: { as: "url", field: "lastFrame" },
  seconds: { as: "value", field: "seconds" },
  resolution: { as: "value", field: "resolution" },
  aspectRatio: { as: "value", field: "aspectRatio" },
  seed: { as: "value", field: "seed" },
} as const;

export const comfyUiMappings: readonly GenerationWireMapping[] = [
  {
    capability: { module: WAN, name: "wan-2.7-image" }, result: "image",
    routes: [{ model: "wan-2.7-image" }], fields: imageFields,
  },
  {
    capability: { module: WAN, name: "wan-2.7-image-pro" }, result: "image",
    routes: [{ model: "wan-2.7-image-pro" }], fields: imageFields,
  },
  {
    capability: { module: WAN_VIDEO, name: "wan-2.2-video" }, result: "video",
    routes: [{ model: "wan-2.2-video" }], fields: videoFields,
  },
];
