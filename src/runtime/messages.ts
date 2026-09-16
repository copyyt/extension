import type { IUser } from "../interfaces/user.interface.ts";
import type { ClipboardItemEnvelope } from "../crypto/crypto-core.ts";
import type { RuntimeErrorCode } from "./errors.ts";

export const RUNTIME_SOURCE = "service-worker" as const;
export const POPUP_SOURCE = "popup" as const;
export const OFFSCREEN_SOURCE = "offscreen" as const;

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
  onboarding: {
    state: OnboardingState;
    bootstrapEligible: boolean;
    pairing?: PairingStatus;
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
}

export interface AuthenticatedRuntimeResult {
  message: string;
  user: IUser;
}

export type RuntimeCommand =
  | { type: "runtime:get-status" }
  | { type: "runtime:send-current-clipboard" }
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

export interface OffscreenRequest {
  source: typeof RUNTIME_SOURCE;
  target: typeof OFFSCREEN_SOURCE;
  requestId: string;
  type: "READ_TEXT" | "WRITE_TEXT" | "PING";
  text?: string;
}

export interface OffscreenResponse {
  source: typeof OFFSCREEN_SOURCE;
  target: typeof RUNTIME_SOURCE;
  requestId: string;
  type: "READ_TEXT_RESULT" | "WRITE_TEXT_RESULT" | "PONG" | "ERROR";
  text?: string;
  error?: {
    code: "CLIPBOARD_READ_FAILED" | "CLIPBOARD_WRITE_FAILED";
    message: string;
  };
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
  return (
    candidate.source === RUNTIME_SOURCE &&
    candidate.target === OFFSCREEN_SOURCE &&
    typeof candidate.requestId === "string" &&
    (candidate.type === "READ_TEXT" ||
      candidate.type === "WRITE_TEXT" ||
      candidate.type === "PING")
  );
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
