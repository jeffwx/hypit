# @local/provider-comfyui

A Hypit Provider that serves image and video generation capabilities from any [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance — a local install or a rented GPU box (AutoDL etc.). Generation runs on your own hardware, so the Endpoint reports `local` pricing: no Provider charge.

## Capabilities

| Capability | Result | Workflow |
| --- | --- | --- |
| `@hypit/wan@1#wan-2.7-image` | image set | bundled vanilla txt2img template, or your own |
| `@hypit/wan@1#wan-2.7-image-pro` | image set | your own template (no bundled default) |
| `@local/wan-video@1#wan-2.2-video` | video set | your own template (no bundled default) |

The capability names are the authoring vocabulary (`<wan:Image>`, `<wanVideo:Video>`). Which checkpoint and workflow actually render each one is decided by your Profile configuration — pointing `wan-2.7-image` at a Qwen Image or Flux workflow is a normal self-hosting choice.

Ports map onto workflow inputs as follows. Anything without a slot keeps the template's own value; requests needing an absent slot are refused (`hypit plan` shows this before any work runs).

| Port | Workflow slot | Notes |
| --- | --- | --- |
| `prompt` | `nodes.prompt` | required in every node map |
| `seed` | `nodes.seed` | required; `count` fans out to consecutive seeds |
| `resolution` (image) | `width` + `height` | 1K→1024², 2K→1536², 4K→2048² |
| `resolution`+`aspectRatio` (video) | `width` + `height` | Wan pairs, e.g. 480p 16:9 → 832×480 |
| `seconds` (video) | `nodes.frames` | `seconds × fps` (default fps 16) |
| `images[0]` | `nodes.image` | uploaded via `POST /upload/image` into a LoadImage node |
| `firstFrame` / `lastFrame` (video) | `nodes.firstFrame` / `nodes.lastFrame` | same upload path |
| `watermark`, `extendedReasoning` | — | no ComfyUI equivalent; `true` is refused |
| `image-set` | — | renders one storyline across pictures; `count` fans out independent seeds, so `true` is refused |

## Configure a video project

The Provider is an ordinary project package: copy or link `packages/provider-comfyui` (and `packages/wan-video` for video authoring) into your video project's `packages/` directory, then reference it from the project's `hypit.runtime.json`:

```json
{
  "format": "hypit.runtime-local@1",
  "dataRoot": ".hypit/runtimes/local",
  "endpoints": {
    "comfyui.local": {
      "use": "@local/provider-comfyui",
      "pool": "comfyui",
      "config": {
        "baseUrl": "http://127.0.0.1:8188",
        "workflows": {
          "wan-2.7-image": {
            "template": "workflows/txt2img.json",
            "nodes": { "prompt": "21.prompt", "seed": "31.seed", "width": "30.width", "height": "30.height" }
          },
          "wan-2.2-video": {
            "template": "workflows/wan-video.json",
            "nodes": {
              "prompt": "6.text", "seed": "3.seed",
              "width": "5.width", "height": "5.height",
              "frames": "5.length", "firstFrame": "10.image"
            },
            "fps": 16
          }
        }
      }
    }
  }
}
```

Config keys: `baseUrl` (HTTPS, loopback HTTP, or plain HTTP with `allowHttp: true`), `defaultConcurrency`, `actionLimits`, `pollIntervalMs`, `requestTimeoutMs`, `operationTimeoutMs`, `workflows`. Relative `template` paths resolve against the directory you run `hypit` from. A working example lives at `E:\code\comfyui-demo`.

## Prepare a workflow template

1. In ComfyUI, load the graph you want (any model, any custom nodes) and set a sample prompt.
2. Export via **Workflow → Export (API)** — this saves the `workflow_api.json` graph keyed by node id.
3. Note the node ids that own each slot: the positive prompt text input, the sampler seed, the latent width/height, the frame-count input for video length, and the LoadImage node for reference images.
4. Fill the `nodes` map with `"<nodeId>.<inputName>"` references (two parts, exactly as exported).

Validate without spending GPU time:

```bash
hypit plan run.svrun --runtime hypit.runtime.json   # routes each request to the Endpoint
hypit build run.svrun --runtime hypit.runtime.json --follow
```

Errors name the missing node id and list the ids the template actually has. Execution failures from ComfyUI (wrong model name, missing node class) surface with the failing node's type and id.

## AutoDL / rented GPU

Expose the instance through its custom-service proxy and point `baseUrl` at the HTTPS address (for example `https://<instance>-8188.container.autod.com`). Large reference uploads travel through the proxy, so prefer keeping input images modest. Multiple instances (local + remote) are separate `endpoints` entries; `bindings` in the Profile pick which serves which capability.

## Status

- Image pipeline verified end to end against a local ComfyUI 0.28 running Qwen Image (fp8) — build, poll, collect, export.
- Video pipeline verified end to end against a YZ MiniMax-H3 portable ComfyUI: `MiniMaxH3Director` t2v (int8 UNET + qwen3vl CLIP + dual VAE) through `CreateVideo`/`SaveVideo`, exported as MP4 (~2s, 864-class 480p, ~15 min on an 8 GB GPU). The H3 workflow needs ComfyUI core with official H3 support (CLIPLoader `type: "minimax"`); a desktop 0.28 install without it rejects the type at validation.
- Slot maps for both live workflows live in the demo project `E:\code\comfyui-demo` (`workflows/txt2img.json`, `workflows/h3-t2v-8190.json`, plus the dual-endpoint `hypit.runtime.json` with a Profile binding routing video to the H3 instance).
