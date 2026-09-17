import type {
  RuntimeCommand,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeStatus,
  RuntimeStatusBroadcast,
} from "./messages.ts";
import { POPUP_SOURCE, RUNTIME_SOURCE } from "./messages.ts";
import { RuntimeError } from "./errors.ts";

const TRANSIENT_RETRY_COMMANDS = new Set<RuntimeCommand["type"]>([
  "runtime:get-status",
]);

const TRANSIENT_RETRY_DELAY_MS = 75;

function isTransientWorkerSendError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error &&
            typeof error.message === "string"
          ? error.message
          : "";
  return /receiving end does not exist|message port closed|extension context invalidated|service worker.+(?:restart|start|unavailable)|could not establish connection/i.test(
    message,
  );
}

function waitForWorkerRestart(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS);
  });
}

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
  } catch (error) {
    if (
      TRANSIENT_RETRY_COMMANDS.has(command.type) &&
      isTransientWorkerSendError(error)
    ) {
      await waitForWorkerRestart();
      try {
        response = await chrome.runtime.sendMessage(message);
      } catch {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "The Copyyt service worker did not respond",
        );
      }
    } else {
      throw new RuntimeError(
        "AUTH_REQUIRED",
        "The Copyyt service worker did not respond",
      );
    }
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
