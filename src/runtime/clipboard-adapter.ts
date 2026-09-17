import { RuntimeError } from "./errors.ts";
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
  return (
    candidate.source === OFFSCREEN_SOURCE &&
    candidate.target === RUNTIME_SOURCE &&
    typeof candidate.requestId === "string" &&
    (candidate.type === "READ_TEXT_RESULT" ||
      candidate.type === "WRITE_TEXT_RESULT" ||
      candidate.type === "WATCH_START_RESULT" ||
      candidate.type === "WATCH_STOP_RESULT" ||
      candidate.type === "PONG" ||
      candidate.type === "ERROR")
  );
}

export class OffscreenClipboardAdapter implements ClipboardAdapter {
  constructor(
    private readonly api: RuntimeMessagingApi = chrome,
    private readonly ensureDocument: () => Promise<void> = () =>
      ensureOffscreenDocument(),
  ) {}

  async readText(): Promise<string> {
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "READ_TEXT" });
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
    if (
      response.type !== "READ_TEXT_RESULT" ||
      !isClipboardText(response.text)
    ) {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned an invalid response",
      );
    }
    return response.text;
  }

  async writeText(text: string): Promise<void> {
    if (!isClipboardText(text)) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard text must be a string",
      );
    }
    let response: OffscreenResponse;
    try {
      response = await this.send({ type: "WRITE_TEXT", text });
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
    if (response.type !== "WRITE_TEXT_RESULT") {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "The clipboard adapter returned an invalid response",
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
    input: Pick<OffscreenRequest, "type" | "text" | "resetBaseline">,
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
