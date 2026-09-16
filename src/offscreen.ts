import {
  isOffscreenRequest,
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./runtime/messages.ts";

function response(
  request: OffscreenRequest,
  type: OffscreenResponse["type"],
  extra: Partial<OffscreenResponse> = {},
): OffscreenResponse {
  return {
    source: OFFSCREEN_SOURCE,
    target: RUNTIME_SOURCE,
    requestId: request.requestId,
    type,
    ...extra,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isOffscreenRequest(message) || sender.id !== chrome.runtime.id) {
    return false;
  }
  const request = message;
  void (async () => {
    if (request.type === "PING") {
      return response(request, "PONG");
    }
    if (request.type === "WRITE_TEXT") {
      if (typeof request.text !== "string") {
        return response(request, "ERROR", {
          error: { code: "CLIPBOARD_WRITE_FAILED", message: "Clipboard text must be a string" },
        });
      }
      try {
        await navigator.clipboard.writeText(request.text);
        return response(request, "WRITE_TEXT_RESULT");
      } catch {
        return response(request, "ERROR", {
          error: { code: "CLIPBOARD_WRITE_FAILED", message: "The operating-system clipboard could not be written" },
        });
      }
    }
    try {
      const text = await navigator.clipboard.readText();
      return typeof text === "string"
        ? response(request, "READ_TEXT_RESULT", { text })
        : response(request, "ERROR", {
            error: { code: "CLIPBOARD_READ_FAILED", message: "The clipboard returned non-text data" },
          });
    } catch {
      return response(request, "ERROR", {
        error: { code: "CLIPBOARD_READ_FAILED", message: "The operating-system clipboard could not be read" },
      });
    }
  })().then(sendResponse);
  return true;
});
