import { RuntimeError } from "./errors.ts";
import {
  clipboardPayloadFromPlainText,
  getPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import {
  isClipboardText,
  isOffscreenRequest,
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./messages.ts";
import { ensureOffscreenDocument } from "./offscreen-lifecycle.ts";

export interface ClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readPayload?(): Promise<ClipboardPayloadV1>;
  writePayload?(payload: ClipboardPayloadV1): Promise<void>;
  rebaselineFromClipboard?(): Promise<void>;
  ping?(): Promise<void>;
  startWatching?(options?: { resetBaseline?: boolean }): Promise<void>;
  stopWatching?(): Promise<void>;
}

interface RuntimeMessagingApi {
  runtime: Pick<typeof chrome.runtime, "sendMessage">;
}

function requestId(): string {
  return globalThis.crypto.randomUUID();
}

function isResponse(value: unknown): value is OffscreenResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OffscreenResponse>;
  const base = (
    candidate.source === OFFSCREEN_SOURCE &&
    candidate.target === RUNTIME_SOURCE &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    (candidate.type === "READ_TEXT_RESULT" ||
      candidate.type === "WRITE_TEXT_RESULT" ||
      candidate.type === "READ_PAYLOAD_RESULT" ||
      candidate.type === "WRITE_PAYLOAD_RESULT" ||
      candidate.type === "REBASELINE_FROM_CLIPBOARD_RESULT" ||
      candidate.type === "WATCH_START_RESULT" ||
      candidate.type === "WATCH_STOP_RESULT" ||
      candidate.type === "PONG" ||
      candidate.type === "ERROR")
  );
  if (!base) return false;
  if (
    candidate.type === "READ_PAYLOAD_RESULT" ||
    candidate.type === "WRITE_PAYLOAD_RESULT"
  ) {
    try {
      validateClipboardPayloadV1(candidate.payload);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export class OffscreenClipboardAdapter implements ClipboardAdapter {
  private readonly api: RuntimeMessagingApi;
  private readonly ensureDocument: () => Promise<void>;

  constructor(
    api: RuntimeMessagingApi = chrome,
    ensureDocument: () => Promise<void> = () => ensureOffscreenDocument(),
  ) {
    this.api = api;
    this.ensureDocument = ensureDocument;
  }

  async readText(): Promise<string> {
    try {
      return getPlainTextRepresentation(await this.readPayload()).data;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The operating-system clipboard could not be read",
      );
    }
  }

  async readPayload(): Promise<ClipboardPayloadV1> {
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "READ_PAYLOAD" });
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The operating-system clipboard could not be read",
      );
    }
    if (response.type === "ERROR") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        response.error?.message ??
          "The operating-system clipboard could not be read",
      );
    }
    if (response.type !== "READ_PAYLOAD_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid response",
      );
    }
    try {
      validateClipboardPayloadV1(response.payload);
      return response.payload;
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid payload",
      );
    }
  }

  async writeText(text: string): Promise<void> {
    if (!isClipboardText(text)) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard text must be a string",
      );
    }
    await this.writePayload(clipboardPayloadFromPlainText(text));
  }

  async writePayload(payload: ClipboardPayloadV1): Promise<void> {
    try {
      validateClipboardPayloadV1(payload);
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard payload is invalid",
      );
    }
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "WRITE_PAYLOAD", payload });
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "The operating-system clipboard could not be written",
      );
    }
    if (response.type === "ERROR") {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        response.error?.message ??
          "The operating-system clipboard could not be written",
      );
    }
    if (response.type !== "WRITE_PAYLOAD_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "The clipboard adapter returned an invalid response",
      );
    }
    try {
      validateClipboardPayloadV1(response.payload);
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "The clipboard adapter returned an invalid payload",
      );
    }
  }

  async rebaselineFromClipboard(): Promise<void> {
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "REBASELINE_FROM_CLIPBOARD" });
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The operating-system clipboard could not be re-baselined",
      );
    }
    if (response.type === "ERROR") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        response.error?.message ??
          "The operating-system clipboard could not be re-baselined",
      );
    }
    if (response.type !== "REBASELINE_FROM_CLIPBOARD_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid re-baseline response",
      );
    }
  }

  async startWatching(options: { resetBaseline?: boolean } = {}): Promise<void> {
    let response: OffscreenResponse;
    try {
      response = await this.send({
        type: "WATCH_START",
        resetBaseline: options.resetBaseline === true,
      });
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The Copyyt clipboard watcher did not respond",
      );
    }
    if (response.type !== "WATCH_START_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard watcher returned an invalid response",
      );
    }
  }

  async stopWatching(): Promise<void> {
    let response: OffscreenResponse;
    try {
      // Stopping should not create an offscreen document just to discover that
      // there was no watcher to stop.
      response = await this.send({ type: "WATCH_STOP" }, false);
    } catch {
      return;
    }
    if (response.type !== "WATCH_STOP_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard watcher returned an invalid response",
      );
    }
  }

  async ping(): Promise<void> {
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "PING" });
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter did not respond",
      );
    }
    if (response.type !== "PONG") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid response",
      );
    }
  }

  private async send(
    input: Pick<
      OffscreenRequest,
      "type" | "text" | "payload" | "resetBaseline"
    >,
    ensureDocument = true,
  ): Promise<OffscreenResponse> {
    if (ensureDocument) await this.ensureDocument();
    const message: OffscreenRequest = {
      source: RUNTIME_SOURCE,
      target: OFFSCREEN_SOURCE,
      requestId: requestId(),
      ...input,
    };
    if (!isOffscreenRequest(message)) {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard request is invalid",
      );
    }
    let rawResponse: unknown;
    try {
      rawResponse = await this.api.runtime.sendMessage(message);
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter did not respond",
      );
    }
    if (
      !isResponse(rawResponse) ||
      rawResponse.requestId !== message.requestId
    ) {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid response",
      );
    }
    return rawResponse;
  }
}
