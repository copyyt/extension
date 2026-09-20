import { CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY } from "../clipboard/capabilities.ts";
import {
  AES_GCM_TAG_BYTES,
  DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES,
} from "../clipboard/limits.ts";

export const DIRECT_TRANSPORT_CAPABILITY =
  CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY;
export const DIRECT_DATA_CHANNEL_LABEL = "copyyt-direct-v1" as const;

export const DIRECT_CHUNK_SIZE = 32 * 1024;
export const DIRECT_BUFFER_LOW_THRESHOLD = 256 * 1024;
export const DIRECT_BUFFER_HIGH_WATER = 1024 * 1024;
export const DIRECT_MAX_CONCURRENT_TRANSFERS = 4;
export const DIRECT_CONNECTION_TIMEOUT_MS = 15_000;
export const DIRECT_TRANSFER_TIMEOUT_MS = 30_000;
export const DIRECT_CLEANUP_TIMEOUT_MS = 5_000;
export const DIRECT_TEST_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const DIRECT_MAX_TEST_PAYLOAD_BYTES = DIRECT_TEST_PAYLOAD_BYTES;
export const DIRECT_MAX_ICE_CANDIDATES = 128;
export const DIRECT_CLIPBOARD_PROTOCOL = "copyyt-direct-clipboard-v1" as const;
export const DIRECT_CLIPBOARD_CONTENT_TYPE =
  "application/vnd.copyyt.clipboard-bundle+json" as const;
export { DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES };
export const DIRECT_APPLICATION_FRAME_INDEX_BYTES = 4;
export const DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE =
  DIRECT_CHUNK_SIZE - DIRECT_APPLICATION_FRAME_INDEX_BYTES - AES_GCM_TAG_BYTES;
export const DIRECT_APPLICATION_MAX_FRAME_BYTES = DIRECT_CHUNK_SIZE;

export type DirectSignalKind =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "cancel";

export interface DirectIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface DirectSignalBody {
  kind: DirectSignalKind;
  sdp?: string;
  candidate?: DirectIceCandidate;
  reason?: string;
}

export interface DirectSignalRequest extends DirectSignalBody {
  transferId: string;
  recipientDeviceId: string;
}

export interface DirectSignalDelivery extends DirectSignalBody {
  transferId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
}

export type DirectTransferState =
  | "connecting"
  | "open"
  | "sending"
  | "receiving"
  | "verified"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DirectManagerEvent =
  | {
      kind: "signal";
      transferId: string;
      remoteDeviceId: string;
      signal: DirectSignalBody;
    }
  | {
      kind: "status";
      transferId: string;
      remoteDeviceId: string;
      state: DirectTransferState;
      bytesSent?: number;
      bytesReceived?: number;
      byteLength?: number;
      sha256?: string;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
    }
  | {
      kind: "application-frame";
      transferId: string;
      remoteDeviceId: string;
      frame:
        | { type: "clipboard-secure-start"; manifest: string }
        | { type: "clipboard-secure-chunk"; data: string };
    };

export interface DirectTransportStatus {
  transferId: string;
  remoteDeviceId: string;
  state: DirectTransferState;
  bytesSent?: number;
  bytesReceived?: number;
  byteLength?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isDirectSignalBody(value: unknown): value is DirectSignalBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DirectSignalBody>;
  if (
    candidate.kind !== "offer" &&
    candidate.kind !== "answer" &&
    candidate.kind !== "ice-candidate" &&
    candidate.kind !== "cancel"
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  const expected = ["kind"];
  if (candidate.kind === "offer" || candidate.kind === "answer") {
    expected.push("sdp");
    if (keys.length !== expected.length || typeof candidate.sdp !== "string") {
      return false;
    }
  } else if (candidate.kind === "ice-candidate") {
    expected.push("candidate");
    if (
      keys.length !== expected.length ||
      !isDirectIceCandidate(candidate.candidate)
    ) {
      return false;
    }
  } else {
    if (candidate.reason !== undefined) expected.push("reason");
    if (
      keys.length > 2 ||
      (keys.length === 2 &&
        (typeof candidate.reason !== "string" ||
          !keys.includes("reason")))
    ) {
      return false;
    }
  }
  return keys.every((key) => typeof key === "string" && expected.includes(key));
}

export function isDirectIceCandidate(
  value: unknown,
): value is DirectIceCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DirectIceCandidate>;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        ![
          "candidate",
          "sdpMid",
          "sdpMLineIndex",
          "usernameFragment",
        ].includes(key),
    ) ||
    typeof candidate.candidate !== "string" ||
    (candidate.sdpMid !== undefined &&
      candidate.sdpMid !== null &&
      typeof candidate.sdpMid !== "string") ||
    (candidate.sdpMLineIndex !== undefined &&
      candidate.sdpMLineIndex !== null &&
      (!Number.isSafeInteger(candidate.sdpMLineIndex) ||
        candidate.sdpMLineIndex < 0)) ||
    (candidate.usernameFragment !== undefined &&
      candidate.usernameFragment !== null &&
      typeof candidate.usernameFragment !== "string")
  ) {
    return false;
  }
  return true;
}

export function isDirectSignalDelivery(
  value: unknown,
): value is DirectSignalDelivery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DirectSignalDelivery>;
  const body: DirectSignalBody = {
    kind: candidate.kind as DirectSignalKind,
    ...(candidate.sdp !== undefined ? { sdp: candidate.sdp } : {}),
    ...(candidate.candidate !== undefined
      ? { candidate: candidate.candidate }
      : {}),
    ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
  };
  return (
    isUuid(candidate.transferId) &&
    isUuid(candidate.sourceDeviceId) &&
    Number.isSafeInteger(candidate.sourceKeyVersion) &&
    (candidate.sourceKeyVersion as number) > 0 &&
    isDirectSignalBody(body)
  );
}

export function deterministicTestBytes(
  transferId: string,
  byteLength = DIRECT_TEST_PAYLOAD_BYTES,
): Uint8Array {
  if (!isUuid(transferId)) throw new Error("Invalid direct transfer ID");
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > DIRECT_MAX_TEST_PAYLOAD_BYTES
  ) {
    throw new Error("Invalid direct test payload length");
  }

  const bytes = new Uint8Array(byteLength);
  let state = 0x811c9dc5;
  for (const character of transferId) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 0x01000193);
  }
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= index;
    state = Math.imul(state, 0x01000193);
    state ^= state >>> 13;
    state = Math.imul(state, 0x5bd1e995);
    bytes[index] = state & 0xff;
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
