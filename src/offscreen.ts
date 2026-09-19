import {
  isClipboardText,
  isOffscreenRequest,
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./runtime/messages.ts";
import {
  clipboardPayloadFromClipboardData,
  setClipboardDataFromPayload,
} from "./clipboard/clipboard-data.ts";
import {
  clipboardPayloadFromPlainText,
  getPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "./clipboard/payload.ts";
import { createOffscreenClipboardWatcher } from "./runtime/offscreen-watcher.ts";

export const CLIPBOARD_WATCH_INTERVAL_MS = 800;

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

function readClipboardPayload(): ClipboardPayloadV1 {
  const element = createClipboardTextarea();
  let payload: ClipboardPayloadV1 | undefined;
  let htmlFromPaste: string | undefined;
  let htmlWasPresent = false;
  let plainWasPresent = false;
  let pasteError: unknown;
  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    try {
      plainWasPresent = event.clipboardData.types.some(
        (type) => type === "text/plain",
      );
      htmlWasPresent = event.clipboardData.types.some(
        (type) => type === "text/html",
      );
      if (htmlWasPresent) htmlFromPaste = event.clipboardData.getData("text/html");
      if (plainWasPresent) {
        payload = clipboardPayloadFromClipboardData(
          event.clipboardData,
          element.value,
        );
      }
    } catch (error) {
      pasteError = error;
    }
  };

  try {
    element.addEventListener("paste", onPaste);
    element.value = "";
    element.focus();

    const pasted = document.execCommand("paste");

    if (!pasted) {
      throw new Error('document.execCommand("paste") returned false');
    }

    if (pasteError) throw pasteError;
    if (!plainWasPresent && htmlWasPresent) {
      payload = clipboardPayloadFromClipboardData(
        {
          types: ["text/plain", "text/html"],
          getData: (type) =>
            type === "text/plain" ? element.value : htmlFromPaste ?? "",
          setData: () => undefined,
        },
        element.value,
      );
    }
    return payload ?? clipboardPayloadFromPlainText(element.value);
  } finally {
    element.removeEventListener("paste", onPaste);
    element.remove();
  }
}

function readClipboardText(): string {
  return getPlainTextRepresentation(readClipboardPayload()).data;
}

function writeClipboardTextFallback(text: string): void {
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

function writeClipboardPayload(payload: ClipboardPayloadV1): ClipboardPayloadV1 {
  validateClipboardPayloadV1(payload);
  const plainOnly = clipboardPayloadFromPlainText(
    getPlainTextRepresentation(payload).data,
  );
  const element = createClipboardTextarea();
  let copyEventSeen = false;
  let copyError: unknown;
  const onCopy = (event: ClipboardEvent): void => {
    try {
      if (!event.clipboardData) {
        throw new Error("ClipboardData is unavailable");
      }
      copyEventSeen = true;
      setClipboardDataFromPayload(event.clipboardData, payload);
      event.preventDefault();
    } catch (error) {
      copyError = error;
    }
  };

  try {
    element.addEventListener("copy", onCopy);
    element.value = getPlainTextRepresentation(payload).data;
    element.focus();
    element.select();
    const copied = document.execCommand("copy");
    if (copyError) throw copyError;
    if (!copied || !copyEventSeen) {
      throw new Error('document.execCommand("copy") did not apply clipboard data');
    }
    return payload;
  } catch (error) {
    try {
      writeClipboardTextFallback(getPlainTextRepresentation(payload).data);
      return plainOnly;
    } catch {
      throw error;
    }
  } finally {
    element.removeEventListener("copy", onCopy);
    element.remove();
  }
}

const clipboardWatcher = createOffscreenClipboardWatcher({
  readPayload: readClipboardPayload,
  intervalMs: CLIPBOARD_WATCH_INTERVAL_MS,
  runtime: chrome.runtime,
  onError: (error) => {
    // Clipboard polling failures are transient and must not expose clipboard
    // content or create extension-error noise.
    void error;
  },
});

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

      if (request.type === "WRITE_TEXT" || request.type === "WRITE_PAYLOAD") {
        let requestedPayload: ClipboardPayloadV1 | undefined;
        if (request.type === "WRITE_TEXT") {
          if (!isClipboardText(request.text)) {
            return response(request, "ERROR", {
              error: {
                code: "CLIPBOARD_WRITE_FAILED",
                message: "Clipboard text must be a string",
              },
            });
          }
          requestedPayload = clipboardPayloadFromPlainText(request.text);
        } else {
          requestedPayload = request.payload;
        }

        try {
          if (!requestedPayload) throw new Error("Clipboard payload is missing");
          const actualPayload = writeClipboardPayload(requestedPayload);
          // This update is in the same synchronous handler turn as the
          // successful OS write, so the next sample cannot echo it outward.
          clipboardWatcher.noteExternalWrite(actualPayload);
          return request.type === "WRITE_TEXT"
            ? response(request, "WRITE_TEXT_RESULT")
            : response(request, "WRITE_PAYLOAD_RESULT", {
                payload: actualPayload,
              });
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

      if (request.type === "WATCH_START") {
        clipboardWatcher.start({ resetBaseline: request.resetBaseline === true });
        return response(request, "WATCH_START_RESULT");
      }

      if (request.type === "WATCH_STOP") {
        clipboardWatcher.stop();
        return response(request, "WATCH_STOP_RESULT");
      }

      try {
        if (request.type === "READ_PAYLOAD") {
          return response(request, "READ_PAYLOAD_RESULT", {
            payload: readClipboardPayload(),
          });
        }
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
