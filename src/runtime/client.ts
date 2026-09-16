import type {
  RuntimeCommand,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeStatus,
  RuntimeStatusBroadcast,
} from "./messages.ts";
import { POPUP_SOURCE, RUNTIME_SOURCE } from "./messages.ts";
import { RuntimeError } from "./errors.ts";

function requestId(): string {
  return globalThis.crypto.randomUUID();
}

export async function sendRuntimeCommand<T>(command: RuntimeCommand): Promise<T> {
  const message: RuntimeRequest = {
    source: POPUP_SOURCE,
    target: RUNTIME_SOURCE,
    requestId: requestId(),
    command,
  };
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    throw new RuntimeError("AUTH_REQUIRED", "The Copyyt service worker did not respond");
  }
  if (!response || typeof response !== "object") {
    throw new RuntimeError("AUTH_REQUIRED", "The Copyyt service worker returned no response");
  }
  const candidate = response as Partial<RuntimeResponse<T>>;
  if (
    candidate.source !== RUNTIME_SOURCE ||
    candidate.target !== POPUP_SOURCE ||
    candidate.requestId !== message.requestId
  ) {
    throw new RuntimeError("AUTH_REQUIRED", "The Copyyt service worker response is invalid");
  }
  if (!candidate.ok) {
    throw new RuntimeError(
      candidate.error?.code ?? "AUTH_REQUIRED",
      candidate.error?.message ?? "The Copyyt runtime operation failed",
    );
  }
  return candidate.data as T;
}

export function isRuntimeStatusBroadcast(value: unknown): value is RuntimeStatusBroadcast {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeStatusBroadcast>;
  return (
    candidate.source === RUNTIME_SOURCE &&
    candidate.target === POPUP_SOURCE &&
    candidate.type === "runtime:status" &&
    Boolean(candidate.status)
  );
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return sendRuntimeCommand<RuntimeStatus>({ type: "runtime:get-status" });
}
