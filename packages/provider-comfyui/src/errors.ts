import { EndpointServiceError } from "@hypit/hypit/endpoint";
import { EndpointHttpError, retryAfterMs } from "@hypit/hypit/endpoint/http";

/** ComfyUI failure evidence kept at the service boundary; messages may echo workflow filenames. */
export class ComfyUiServiceError extends EndpointServiceError {}

export class ComfyUiHttpError extends EndpointHttpError {
  constructor(status: number, response: { readonly headers: Headers }, bodyText: string,
    request: { readonly method: string; readonly path: string }) {
    const reason = bodyText.trim().length === 0 ? undefined : bodyText.trim().slice(0, 2000);
    super(
      status === 0 ? "COMFYUI_TRANSPORT" : "COMFYUI_HTTP_ERROR",
      `ComfyUI HTTP ${status}; ${request.method} ${request.path}${reason === undefined ? "" : `: ${reason}`}`,
      status,
      retryAfterMs(response.headers),
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * One `execution_error` or `execution_interrupted` message from a finished prompt's status.
 * ComfyUI reports the failing node's type and id there; keep both in the reason.
 */
export function comfyUiExecutionFailure(status: Record<string, unknown>, promptId: string): ComfyUiServiceError | undefined {
  const messages = status.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    const kind = String(entry[0]);
    const payload = record(entry[1]);
    if (payload === undefined) continue;
    if (kind === "execution_error") {
      const nodeType = text(payload.node_type) ?? "unknown node";
      const nodeId = text(payload.node_id) ?? "unknown id";
      const exception = text(payload.exception_message) ?? text(payload.exception_type) ?? "no message";
      return new ComfyUiServiceError("COMFYUI_EXECUTION_ERROR",
        `ComfyUI prompt ${promptId} failed at ${nodeType} (node ${nodeId}): ${exception}`);
    }
    if (kind === "execution_interrupted") {
      return new ComfyUiServiceError("COMFYUI_EXECUTION_INTERRUPTED",
        `ComfyUI prompt ${promptId} was interrupted`);
    }
  }
  if (text(status.status_str) === "error") {
    return new ComfyUiServiceError("COMFYUI_EXECUTION_ERROR",
      `ComfyUI prompt ${promptId} finished with status error and no execution message`);
  }
  return undefined;
}
