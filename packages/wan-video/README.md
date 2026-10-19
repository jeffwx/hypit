# @local/wan-video

An exact-model package for authoring self-hosted video shots. It contributes the authoring vocabulary; serving is owned by a Provider (see `@local/provider-comfyui`).

```xml
<import as="wanvideo" from="@local/wan-video@1"/>

<wanvideo:Video id="shot" prompt={shotPrompt} seconds="5" resolution="720p" aspect-ratio="16:9" seed="42">
  <wanvideo:FirstFrame image={draft.image}/>
  <wanvideo:LastFrame image={final.image}/>
</wanvideo:Video>
```

- `prompt` (required) references a Text edge.
- `seconds` 1–20 whole seconds; the serving workflow's `fps` turns it into a frame count.
- `resolution` one of `480p | 720p | 1080p`; `aspect-ratio` one of `16:9 | 9:16 | 1:1` (state together).
- `FirstFrame` / `LastFrame` children take one image Artifact each.
- Output port: `<id>.video`.

The model name `wan-2.2-video` is the capability vocabulary — which checkpoint and workflow render it belongs to the Provider's Profile configuration.
