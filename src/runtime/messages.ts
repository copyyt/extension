import type { IUser } from "../interfaces/user.interface.ts";
import type { ClipboardItemEnvelope } from "../crypto/crypto-core.ts";
import {
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import type { RuntimeErrorCode } from "./errors.ts";
import type { SyncPreferences } from "./sync-preferences.ts";
import { MAX_CLIPBOARD_PLAINTEXT_BYTES } from "../clipboard/limits.ts";

export const RUNTIME_SOURCE = "service-worker" as const;
export const POPUP_SOURCE = "popup" as const;
export const OFFSCREEN_SOURCE = "offscreen" as const;

// Transport guard for plaintext crossing the extension messaging boundary.
// This does not add a field to the encrypted Copyyt protocol.
export const MAX_CLIPBOARD_TEXT_BYTES = MAX_CLIPBOARD_PLAINTEXT_BYTES;

export type ClipboardWatchState = "stopped" | "starting" | "watching" | "error";

export type RuntimeConnectionState =
  | "signed-out"
  | "connecting"
  | "account-authenticated"
  | "device-authenticating"
  | "ready"
  | "error";

export type DeviceRegistrationState =
  | "unknown"
  | "not-registered"
  | "registered";

export type DeviceTrustState =
  | "unknown"
  | "root"
  | "verified"
  | "unverified"
  | "revoked";

export type OnboardingState =
  | "unknown"
  | "bootstrap-eligible"
  | "pairing-required"
  | "pairing-ready"
  | "waiting-for-approval"
  | "complete";

export interface PairingStatus {
  role: "approver" | "pending";
  fingerprint: string;
  approverDeviceId: string;
  pendingDeviceId: string;
  pendingDeviceName?: string;
  pendingPlatform?: string;
}

export interface RuntimeStatus {
  connectionState: RuntimeConnectionState;
  signedIn: boolean;
  user?: IUser;
  device: {
    deviceId?: string;
    keyVersion?: number;
    registration: DeviceRegistrationState;
    trustState: DeviceTrustState;
  };
  socket: {
    connected: boolean;
    deviceAuthenticated: boolean;
  };
  /** Transport authentication is separate from permission to sync clipboard data. */
  syncReady: boolean;
  /** Device-local clipboard participation preferences. */
  syncPreferences: SyncPreferences;
  clipboardWatch?: ClipboardWatchState;
  lastAutoSyncAt?: string;
  lastAutoSyncError?: {
    code: RuntimeErrorCode;
    message: string;
    at: string;
  };
  /** Encrypted-envelope metadata only; no decrypted image bytes are exposed. */
  pendingAssistedImages?: PendingAssistedImageSummary[];
  onboarding: {
    state: OnboardingState;
    bootstrapEligible: boolean;
    pairing?: PairingStatus;
    error?: {
      code: RuntimeErrorCode;
      message: string;
    };
  };
  lastSyncError?: {
    code: RuntimeErrorCode;
    message: string;
    at: string;
  };
  lastConnectionError?: {
    code: RuntimeErrorCode;
    message: string;
    at: string;
  };
  /** Diagnostic only: this is never used as protocol or trust authority. */
  lastRecoveredAt?: string;
  lastRecoveryReason?: string;
}

export interface PendingAssistedImageSummary {
  itemId: string;
  sourceDeviceId: string;
  sourceDeviceName?: string;
  receivedAt: string;
  expiresAt: string;
  hasPng: true;
}

/** The transient, JSON-safe response for an explicit assisted image copy. */
export interface PendingAssistedImageCopyResult {
  itemId: string;
  pngBase64: string;
}

export interface AuthenticatedRuntimeResult {
  message: string;
  user: IUser;
}

export type RuntimeCommand =
  | { type: "runtime:get-status" }
  | {
      type: "runtime:set-sync-preferences";
      sendEnabled: boolean;
      receiveEnabled: boolean;
    }
  | { type: "runtime:send-current-clipboard" }
  | { type: "runtime:copy-pending-image"; itemId: string }
  | { type: "runtime:complete-pending-image"; itemId: string }
  | { type: "runtime:release-pending-image"; itemId: string }
  | { type: "runtime:bootstrap-trust-anchor" }
  | { type: "runtime:refresh-onboarding" }
  | {
      type: "runtime:approve-pending-device";
      pendingDeviceId: string;
      confirmedFingerprint: string;
    }
  | {
      type: "runtime:confirm-paired-approver";
      approverDeviceId: string;
      confirmedFingerprint: string;
    }
  | { type: "runtime:auth-google"; googleToken: string }
  | {
      type: "runtime:auth-passwordless";
      email: string;
    }
  | {
      type: "runtime:auth-verify-email";
      email: string;
      name?: string;
      code: number;
    }
  | { type: "runtime:auth-resend-email-otp"; email: string }
  | { type: "runtime:auth-refresh" }
  | { type: "runtime:logout" }
  | { type: "runtime:test-clipboard"; marker: string };

export interface RuntimeRequest {
  source: typeof POPUP_SOURCE;
  target: typeof RUNTIME_SOURCE;
  requestId: string;
  command: RuntimeCommand;
}

export interface RuntimeResponse<T = unknown> {
  source: typeof RUNTIME_SOURCE;
  target: typeof POPUP_SOURCE;
  requestId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: RuntimeErrorCode;
    message: string;
  };
}

export interface RuntimeStatusBroadcast {
  source: typeof RUNTIME_SOURCE;
  target: typeof POPUP_SOURCE;
  type: "runtime:status";
  status: RuntimeStatus;
}

export function isSyncPreferencesCommand(
  value: unknown,
): value is Extract<RuntimeCommand, { type: "runtime:set-sync-preferences" }> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    type?: unknown;
    sendEnabled?: unknown;
    receiveEnabled?: unknown;
  };
  return (
    candidate.type === "runtime:set-sync-preferences" &&
    typeof candidate.sendEnabled === "boolean" &&
    typeof candidate.receiveEnabled === "boolean"
  );
}

export interface OffscreenRequest {
  source: typeof RUNTIME_SOURCE;
  target: typeof OFFSCREEN_SOURCE;
  requestId: string;
  type:
    | "READ_TEXT"
    | "WRITE_TEXT"
    | "READ_PAYLOAD"
    | "WRITE_PAYLOAD"
    | "REBASELINE_FROM_CLIPBOARD"
    | "WATCH_START"
    | "WATCH_STOP"
    | "PING";
  text?: string;
  payload?: ClipboardPayloadV1;
  resetBaseline?: boolean;
}

export interface OffscreenResponse {
  source: typeof OFFSCREEN_SOURCE;
  target: typeof RUNTIME_SOURCE;
  requestId: string;
  type:
    | "READ_TEXT_RESULT"
    | "WRITE_TEXT_RESULT"
    | "READ_PAYLOAD_RESULT"
    | "WRITE_PAYLOAD_RESULT"
    | "REBASELINE_FROM_CLIPBOARD_RESULT"
    | "WATCH_START_RESULT"
    | "WATCH_STOP_RESULT"
    | "PONG"
    | "ERROR";
  text?: string;
  error?: {
    code: "CLIPBOARD_READ_FAILED" | "CLIPBOARD_WRITE_FAILED";
    message: string;
  };
  payload?: ClipboardPayloadV1;
}

export interface TypedOffscreenClipboardObservation {
  source: typeof OFFSCREEN_SOURCE;
  target: typeof RUNTIME_SOURCE;
  type: "CLIPBOARD_CHANGED";
  payload: ClipboardPayloadV1;
  text?: never;
}

export interface LegacyOffscreenClipboardObservation {
  source: typeof OFFSCREEN_SOURCE;
  target: typeof RUNTIME_SOURCE;
  type: "CLIPBOARD_CHANGED";
  text: string;
  payload?: never;
}

export type OffscreenClipboardObservation =
  | TypedOffscreenClipboardObservation
  | LegacyOffscreenClipboardObservation;

function isClipboardTextWithinLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_CLIPBOARD_TEXT_BYTES;
}

export function isClipboardText(value: unknown): value is string {
  return typeof value === "string" && isClipboardTextWithinLimit(value);
}

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RuntimeRequest>;
  return (
    candidate.source === POPUP_SOURCE &&
    candidate.target === RUNTIME_SOURCE &&
    typeof candidate.requestId === "string" &&
    Boolean(candidate.command && typeof candidate.command === "object")
  );
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OffscreenRequest>;
  const validRequestHeader =
    candidate.source === RUNTIME_SOURCE &&
    candidate.target === OFFSCREEN_SOURCE &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    (candidate.type === "READ_TEXT" ||
      candidate.type === "WRITE_TEXT" ||
      candidate.type === "READ_PAYLOAD" ||
      candidate.type === "WRITE_PAYLOAD" ||
      candidate.type === "REBASELINE_FROM_CLIPBOARD" ||
      candidate.type === "WATCH_START" ||
      candidate.type === "WATCH_STOP" ||
      candidate.type === "PING");
  if (!validRequestHeader) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  const type = candidate.type;
  const expectedKeys =
    type === "WRITE_TEXT"
      ? ["source", "target", "requestId", "type", "text"]
      : type === "WRITE_PAYLOAD"
        ? ["source", "target", "requestId", "type", "payload"]
        : type === "WATCH_START" && candidate.resetBaseline !== undefined
          ? ["source", "target", "requestId", "type", "resetBaseline"]
          : ["source", "target", "requestId", "type"];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  ) {
    return false;
  }
  if (type === "WRITE_TEXT") return isClipboardText(candidate.text);
  if (type === "WRITE_PAYLOAD") {
    try {
      validateClipboardPayloadV1(candidate.payload);
      return true;
    } catch {
      return false;
    }
  }
  return (
    type !== "WATCH_START" ||
    candidate.resetBaseline === undefined ||
    typeof candidate.resetBaseline === "boolean"
  );
}

export function isOffscreenClipboardObservation(
  value: unknown,
): value is OffscreenClipboardObservation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OffscreenClipboardObservation>;
  if (
    candidate.source === OFFSCREEN_SOURCE &&
    candidate.target === RUNTIME_SOURCE &&
    candidate.type === "CLIPBOARD_CHANGED"
  ) {
    const keys = Reflect.ownKeys(value);
    const hasText = Object.prototype.hasOwnProperty.call(value, "text");
    const hasPayload = Object.prototype.hasOwnProperty.call(value, "payload");
    if (hasText && hasPayload) {
      return false;
    }
    if (hasPayload) {
      try {
        validateClipboardPayloadV1(candidate.payload);
      } catch {
        return false;
      }
      return (
        keys.length === 4 &&
        keys.every(
          (key) =>
            typeof key === "string" &&
            ["source", "target", "type", "payload"].includes(key),
        )
      );
    }
    return (
      keys.length === 4 &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          ["source", "target", "type", "text"].includes(key),
      ) &&
      isClipboardText(candidate.text)
    );
  }
  return false;
}

export function isClipboardEnvelope(value: unknown): value is ClipboardItemEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ClipboardItemEnvelope>;
  return (
    typeof candidate.itemId === "string" &&
    candidate.itemId.length > 0 &&
    typeof candidate.sourceDeviceId === "string" &&
    typeof candidate.sourceKeyVersion === "number" &&
    typeof candidate.sourceSignature === "string" &&
    candidate.protocolVersion === 1 &&
    typeof candidate.contentType === "string" &&
    typeof candidate.ciphertext === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.expiresAt === "string" &&
    Array.isArray(candidate.recipients) &&
    candidate.recipients.every(
      (recipient) =>
        Boolean(recipient) &&
        typeof recipient.deviceId === "string" &&
        typeof recipient.deviceKeyVersion === "number" &&
        typeof recipient.wrapNonce === "string" &&
        typeof recipient.wrappedContentKey === "string",
    )
  );
}

export function envelopeFromSocketPayload(value: unknown): ClipboardItemEnvelope | null {
  if (isClipboardEnvelope(value)) {
    return value;
  }
  if (value && typeof value === "object" && "envelope" in value) {
    const envelope = (value as { envelope?: unknown }).envelope;
    return isClipboardEnvelope(envelope) ? envelope : null;
  }
  return null;
}
