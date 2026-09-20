import type { IUser } from "../interfaces/user.interface.ts";
import type { ClipboardItemEnvelope } from "../crypto/crypto-core.ts";
import {
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import type { RuntimeErrorCode } from "./errors.ts";
import type { SyncPreferences } from "./sync-preferences.ts";
import { MAX_CLIPBOARD_PLAINTEXT_BYTES } from "../clipboard/limits.ts";
import {
  isDirectSignalBody,
  isDirectSignalDelivery,
  isUuid,
  type DirectManagerEvent,
  type DirectSignalDelivery,
  type DirectTransportStatus,
} from "../direct/protocol.ts";

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
  /** Development-only direct transport diagnostics; never clipboard bytes. */
  directTargets?: DirectTarget[];
  directTransfers?: DirectTransportStatus[];
}

export interface DirectTarget {
  deviceId: string;
  name: string;
  platform: string;
  keyVersion: number;
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
  | { type: "runtime:test-clipboard"; marker: string }
  | { type: "runtime:start-direct-test"; recipientDeviceId: string }
  | { type: "runtime:cancel-direct-test"; transferId: string };

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
    | "PING"
    | "DIRECT_START_TEST"
    | "DIRECT_START_CLIPBOARD"
    | "DIRECT_HANDLE_SIGNAL"
    | "DIRECT_SEND_CLIPBOARD_VERIFIED"
    | "DIRECT_CANCEL"
    | "DIRECT_CANCEL_ALL";
  text?: string;
  payload?: ClipboardPayloadV1;
  resetBaseline?: boolean;
  transferId?: string;
  remoteDeviceId?: string;
  signal?: DirectSignalDelivery;
  manifest?: string;
  encryptedChunks?: string[];
  plaintextByteLength?: number;
  reason?: string;
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
    | "DIRECT_START_RESULT"
    | "DIRECT_START_CLIPBOARD_RESULT"
    | "DIRECT_HANDLE_SIGNAL_RESULT"
    | "DIRECT_SEND_CLIPBOARD_VERIFIED_RESULT"
    | "DIRECT_CANCEL_RESULT"
    | "DIRECT_CANCEL_ALL_RESULT"
    | "ERROR";
  text?: string;
  error?: {
    code:
      | "CLIPBOARD_READ_FAILED"
      | "CLIPBOARD_WRITE_FAILED"
      | "DIRECT_TRANSPORT_FAILED";
    message: string;
  };
  payload?: ClipboardPayloadV1;
  accepted?: true;
  transferId?: string;
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

export interface OffscreenDirectTransportEvent {
  source: typeof OFFSCREEN_SOURCE;
  target: typeof RUNTIME_SOURCE;
  type: "DIRECT_EVENT";
  event: DirectManagerEvent;
}

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
      candidate.type === "PING" ||
      candidate.type === "DIRECT_START_TEST" ||
      candidate.type === "DIRECT_START_CLIPBOARD" ||
      candidate.type === "DIRECT_HANDLE_SIGNAL" ||
      candidate.type === "DIRECT_SEND_CLIPBOARD_VERIFIED" ||
      candidate.type === "DIRECT_CANCEL" ||
      candidate.type === "DIRECT_CANCEL_ALL");
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
          : type === "DIRECT_START_TEST"
            ? ["source", "target", "requestId", "type", "transferId", "remoteDeviceId"]
            : type === "DIRECT_START_CLIPBOARD"
              ? ["source", "target", "requestId", "type", "transferId", "remoteDeviceId", "manifest", "encryptedChunks"]
              : type === "DIRECT_HANDLE_SIGNAL"
                ? ["source", "target", "requestId", "type", "signal"]
                : type === "DIRECT_SEND_CLIPBOARD_VERIFIED"
                  ? ["source", "target", "requestId", "type", "transferId", "plaintextByteLength"]
                  : type === "DIRECT_CANCEL"
                    ? candidate.reason === undefined
                      ? ["source", "target", "requestId", "type", "transferId"]
                      : ["source", "target", "requestId", "type", "transferId", "reason"]
                    : type === "DIRECT_CANCEL_ALL"
                      ? candidate.reason === undefined
                        ? ["source", "target", "requestId", "type"]
                        : ["source", "target", "requestId", "type", "reason"]
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
  if (type === "DIRECT_START_TEST") {
    return isUuid(candidate.transferId) &&
      isUuid(candidate.remoteDeviceId);
  }
  if (type === "DIRECT_START_CLIPBOARD") {
    return (
      isUuid(candidate.transferId) &&
      isUuid(candidate.remoteDeviceId) &&
      typeof candidate.manifest === "string" &&
      candidate.manifest.length > 0 &&
      Array.isArray(candidate.encryptedChunks) &&
      candidate.encryptedChunks.every((chunk) => typeof chunk === "string")
    );
  }
  if (type === "DIRECT_HANDLE_SIGNAL") {
    return isDirectSignalDelivery(candidate.signal);
  }
  if (type === "DIRECT_CANCEL") {
    return isUuid(candidate.transferId) &&
      (candidate.reason === undefined ||
        (typeof candidate.reason === "string" && candidate.reason.length <= 256));
  }
  if (type === "DIRECT_SEND_CLIPBOARD_VERIFIED") {
    return (
      isUuid(candidate.transferId) &&
      Number.isSafeInteger(candidate.plaintextByteLength) &&
      (candidate.plaintextByteLength as number) > 0
    );
  }
  if (type === "DIRECT_CANCEL_ALL") {
    return candidate.reason === undefined ||
      (typeof candidate.reason === "string" && candidate.reason.length <= 256);
  }
  return (
    type !== "WATCH_START" ||
    candidate.resetBaseline === undefined ||
    typeof candidate.resetBaseline === "boolean"
  );
}

export function isOffscreenDirectTransportEvent(
  value: unknown,
): value is OffscreenDirectTransportEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OffscreenDirectTransportEvent>;
  if (
    candidate.source !== OFFSCREEN_SOURCE ||
    candidate.target !== RUNTIME_SOURCE ||
    candidate.type !== "DIRECT_EVENT" ||
    !candidate.event ||
    typeof candidate.event !== "object"
  ) {
    return false;
  }
  const event = candidate.event as Partial<DirectManagerEvent>;
  if (
    event.kind === "signal" &&
    typeof event.transferId === "string" &&
    isUuid(event.remoteDeviceId) &&
    isDirectSignalBody(event.signal)
  ) {
    return true;
  }
  if (
    event.kind === "application-frame" &&
    typeof event.transferId === "string" &&
    isUuid(event.remoteDeviceId) &&
    event.frame &&
    typeof event.frame === "object"
  ) {
    const frame = event.frame as {
      type?: unknown;
      manifest?: unknown;
      data?: unknown;
    };
    return (
      (frame.type === "clipboard-secure-start" &&
        typeof frame.manifest === "string") ||
      (frame.type === "clipboard-secure-chunk" && typeof frame.data === "string")
    );
  }
  return (
    event.kind === "status" &&
    typeof event.transferId === "string" &&
    isUuid(event.remoteDeviceId) &&
    typeof event.state === "string"
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
