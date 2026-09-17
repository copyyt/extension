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

function createClipboardTextarea(): HTMLTextAreaElement {
  const element = document.createElement("textarea");

  element.style.position = "fixed";
  element.style.left = "-9999px";
  element.style.top = "0";
  element.style.opacity = "0";

  document.body.appendChild(element);
  return element;
}

function readClipboardText(): string {
  const element = createClipboardTextarea();

  try {
    element.value = "";
    element.focus();

    const pasted = document.execCommand("paste");

    if (!pasted) {
      throw new Error('document.execCommand("paste") returned false');
    }

    return element.value;
  } finally {
    element.remove();
  }
}

function writeClipboardText(text: string): void {
  const element = createClipboardTextarea();

  try {
    element.value = text;
    element.focus();
    element.select();

    const copied = document.execCommand("copy");

    if (!copied) {
      throw new Error('document.execCommand("copy") returned false');
    }
  } finally {
    element.remove();
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
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
            error: {
              code: "CLIPBOARD_WRITE_FAILED",
              message: "Clipboard text must be a string",
            },
          });
        }

        try {
          writeClipboardText(request.text);
          return response(request, "WRITE_TEXT_RESULT");
        } catch (error) {
          console.error("COPYyt offscreen clipboard write failed", error);

          return response(request, "ERROR", {
            error: {
              code: "CLIPBOARD_WRITE_FAILED",
              message:
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : "The operating-system clipboard could not be written",
            },
          });
        }
      }

      try {
        const text = readClipboardText();

        return response(request, "READ_TEXT_RESULT", { text });
      } catch (error) {
        console.error("COPYyt offscreen clipboard read failed", error);

        return response(request, "ERROR", {
          error: {
            code: "CLIPBOARD_READ_FAILED",
            message:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : "The operating-system clipboard could not be read",
          },
        });
      }
    })().then(sendResponse);

    return true;
  },
);
