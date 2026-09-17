import {
  isRuntimeRequest,
  POPUP_SOURCE,
  RUNTIME_SOURCE,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./messages.ts";

export interface RuntimeMessageSender {
  id?: string;
  url?: string;
}

export interface RuntimeMessageListenerDependencies {
  runtime: {
    handleMessage(message: unknown): Promise<RuntimeResponse>;
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

/**
 * Creates the synchronous MV3 message listener. The listener itself must be
 * installed during module evaluation; only the dispatch work waits for boot.
 */
export function createRuntimeMessageListener(
  dependencies: RuntimeMessageListenerDependencies,
): (
  message: unknown,
  sender: RuntimeMessageSender,
  sendResponse: (response: RuntimeResponse) => void,
) => boolean {
  return (message, sender, sendResponse) => {
    if (
      !isRuntimeRequest(message) ||
      sender.id !== dependencies.runtimeId ||
      (sender.url !== undefined &&
        !sender.url.startsWith(dependencies.extensionUrl))
    ) {
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
