import { blobTypes } from "@hypit/hypit/blob";
import { generationPort, sealGenerationMediaBinding, sealGenerationRequestDraft } from "@hypit/generation";
import type { GenerationMediaPort, GenerationPortValue } from "@hypit/generation";
import {
  createExactModelPrimaryGenerationFragment,
  exactModelMediaInputNames,
  exactModelTextInputName,
} from "@hypit/generation/model";
import type { ExactModelEndpoint } from "@hypit/generation/model";
import type { CanonicalValue, TypeRef } from "@hypit/hypit/protocol";
import type { MarkupAttributeValue, StructuredElement, StructuredSurfaceHandler, SurfaceResolvedReference } from "@hypit/hypit/markup";
import { textTypes, verifyText } from "@hypit/hypit/text";

import { wanVideoEndpoints } from "./index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function sameType(left: TypeRef, right: TypeRef): boolean {
  return left.name === right.name && left.module.name === right.module.name && left.module.version === right.module.version;
}

function exact(element: StructuredElement, allowed: readonly string[], required: readonly string[]): void {
  const unknown = Object.keys(element.attributes).filter((name) => !allowed.includes(name));
  assert(unknown.length === 0, `${element.name} does not accept ${unknown[0]}`);
  const missing = required.filter((name) => element.attributes[name] === undefined);
  assert(missing.length === 0, `${element.name} requires ${missing.join(", ")}`);
}

function text(element: StructuredElement, name: string): string {
  const value = element.attributes[name];
  assert(typeof value === "string" && value.trim().length > 0, `${element.name}.${name} must be text`);
  return value.trim();
}

/** An absent optional attribute leaves its port unstated, which the model reads as its own default. */
function optionalText(element: StructuredElement, name: string): readonly GenerationPortValue[] | undefined {
  return element.attributes[name] === undefined ? undefined : [text(element, name)];
}

function optionalInteger(element: StructuredElement, name: string): readonly GenerationPortValue[] | undefined {
  if (element.attributes[name] === undefined) return undefined;
  const value = text(element, name);
  assert(/^\d+$/u.test(value), `${element.name}.${name} must be a whole number`);
  return [Number(value)];
}

function ref(
  element: StructuredElement,
  name: string,
  type: TypeRef,
  resolve: (path: string) => SurfaceResolvedReference | undefined,
): SurfaceResolvedReference {
  const value: MarkupAttributeValue | undefined = element.attributes[name];
  assert(typeof value === "object" && value.kind === "reference", `${element.name}.${name} must be a reference`);
  const result = resolve(value.path);
  assert(result !== undefined && sameType(result.type, type), `${element.name}.${name} has the wrong type`);
  return result;
}

const attributes = ["id", "prompt", "seconds", "resolution", "aspect-ratio", "seed"] as const;
const keyframePorts = { FirstFrame: "firstFrame", LastFrame: "lastFrame" } as const;
type KeyframeTag = keyof typeof keyframePorts;

function decoder(endpoint: ExactModelEndpoint): StructuredSurfaceHandler {
  return ({ element, resolveReference }) => {
    exact(element, [...attributes], ["id", "prompt"]);
    const id = text(element, "id");
    const prompt = ref(element, "prompt", textTypes.text, resolveReference);
    if (prompt.record !== undefined) {
      assert(prompt.record.value.kind === "inline", `${element.name}.prompt must reference Text`);
      verifyText(prompt.record.value.value);
    }
    const keyframes: Array<{ tag: KeyframeTag; image: SurfaceResolvedReference }> = [];
    for (const child of element.children) {
      if (child.kind === "text") {
        assert(child.value.trim().length === 0, `${element.name} accepts only FirstFrame and LastFrame children`);
        continue;
      }
      const tag = localName(child.name) as KeyframeTag;
      assert(tag in keyframePorts, `${element.name} accepts only FirstFrame and LastFrame children`);
      exact(child, ["image"], ["image"]);
      assert(!child.children.some((item) => item.kind === "element" || item.value.trim()), `${child.name} must be empty`);
      const image = ref(child, "image", blobTypes.blob, resolveReference);
      if (image.record !== undefined) {
        assert(image.record.value.kind === "blob" && image.record.value.mediaType.startsWith("image/"),
          `${child.name}.image must reference an image Artifact`);
      }
      keyframes.push({ tag, image });
    }
    for (const tag of Object.keys(keyframePorts) as KeyframeTag[]) {
      assert(keyframes.filter((keyframe) => keyframe.tag === tag).length <= 1, `${element.name} accepts at most one ${tag}`);
    }
    const stated: Record<string, readonly GenerationPortValue[] | undefined> = {
      seconds: optionalInteger(element, "seconds"),
      resolution: optionalText(element, "resolution"),
      aspectRatio: optionalText(element, "aspect-ratio"),
      seed: optionalInteger(element, "seed"),
    };
    const draft = sealGenerationRequestDraft(endpoint.ports, Object.fromEntries(
      Object.entries(stated).filter((entry): entry is [string, readonly GenerationPortValue[]] => entry[1] !== undefined),
    ));
    const records: Array<{ id: string; type: TypeRef; value: { kind: "inline"; value: CanonicalValue }; range: StructuredElement["range"] }> = [{
      id: `${id}.draft`, type: endpoint.draftType,
      value: { kind: "inline", value: draft as unknown as CanonicalValue }, range: element.range,
    }];
    const inputs: Record<string, SurfaceResolvedReference["ref"] | { kind: "record"; id: string }> = {
      draft: { kind: "record", id: `${id}.draft` }, [exactModelTextInputName("prompt")]: prompt.ref,
    };
    const media = keyframes.map(({ tag, image }) => {
      const portName = keyframePorts[tag];
      const port = generationPort(endpoint.ports, portName);
      assert(port.value.kind === "media", `Wan video ${portName} port is not media`);
      const bindingId = `${id}.${portName}.binding`;
      records.push({
        id: bindingId, type: endpoint.mediaBindings[portName]!.type,
        value: { kind: "inline", value: sealGenerationMediaBinding(port as GenerationMediaPort, { role: "image" }) as unknown as CanonicalValue },
        range: element.range,
      });
      const names = exactModelMediaInputNames(portName);
      inputs[names.binding] = { kind: "record", id: bindingId };
      inputs[names.artifact] = image.ref;
      return { name: portName, port: portName } as const;
    });
    const fragment = createExactModelPrimaryGenerationFragment(endpoint, media, [{ name: "prompt", port: "prompt" }]);
    return { records, fragments: [fragment], components: [{
      id, fragment: fragment.id, inputs, outputs: { video: `${id}.video` }, range: element.range,
    }] };
  };
}

export const decodeWanVideoSurface = decoder(wanVideoEndpoints.video!);
