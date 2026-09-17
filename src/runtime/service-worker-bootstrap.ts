import {
  isOffscreenClipboardObservation,
  isRuntimeRequest,
  POPUP_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenClipboardObservation,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./messages.ts";

export interface RuntimeMessageSender {
  id?: string;
  url?: string;
  documentUrl?: string;
  contextType?: string;
}

export interface RuntimeMessageListenerDependencies {
  runtime: {
    handleMessage(message: unknown): Promise<RuntimeResponse>;
    handleClipboardObservation?: (
      message: OffscreenClipboardObservation,
    ) => Promise<void> | void;
  };
  runtimeReady: Promise<void>;
  getStartupError(): unknown;
  runtimeId: string;
  extensionUrl: string;
}

function startupFailureResponse(message: RuntimeRequest): RuntimeResponse {
  return {
    source: RUNTIME_SOURCE,
    target: POPUP_SOURCE,
    requestId: message.requestId,
    ok: false,
    error: {
      code: "RUNTIME_START_FAILED",
      message: "The Copyyt service worker could not start",
    },
  };
}

function dispatchFailureResponse(message: RuntimeRequest): RuntimeResponse {
  return {
    source: RUNTIME_SOURCE,
    target: POPUP_SOURCE,
    requestId: message.requestId,
    ok: false,
    error: {
      code: "RUNTIME_START_FAILED",
      message: "The Copyyt service worker could not handle the request",
    },
  };
}

function isExtensionSender(
  sender: RuntimeMessageSender,
  dependencies: RuntimeMessageListenerDependencies,
): boolean {
  return (
    sender.id === dependencies.runtimeId &&
    (sender.url === undefined ||
      sender.url.startsWith(dependencies.extensionUrl))
  );
}

function isPackagedOffscreenSender(
  sender: RuntimeMessageSender,
  dependencies: RuntimeMessageListenerDependencies,
): boolean {
  const offscreenUrl = `${dependencies.extensionUrl}offscreen.html`;
  return (
    sender.id === dependencies.runtimeId &&
    (sender.url === undefined || sender.url === offscreenUrl) &&
    (sender.documentUrl === undefined || sender.documentUrl === offscreenUrl) &&
    (sender.url === offscreenUrl || sender.documentUrl === offscreenUrl) &&
    (sender.contextType === undefined ||
      sender.contextType === "OFFSCREEN_DOCUMENT")
  );
}

/**
 * Creates the synchronous MV3 message listener. The listener itself must be
 * installed during module evaluation; only the dispatch work waits for boot.
 */
export function createRuntimeMessageListener(
  dependencies: RuntimeMessageListenerDependencies,
): (
  message: unknown,
  sender: RuntimeMessageSender,
  sendResponse: (response?: RuntimeResponse) => void,
) => boolean {
  return (message, sender, sendResponse) => {
    if (isOffscreenClipboardObservation(message)) {
      if (
        !isPackagedOffscreenSender(sender, dependencies) ||
        !dependencies.runtime.handleClipboardObservation
      ) {
        return false;
      }
      void dependencies.runtimeReady
        .then(() => {
          if (dependencies.getStartupError() !== null) return;
          return dependencies.runtime.handleClipboardObservation!(message);
        })
        .catch(() => undefined)
        .then(() => sendResponse());
      return true;
    }

    if (!isRuntimeRequest(message) || !isExtensionSender(sender, dependencies)) {
      return false;
    }

    void dependencies.runtimeReady
      .then(() => {
        if (dependencies.getStartupError() !== null) {
          return startupFailureResponse(message);
        }
        return dependencies.runtime.handleMessage(message);
      })
      .catch(() => dispatchFailureResponse(message))
      .then(sendResponse);
    return true;
  };
}
