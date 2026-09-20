import {
  isClipboardText,
  isOffscreenRequest,
  type OffscreenDirectTransportEvent,
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./runtime/messages.ts";
import { WebRtcPeerManager, DirectTransportError } from "./direct/webrtc-peer-manager.ts";
import type { DirectManagerEvent } from "./direct/protocol.ts";
import {
  clipboardPayloadFromClipboardFile,
  getPngFileFromClipboardData,
  setChromeOffscreenClipboardDataFromPayload,
  type ClipboardDataLike,
} from "./clipboard/clipboard-data.ts";
import {
  clipboardPayloadFromPlainText,
  findPlainTextRepresentation,
  getPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "./clipboard/payload.ts";
import { createOffscreenClipboardWatcher } from "./runtime/offscreen-watcher.ts";

export const CLIPBOARD_WATCH_INTERVAL_MS = 800;

function directEvent(event: DirectManagerEvent): OffscreenDirectTransportEvent {
  return {
    source: OFFSCREEN_SOURCE,
    target: RUNTIME_SOURCE,
    type: "DIRECT_EVENT",
    event,
  };
}

const directPeerManager = new WebRtcPeerManager({
  emit: (event) =>
    chrome.runtime.sendMessage(directEvent(event)).catch(() => undefined),
});

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

async function readClipboardPayload(): Promise<ClipboardPayloadV1> {
  const element = createClipboardTextarea();
  let clipboardTypes: string[] = [];
  let plainFromPaste: string | undefined;
  let htmlFromPaste: string | undefined;
  let pngFile: Awaited<ReturnType<typeof getPngFileFromClipboardData>>;
  let pasteError: unknown;
  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    try {
      const data = event.clipboardData as unknown as ClipboardDataLike;
      clipboardTypes = [...data.types];
      if (clipboardTypes.includes("text/plain")) {
        plainFromPaste = data.getData("text/plain");
      }
      if (clipboardTypes.includes("text/html")) {
        htmlFromPaste = data.getData("text/html");
      }
      // Keep only the File reference until the synchronous paste command has
      // returned. The bytes are read below, never rendered or object-URL'd.
      pngFile = getPngFileFromClipboardData(data);
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

    const snapshot: ClipboardDataLike = {
      types: clipboardTypes,
      getData: (type) =>
        type === "text/plain"
          ? plainFromPaste ?? ""
          : htmlFromPaste ?? "",
      setData: () => undefined,
    };
    return clipboardPayloadFromClipboardFile(snapshot, element.value, pngFile);
  } finally {
    element.removeEventListener("paste", onPaste);
    element.remove();
  }
}

async function readClipboardText(): Promise<string> {
  return getPlainTextRepresentation(await readClipboardPayload()).data;
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
  const plain = findPlainTextRepresentation(payload);
  if (!plain) {
    // Reject before creating a copy target or invoking execCommand("copy"),
    // so an unsupported image-only request cannot replace the clipboard with
    // an empty value or a browser-generated file name.
    throw new Error(
      "Chrome offscreen clipboard writing does not support image/png",
    );
  }
  const plainOnly = plain ? clipboardPayloadFromPlainText(plain.data) : undefined;
  const element = createClipboardTextarea();
  let copyEventSeen = false;
  let copyError: unknown;
  const onCopy = (event: ClipboardEvent): void => {
    try {
      if (!event.clipboardData) {
        throw new Error("ClipboardData is unavailable");
      }
      copyEventSeen = true;
      const actualPayload = setChromeOffscreenClipboardDataFromPayload(
        event.clipboardData as unknown as ClipboardDataLike,
        payload,
      );
      event.preventDefault();
      appliedPayload = actualPayload;
    } catch (error) {
      copyError = error;
    }
  };
  let appliedPayload: ClipboardPayloadV1 | undefined;

  try {
    element.addEventListener("copy", onCopy);
    element.value = plain?.data ?? "";
    element.focus();
    element.select();
    const copied = document.execCommand("copy");
    if (copyError) throw copyError;
    if (!copied || !copyEventSeen || !appliedPayload) {
      throw new Error('document.execCommand("copy") did not apply clipboard data');
    }
    return appliedPayload;
  } catch (error) {
    if (!plain || !plainOnly) throw error;
    try {
      writeClipboardTextFallback(plain.data);
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

      if (request.type === "DIRECT_START_TEST") {
        try {
          await directPeerManager.startTestTransfer({
            transferId: request.transferId!,
            remoteDeviceId: request.remoteDeviceId!,
          });
          return response(request, "DIRECT_START_RESULT", {
            accepted: true,
            transferId: request.transferId,
          });
        } catch (error) {
          return response(request, "ERROR", {
            error: {
              code: "DIRECT_TRANSPORT_FAILED",
              message:
                error instanceof DirectTransportError || error instanceof Error
                  ? error.message
                  : "The direct transport could not start",
            },
          });
        }
      }

      if (request.type === "DIRECT_START_CLIPBOARD") {
        try {
          await directPeerManager.startClipboardTransfer({
            transferId: request.transferId!,
            remoteDeviceId: request.remoteDeviceId!,
            manifest: request.manifest!,
            encryptedChunks: request.encryptedChunks!,
          });
          return response(request, "DIRECT_START_CLIPBOARD_RESULT", {
            accepted: true,
            transferId: request.transferId,
          });
        } catch (error) {
          return response(request, "ERROR", {
            error: {
              code: "DIRECT_TRANSPORT_FAILED",
              message:
                error instanceof DirectTransportError || error instanceof Error
                  ? error.message
                  : "The direct clipboard transport could not start",
            },
          });
        }
      }

      if (request.type === "DIRECT_HANDLE_SIGNAL") {
        try {
          await directPeerManager.handleSignal(request.signal!);
          return response(request, "DIRECT_HANDLE_SIGNAL_RESULT", {
            accepted: true,
            transferId: request.signal?.transferId,
          });
        } catch (error) {
          return response(request, "ERROR", {
            error: {
              code: "DIRECT_TRANSPORT_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The direct signal could not be applied",
            },
          });
        }
      }

      if (request.type === "DIRECT_SEND_CLIPBOARD_VERIFIED") {
        try {
          await directPeerManager.sendClipboardVerified({
            transferId: request.transferId!,
            plaintextByteLength: request.plaintextByteLength!,
          });
          return response(request, "DIRECT_SEND_CLIPBOARD_VERIFIED_RESULT", {
            accepted: true,
            transferId: request.transferId,
          });
        } catch (error) {
          return response(request, "ERROR", {
            error: {
              code: "DIRECT_TRANSPORT_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The direct clipboard verification could not be sent",
            },
          });
        }
      }

      if (request.type === "DIRECT_CANCEL") {
        await directPeerManager.cancelTransfer(request.transferId!, request.reason);
        return response(request, "DIRECT_CANCEL_RESULT", {
          accepted: true,
          transferId: request.transferId,
        });
      }

      if (request.type === "DIRECT_CANCEL_ALL") {
        await directPeerManager.cancelAll(request.reason);
        return response(request, "DIRECT_CANCEL_ALL_RESULT", { accepted: true });
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

      if (request.type === "REBASELINE_FROM_CLIPBOARD") {
        try {
          const actualPayload = await readClipboardPayload();
          clipboardWatcher.noteExternalWrite(actualPayload);
          return response(request, "REBASELINE_FROM_CLIPBOARD_RESULT");
        } catch (error) {
          console.error("COPYyt offscreen clipboard re-baseline failed", error);

          return response(request, "ERROR", {
            error: {
              code: "CLIPBOARD_READ_FAILED",
              message:
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : "The operating-system clipboard could not be re-baselined",
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
            payload: await readClipboardPayload(),
          });
        }
        const text = await readClipboardText();
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
