import { createMarkupSurfaceFacet } from "@hypit/hypit/markup";
import { createAdmissionPackageFacet } from "@hypit/hypit/admission";
import { createProducerPackageFacet } from "@hypit/hypit/producer";
import { wanVideoComponent, wanVideoDefinition, wanVideoManifest, wanVideoModuleRef, wanVideoMarkupSurfaces } from "./index.js";
import { decodeWanVideoSurface } from "./surface.js";
export const hypitPackage = { format: "hypit.package@1" as const, modules: [{ manifest: wanVideoManifest }], facets: [
  createProducerPackageFacet(wanVideoComponent),
  createAdmissionPackageFacet(wanVideoComponent),
  wanVideoDefinition.facet,
  createMarkupSurfaceFacet({ module: wanVideoModuleRef,
    declaration: wanVideoMarkupSurfaces.find((item) => item.name === "video")!, handler: decodeWanVideoSurface }),
] };
export default hypitPackage;
