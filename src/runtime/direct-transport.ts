import { RuntimeError } from "./errors.ts";
import {
  isOffscreenRequest,
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./messages.ts";
import { ensureOffscreenDocument } from "./offscreen-lifecycle.ts";
import type { DirectSignalDelivery } from "../direct/protocol.ts";

export interface DirectTransport {
  startTestTransfer(input: {
    transferId: string;
    recipientDeviceId: string;
  }): Promise<void>;
  startClipboardTransfer?: (input: {
    transferId: string;
    recipientDeviceId: string;
    manifest: string;
    encryptedChunks: readonly string[];
  }) => Promise<void>;
  handleSignal(signal: DirectSignalDelivery): Promise<void>;
  sendClipboardVerified?: (input: {
    transferId: string;
    plaintextByteLength: number;
  }) => Promise<void>;
  cancelTransfer(transferId: string, reason?: string): Promise<void>;
  cancelAll(reason?: string): Promise<void>;
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
    (candidate.type === "DIRECT_START_RESULT" ||
      candidate.type === "DIRECT_START_CLIPBOARD_RESULT" ||
      candidate.type === "DIRECT_HANDLE_SIGNAL_RESULT" ||
      candidate.type === "DIRECT_SEND_CLIPBOARD_VERIFIED_RESULT" ||
      candidate.type === "DIRECT_CANCEL_RESULT" ||
      candidate.type === "DIRECT_CANCEL_ALL_RESULT" ||
      candidate.type === "ERROR")
  );
}

export class OffscreenDirectTransport implements DirectTransport {
  private readonly api: RuntimeMessagingApi;
  private readonly ensureDocument: () => Promise<void>;

  constructor(
    api: RuntimeMessagingApi = chrome,
    ensureDocument: () => Promise<void> = () => ensureOffscreenDocument(),
  ) {
    this.api = api;
    this.ensureDocument = ensureDocument;
  }

  async startTestTransfer(input: {
    transferId: string;
    recipientDeviceId: string;
  }): Promise<void> {
    await this.send({
      type: "DIRECT_START_TEST",
      transferId: input.transferId,
      remoteDeviceId: input.recipientDeviceId,
    });
  }

  async handleSignal(signal: DirectSignalDelivery): Promise<void> {
    await this.send({ type: "DIRECT_HANDLE_SIGNAL", signal });
  }

  async startClipboardTransfer(input: {
    transferId: string;
    recipientDeviceId: string;
    manifest: string;
    encryptedChunks: readonly string[];
  }): Promise<void> {
    await this.send({
      type: "DIRECT_START_CLIPBOARD",
      transferId: input.transferId,
      remoteDeviceId: input.recipientDeviceId,
      manifest: input.manifest,
      encryptedChunks: [...input.encryptedChunks],
    });
  }

  async sendClipboardVerified(input: {
    transferId: string;
    plaintextByteLength: number;
  }): Promise<void> {
    await this.send({
      type: "DIRECT_SEND_CLIPBOARD_VERIFIED",
      transferId: input.transferId,
      plaintextByteLength: input.plaintextByteLength,
    });
  }

  async cancelTransfer(transferId: string, reason?: string): Promise<void> {
    await this.send({ type: "DIRECT_CANCEL", transferId, ...(reason ? { reason } : {}) });
  }

  async cancelAll(reason?: string): Promise<void> {
    await this.send({ type: "DIRECT_CANCEL_ALL", ...(reason ? { reason } : {}) });
  }

  private async send(
    input: Pick<
      OffscreenRequest,
      | "type" | "transferId" | "remoteDeviceId" | "signal" | "reason"
      | "manifest" | "encryptedChunks" | "plaintextByteLength"
    >,
  ): Promise<void> {
    try {
      await this.ensureDocument();
    } catch {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct transport offscreen document could not be created",
      );
    }
    const message: OffscreenRequest = {
      source: RUNTIME_SOURCE,
      target: OFFSCREEN_SOURCE,
      requestId: requestId(),
      ...input,
    };
    if (!isOffscreenRequest(message)) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct transport request is invalid",
      );
    }
    let rawResponse: unknown;
    try {
      rawResponse = await this.api.runtime.sendMessage(message);
    } catch {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct transport offscreen document did not respond",
      );
    }
    if (!isResponse(rawResponse) || rawResponse.requestId !== message.requestId) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct transport returned an invalid response",
      );
    }
    if (rawResponse.type === "ERROR") {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        rawResponse.error?.message ?? "The direct transport operation failed",
      );
    }
  }
}
