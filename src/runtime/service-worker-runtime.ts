import { isAxiosError, type AxiosResponse } from "axios";
import { jwtDecode } from "jwt-decode";
import {
  clearDeviceIdentity,
  computePairingFingerprint,
  decryptClipboardItemBytes,
  decryptDirectClipboardTransfer,
  encryptClipboardItem,
  getDeviceIdentity,
  getOrCreateDeviceIdentity,
  exportRecoveryPrivateKey,
  sealRecoveryCredential,
  signDeviceApproval,
  signDeviceManagement,
  signSocketChallenge,
  type ClipboardItemEnvelope,
  type DeviceIdentity,
  type DirectClipboardStartV1,
  prepareDirectClipboardTransfer,
  verifyDirectClipboardManifestSignature,
} from "../crypto/index.ts";
import { bytesToBase64 } from "../crypto/bytes.ts";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  clipboardPayloadFromPlainText,
  decodeClipboardBundleV1,
  decodeClipboardPlainText,
  findPlainTextRepresentation,
  getPngBytes,
  getPngRepresentation,
  projectClipboardPayloadToText,
  validateClipboardPayloadV1,
  type ClipboardBundleV1Bytes,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import {
  CLIPBOARD_RECEIVE_CAPABILITIES,
  CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY,
  CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
  validClipboardCapabilities,
} from "../clipboard/capabilities.ts";
import {
  ClipboardWirePayloadTooLargeError,
  selectClipboardDeliveryRoutes,
  type ClipboardWireRecipient,
} from "../clipboard/wire-payload.ts";
import {
  isDirectClipboardStartV1,
  type PreparedDirectClipboardTransfer,
} from "../crypto/direct-clipboard.ts";
import {
  registerCurrentDevice,
  recoverCurrentDevice,
  type ApproveDeviceRequest,
  type DeviceManagementRequest,
  type DeviceRegistrationApi,
  type RegisteredDeviceListResponse,
  type RegisteredDeviceResponse,
} from "../crypto/device-registration.ts";
import { DeviceIdentityCorruptError } from "../crypto/key-store.ts";
import type { DeviceApprovalCertificate } from "../crypto/crypto-core.ts";
import type {
  ClientTrustStore,
  ClientVerifiedDevice,
  LocalDeviceRecord,
} from "../crypto/trust-store.ts";
import { TrustStoreError } from "../crypto/trust-store.ts";
import {
  isDirectSignalDelivery,
  type DirectManagerEvent,
  type DirectSignalRequest,
  type DirectTransportStatus,
} from "../direct/protocol.ts";
import type {
  SignInResponse,
  ILoginResponse,
  IVerifyEmail,
} from "../interfaces/auth.interface.ts";
import type { IUser } from "../interfaces/user.interface.ts";
import {
  asRuntimeError,
  RuntimeError,
  type RuntimeErrorCode,
} from "./errors.ts";
import {
  envelopeFromSocketPayload,
  isClipboardText,
  isOffscreenClipboardObservation,
  isOffscreenDirectTransportEvent,
  isSyncPreferencesCommand,
  isRuntimeRequest,
  POPUP_SOURCE,
  RUNTIME_SOURCE,
  type AccountPlan,
  type AuthenticatedRuntimeResult,
  type ManagedDevice,
  type RecoveryCredentialResult,
  type RuntimeCommand,
  type RuntimeResponse,
  type RuntimeStatus,
  type RuntimeStatusBroadcast,
  type PendingAssistedImageCopyResult,
  type PendingAssistedImageSummary,
} from "./messages.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import type { DirectTransport } from "./direct-transport.ts";
import {
  InMemoryAssistedPngSuppressionStore,
  InMemoryPendingAssistedImageStore,
  type AssistedPngSuppressionStore,
  type OutboundItemStore,
  type PendingAssistedImageStore,
  type ProcessedItemStore,
} from "./runtime-db.ts";
import {
  DEFAULT_SYNC_PREFERENCES,
  OFF_SYNC_PREFERENCES,
  isSyncPreferences,
  type SyncPreferences,
  type SyncPreferencesStore,
} from "./sync-preferences.ts";
import {
  isRuntimeSessionV2,
  type RuntimeSession,
  type SessionStore,
  type StatusStore,
} from "./session-store.ts";

export interface RuntimeApi {
  auth: {
    signInPasswordless(data: {
      email: string;
    }): Promise<AxiosResponse<ILoginResponse>>;
    googleSign(token: string): Promise<AxiosResponse<SignInResponse>>;
    verifyEmail(data: IVerifyEmail): Promise<AxiosResponse<SignInResponse>>;
    refreshTokens(refreshToken?: string): Promise<AxiosResponse<SignInResponse>>;
    logout(refreshToken?: string): Promise<AxiosResponse<unknown>>;
    resendEmailOtp(email: string): Promise<AxiosResponse<unknown>>;
    requestAccountResetCode(): Promise<AxiosResponse<unknown>>;
    resetAccount(code: number): Promise<AxiosResponse<unknown>>;
    requestAccountDeletionCode(): Promise<AxiosResponse<unknown>>;
    deleteAccount(code: number): Promise<AxiosResponse<unknown>>;
    updateProfile(
      name: string,
    ): Promise<AxiosResponse<{ message: string; user: IUser }>>;
    getPlan?(): Promise<AxiosResponse<AccountPlan>>;
    joinWaitlist?(platform: "ios"): Promise<AxiosResponse<{ joined: boolean }>>;
    waitlistStatus?(platform: "ios"): Promise<AxiosResponse<{ joined: boolean }>>;
  };
  devices: DeviceRegistrationApi & {
    listDevices(): Promise<AxiosResponse<RegisteredDeviceListResponse>>;
    revokeDevice(
      deviceId: string,
      request: DeviceManagementRequest,
    ): Promise<AxiosResponse<RegisteredDeviceResponse>>;
  };
}

export interface SocketLike {
  id?: string;
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

export interface SocketOptions {
  auth: { token: string };
  autoConnect: false;
  reconnection: true;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  timeout: number;
  transports?: ("websocket" | "polling")[];
}

export interface ConnectivityReconcileOptions {
  /** Dispose the current transport even when Socket.IO still reports it connected. */
  forceSocketRecycle?: boolean;
  /** Refresh the access token even when its locally decoded expiry is not near. */
  forceTokenRefresh?: boolean;
  /** Wait for device challenge authentication and transport readiness. */
  waitForReady?: boolean;
}

interface ConnectivityReconcileIntent {
  reason: string;
  options: ConnectivityReconcileOptions;
}

export interface RuntimeDependencies {
  socketUrl: string;
  appVersion: string;
  sessionStore: SessionStore;
  statusStore: StatusStore<RuntimeStatus>;
  trustStore: ClientTrustStore;
  clipboardAdapter: ClipboardAdapter;
  directTransport?: DirectTransport;
  processedItemStore: ProcessedItemStore;
  outboundItemStore: OutboundItemStore;
  pendingAssistedImageStore?: PendingAssistedImageStore;
  assistedPngSuppressionStore?: AssistedPngSuppressionStore;
  syncPreferencesStore: SyncPreferencesStore;
  apiFactory: (accessToken: string) => RuntimeApi;
  socketFactory: (url: string, options: SocketOptions) => SocketLike;
  identityLoader?: (userId: string) => Promise<DeviceIdentity | null>;
  identityCreator?: (userId: string) => Promise<DeviceIdentity>;
  registerDevice?: typeof registerCurrentDevice;
  recoverDevice?: typeof recoverCurrentDevice;
  clearIdentity?: typeof clearDeviceIdentity;
  exportRecoveryKey?: typeof exportRecoveryPrivateKey;
  sealRecoveryKey?: typeof sealRecoveryCredential;
  encrypt?: typeof encryptClipboardItem;
  decrypt?: typeof decryptClipboardItemBytes;
  prepareDirect?: typeof prepareDirectClipboardTransfer;
  decryptDirect?: typeof decryptDirectClipboardTransfer;
  signChallenge?: typeof signSocketChallenge;
  signApproval?: typeof signDeviceApproval;
  now?: () => Date;
  broadcastStatus?: (message: RuntimeStatusBroadcast) => Promise<void> | void;
  recoveryAlarm?: {
    ensure: () => Promise<void> | void;
    clear: () => Promise<void> | void;
  };
}

export {
  selectClipboardWirePayload,
  selectClipboardWirePayloads,
  selectClipboardDeliveryRoutes,
} from "../clipboard/wire-payload.ts";

const DEFAULT_STATUS: RuntimeStatus = {
  connectionState: "signed-out",
  signedIn: false,
  device: {
    registration: "unknown",
    trustState: "unknown",
  },
  socket: {
    connected: false,
    deviceAuthenticated: false,
  },
  syncReady: false,
  pendingAssistedImages: [],
  directTargets: [],
  directTransfers: [],
  syncPreferences: { ...DEFAULT_SYNC_PREFERENCES },
  clipboardWatch: "stopped",
  onboarding: {
    state: "unknown",
    bootstrapEligible: false,
  },
};

const TOKEN_REFRESH_SKEW_MS = 60_000;
const STARTUP_CONNECTIVITY_KICK_TIMEOUT_MS = 250;
const CONNECTIVITY_RECONCILIATION_TIMEOUT_MS = 15_000;
const MAX_CONNECTIVITY_RECONCILIATION_FOLLOW_UPS = 2;
const LOGOUT_REQUEST_TIMEOUT_MS = 5_000;
const DIRECT_CLIPBOARD_TERMINAL_TOMBSTONE_TTL_MS = 5_000;
const DIRECT_SIGNAL_VALIDATION_TTL_MS = 15_000;
const DIRECT_SIGNAL_VALIDATION_MAX = 8;

export const LIVE_CLIPBOARD_TTL_MS = 60_000;
/** Minimum spacing of trust refreshes triggered by an unknown item source. */
export const UNKNOWN_SOURCE_REFRESH_MS = 10_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const ASSISTED_PNG_SUPPRESSION_TTL_MS = 15_000;

function parseStrictExpiry(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function isLiveExpiryWithinPolicy(expiresAt: number, now: number): boolean {
  return expiresAt <= now + LIVE_CLIPBOARD_TTL_MS + MAX_CLOCK_SKEW_MS;
}

function userFromSession(session: RuntimeSession): IUser {
  return { ...session.user };
}

function isLocallyVerified(
  device: LocalDeviceRecord | null,
): device is ClientVerifiedDevice {
  return device?.trustState === "root" || device?.trustState === "verified";
}

function isLocallyVerifiedStatus(status: RuntimeStatus): boolean {
  return (
    status.device.trustState === "root" ||
    status.device.trustState === "verified"
  );
}

function serverDevices(
  response: RegisteredDeviceListResponse,
): RegisteredDeviceResponse[] {
  if (Array.isArray(response)) return response;
  if ("devices" in response && Array.isArray(response.devices))
    return response.devices;
  if ("pendingDevices" in response && Array.isArray(response.pendingDevices))
    return response.pendingDevices;
  if ("data" in response && Array.isArray(response.data)) return response.data;
  throw new RuntimeError(
    "SOCKET_PUBLISH_FAILED",
    "The device list response is invalid",
  );
}

interface DeviceSnapshot {
  trustedDevices: RegisteredDeviceResponse[];
  pendingDevices: RegisteredDeviceResponse[];
  accountRoot: AccountRootResolution;
}

type AccountRootResolution =
  | { state: "available"; device: RegisteredDeviceResponse }
  | { state: "missing" }
  | { state: "ambiguous" };

type ServerDeviceState = "unknown" | "trusted" | "pending" | "revoked";

function trustedServerDevices(
  response: RegisteredDeviceListResponse,
): RegisteredDeviceResponse[] {
  return serverDevices(response).filter(
    (device) => isActiveServerDevice(device) && device.trustState === "trusted",
  );
}

function pendingServerDevices(
  response: RegisteredDeviceListResponse,
): RegisteredDeviceResponse[] {
  return serverDevices(response).filter(
    (device) => isActiveServerDevice(device) && device.trustState === "pending",
  );
}

function identityMatchesServerDevice(
  identity: DeviceIdentity,
  device: RegisteredDeviceResponse,
): boolean {
  return (
    identity.deviceId === device.deviceId &&
    identity.keyVersion === device.keyVersion &&
    identity.signingPublicKeyBase64 === device.signingPublicKey &&
    identity.encryptionPublicKeyBase64 === device.encryptionPublicKey
  );
}

function identityMatchesLocalDevice(
  identity: DeviceIdentity,
  device: Pick<
    LocalDeviceRecord,
    "deviceId" | "keyVersion" | "signingPublicKey" | "encryptionPublicKey"
  >,
): boolean {
  return (
    identity.deviceId === device.deviceId &&
    identity.keyVersion === device.keyVersion &&
    identity.signingPublicKeyBase64 === device.signingPublicKey &&
    identity.encryptionPublicKeyBase64 === device.encryptionPublicKey
  );
}

function isActiveServerDevice(device: RegisteredDeviceResponse): boolean {
  return device.revokedAt == null && device.trustState !== "revoked";
}

/**
 * The v1 account root is the one active trusted device without an approval
 * parent or certificate. Never infer it from collection ordering.
 */
function resolveAccountRoot(
  trustedDevices: RegisteredDeviceResponse[],
): AccountRootResolution {
  const candidates = trustedDevices.filter(
    (device) =>
      isActiveServerDevice(device) &&
      device.trustState === "trusted" &&
      device.approvedByDeviceId == null &&
      device.approvalSignature == null,
  );
  if (candidates.length === 1)
    return { state: "available", device: candidates[0] };
  return { state: candidates.length === 0 ? "missing" : "ambiguous" };
}

/**
 * This device is the account root and may approve new devices: either the
 * first device (trust on first use) or one restored with the offline
 * recovery credential after the previous root was removed.
 */
function isApprovingRoot(device: LocalDeviceRecord | null | undefined): boolean {
  return Boolean(
    device &&
      device.trustState === "root" &&
      (device.trustOrigin === "initial-tofu" || device.trustOrigin === "recovery"),
  );
}

/**
 * A user-facing reason for an unexpected failure: the backend's error
 * description, or the message of a local validation/trust error. Never the
 * raw text of arbitrary exceptions, which may be opaque or leak internals.
 */
function describeFailure(error: unknown): string | undefined {
  if (isAxiosError(error)) {
    const data = error.response?.data as
      | { description?: unknown; message?: unknown }
      | undefined;
    // Nest validation failures report `message` as an array of problems.
    const detail =
      typeof data?.description === "string"
        ? data.description
        : typeof data?.message === "string"
          ? data.message
          : Array.isArray(data?.message) &&
              data.message.every((item) => typeof item === "string")
            ? `The Copyyt server rejected the request: ${data.message.join("; ")}`
            : undefined;
    if (detail) return detail;
    return error.response
      ? `The Copyyt server rejected the request (HTTP ${error.response.status})`
      : "The Copyyt server could not be reached";
  }
  if (
    error instanceof Error &&
    (error.name === "TrustStoreError" ||
      error.name === "CryptoProtocolError" ||
      (error instanceof TypeError && /recovery credential|recovery private key/i.test(error.message)))
  ) {
    return error.message;
  }
  return undefined;
}

function accountRootError(root: AccountRootResolution): RuntimeError {
  return new RuntimeError(
    "PAIRING_FAILED",
    root.state === "missing"
      ? "The account root device is unavailable. Existing trusted devices can continue syncing, but new devices cannot be paired."
      : "The account root is ambiguous. Existing trusted devices can continue syncing, but new devices cannot be paired.",
  );
}

function requireAccountRoot(
  root: AccountRootResolution,
): RegisteredDeviceResponse {
  if (root.state === "available") return root.device;
  throw accountRootError(root);
}

export function findUniqueAccountRootCandidate(
  trustedDevices: RegisteredDeviceResponse[],
): RegisteredDeviceResponse {
  const root = resolveAccountRoot(trustedDevices);
  if (root.state === "available") return root.device;
  throw new RuntimeError(
    "PAIRING_FAILED",
    root.state === "missing"
      ? "Copyyt could not identify the account root device"
      : "Copyyt found multiple account root devices; pairing is blocked",
  );
}

function tokenNeedsRefresh(token: string, now: Date): boolean {
  try {
    const claims = jwtDecode<{ exp?: number }>(token);
    return (
      typeof claims.exp === "number" &&
      claims.exp * 1000 <= now.getTime() + TOKEN_REFRESH_SKEW_MS
    );
  } catch {
    // A token without a locally readable exp is still sent to the server. The
    // claim is used only as a renewal hint, never as authorization.
    return false;
  }
}

const KNOWN_REFRESH_CREDENTIAL_REJECTION_CODES = new Set([
  "refresh_token_invalid",
  "refresh_token_expired",
  "invalid_refresh_token",
  "expired_refresh_token",
  "invalid_or_expired_refresh_token",
]);

function backendErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  const candidates = [
    data,
    data && typeof data === "object"
      ? (data as { message?: unknown }).message
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
    if (!candidate || typeof candidate !== "object") continue;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function refreshFailureIsDefinitive(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  const status = (response as { status?: unknown }).status;
  if (status === 401) return true;
  const code = backendErrorCode(error);
  return (
    typeof code === "string" &&
    KNOWN_REFRESH_CREDENTIAL_REJECTION_CODES.has(code)
  );
}

function isAccessTokenRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  return (response as { status?: unknown }).status === 401;
}

function isRefreshTokenNotFound(error: unknown): boolean {
  return backendErrorCode(error) === "refresh_token_not_found";
}

function isSocketAuthenticationFailure(error: unknown): boolean {
  if (typeof error === "string")
    return /auth|unauthor|forbidden|token|jwt|credential|401|403|expired/i.test(
      error,
    );
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    data?: unknown;
  };
  const text = [candidate.message, candidate.code, candidate.data]
    .map((value) =>
      typeof value === "string"
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : "",
    )
    .join(" ")
    .toLowerCase();
  return /auth|unauthor|forbidden|token|jwt|credential|401|403|expired/.test(
    text,
  );
}

function isFatalLocalInitializationFailure(error: unknown): boolean {
  return error instanceof DeviceIdentityCorruptError || error instanceof TrustStoreError;
}

function isAccountPlan(value: unknown): value is AccountPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<AccountPlan>;
  return (
    (plan.plan === "free" || plan.plan === "pro") &&
    typeof plan.limits === "object" &&
    plan.limits !== null &&
    typeof plan.limits.images === "boolean" &&
    typeof plan.limits.directTransfer === "boolean" &&
    (plan.limits.maxDevices === null || typeof plan.limits.maxDevices === "number") &&
    typeof plan.beta === "object" &&
    plan.beta !== null &&
    typeof plan.beta.active === "boolean"
  );
}

function authResult(response: SignInResponse): AuthenticatedRuntimeResult {
  return { message: response.message, user: response.user };
}

function isAuthCommand(command: RuntimeCommand): boolean {
  return (
    command.type === "runtime:auth-google" ||
    command.type === "runtime:auth-passwordless" ||
    command.type === "runtime:auth-verify-email" ||
    command.type === "runtime:auth-resend-email-otp" ||
    command.type === "runtime:auth-refresh"
  );
}

function authRuntimeError(
  error: unknown,
  command: RuntimeCommand,
): RuntimeError {
  let backendCode: string | undefined;
  let backendDescription: string | undefined;

  if (isAxiosError(error)) {
    const payload = error.response?.data as
      | { message?: unknown }
      | undefined;
    const message = payload?.message;
    if (message && typeof message === "object") {
      const candidate = message as {
        code?: unknown;
        description?: unknown;
      };
      backendCode =
        typeof candidate.code === "string" ? candidate.code : undefined;
      backendDescription =
        typeof candidate.description === "string"
          ? candidate.description
          : undefined;
    }
  }

  switch (backendCode) {
    case "email_delivery_failed":
      return new RuntimeError(
        "EMAIL_DELIVERY_FAILED",
        backendDescription ??
          "We could not send the verification email. Please try again.",
      );
    case "invalid_or_expired_otp":
      return new RuntimeError(
        "OTP_INVALID",
        backendDescription ?? "The verification code is invalid or has expired",
      );
    case "google_subject_conflict":
      return new RuntimeError(
        "GOOGLE_SUBJECT_CONFLICT",
        backendDescription ??
          "This Google account is linked to a different Copyyt account",
      );
    case "google_email_required":
    case "google_email_unverified":
    case "google_token_invalid":
      return new RuntimeError(
        "GOOGLE_AUTH_FAILED",
        backendDescription ?? "Google sign-in could not be verified",
      );
  }

  switch (command.type) {
    case "runtime:auth-google":
      return new RuntimeError(
        "GOOGLE_AUTH_FAILED",
        "Google sign-in could not be verified",
      );
    case "runtime:auth-verify-email":
      return new RuntimeError(
        "OTP_INVALID",
        "The verification code is invalid or has expired",
      );
    case "runtime:auth-passwordless":
    case "runtime:auth-resend-email-otp":
      return new RuntimeError(
        "EMAIL_DELIVERY_FAILED",
        "We could not send the verification email. Please try again.",
      );
    default:
      return new RuntimeError(
        "AUTH_REQUIRED",
        "The Copyyt session could not be restored",
      );
  }
}

function isAcknowledgement(value: unknown, itemId: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === itemId;
  if (typeof value !== "object") return false;
  const candidate = value as {
    accepted?: unknown;
    ok?: unknown;
    itemId?: unknown;
    error?: unknown;
  };
  if (candidate.error) return false;
  if (candidate.accepted === false || candidate.ok === false) return false;
  return candidate.itemId === undefined || candidate.itemId === itemId;
}

function isDirectAcknowledgement(value: unknown, transferId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    accepted?: unknown;
    transferId?: unknown;
    error?: unknown;
  };
  return (
    candidate.accepted === true &&
    candidate.transferId === transferId &&
    !candidate.error
  );
}

function challengeParts(
  payload: unknown,
  fallbackSocketId: string,
): { socketId: string; challenge: string; userId?: string } | null {
  if (typeof payload === "string") {
    return { socketId: fallbackSocketId, challenge: payload };
  }
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    socketId?: unknown;
    challenge?: unknown;
    nonce?: unknown;
    userId?: unknown;
  };
  const socketId = candidate.socketId ?? fallbackSocketId;
  const challenge = candidate.challenge ?? candidate.nonce;
  if (typeof socketId !== "string" || typeof challenge !== "string")
    return null;
  return {
    socketId,
    challenge,
    ...(typeof candidate.userId === "string"
      ? { userId: candidate.userId }
      : {}),
  };
}

function commandFallbackErrorCode(command: RuntimeCommand): RuntimeErrorCode {
  switch (command.type) {
    case "runtime:set-sync-preferences":
      return "SYNC_PREFERENCES_INVALID";
    case "runtime:send-current-clipboard":
      return "SOCKET_PUBLISH_FAILED";
    case "runtime:test-clipboard":
      return "CLIPBOARD_WRITE_FAILED";
    case "runtime:start-direct-test":
    case "runtime:cancel-direct-test":
      return "DIRECT_TRANSPORT_FAILED";
    case "runtime:bootstrap-trust-anchor":
    case "runtime:export-recovery-credential":
    case "runtime:confirm-recovery-credential-saved":
    case "runtime:recover-device":
    case "runtime:list-devices":
    case "runtime:reset-device":
    case "runtime:request-account-reset-code":
    case "runtime:reset-account":
    case "runtime:request-account-deletion-code":
    case "runtime:delete-account":
    case "runtime:revoke-device":
    case "runtime:refresh-onboarding":
    case "runtime:approve-pending-device":
    case "runtime:confirm-paired-approver":
      return "PAIRING_FAILED";
    default:
      return "AUTH_REQUIRED";
  }
}

export class CopyytServiceWorkerRuntime {
  private readonly dependencies: RuntimeDependencies;
  private readonly identityLoader: (
    userId: string,
  ) => Promise<DeviceIdentity | null>;
  private readonly identityCreator: (userId: string) => Promise<DeviceIdentity>;
  private readonly registerDevice: typeof registerCurrentDevice;
  private readonly recoverDeviceWithCredential: typeof recoverCurrentDevice;
  private readonly clearIdentity: typeof clearDeviceIdentity;
  private readonly exportRecoveryKey: typeof exportRecoveryPrivateKey;
  private readonly sealRecoveryKey: typeof sealRecoveryCredential;
  private readonly encrypt: typeof encryptClipboardItem;
  private readonly decrypt: typeof decryptClipboardItemBytes;
  private readonly prepareDirect: typeof prepareDirectClipboardTransfer;
  private readonly decryptDirect: typeof decryptDirectClipboardTransfer;
  private readonly signChallenge: typeof signSocketChallenge;
  private readonly signApproval: typeof signDeviceApproval;
  private readonly pendingAssistedImageStore: PendingAssistedImageStore;
  private readonly assistedPngSuppressionStore: AssistedPngSuppressionStore;
  private readonly now: () => Date;
  private status: RuntimeStatus = DEFAULT_STATUS;
  private lastPersistedSyncPreferences: SyncPreferences = {
    ...DEFAULT_SYNC_PREFERENCES,
  };
  private sendPolicyRevision = 0;
  private receivePolicyRevision = 0;
  private syncPreferencesTransitionRevision = 0;
  private session: RuntimeSession | null = null;
  private socket: SocketLike | null = null;
  private socketAccountId: string | null = null;
  private socketReady = false;
  private challengeInFlight = false;
  private challengeReceived = false;
  private serverDeviceState: ServerDeviceState = "unknown";
  /**
   * Whether the server confirmed, on the latest registration, that this
   * device's recovery public key is the account's active recovery key. Only
   * then is the local recovery private key worth exporting. Fails closed.
   */
  private recoveryKeyActive = false;
  private lastUnknownSourceRefreshAt = Number.NEGATIVE_INFINITY;
  private startup: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private refreshInFlight: Promise<RuntimeSession> | null = null;
  private sessionMutationInFlight: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private syncPreferencesWriteInFlight: Promise<void> = Promise.resolve();
  private connectivityReconcileInFlight: Promise<void> | null = null;
  private pendingConnectivityIntent: ConnectivityReconcileIntent | null = null;
  private activeConnectivityIntent: ConnectivityReconcileIntent | null = null;
  private activeConnectivitySatisfaction: {
    forceSocketRecycle: boolean;
    forceTokenRefresh: boolean;
  } | null = null;
  private connectivityAttemptSequence = 0;
  private activeConnectivityAttempt = 0;
  private recoveryReason: string | null = null;
  private socketListeners = new Map<
    SocketLike,
    Array<{ event: string; listener: (...args: unknown[]) => void }>
  >();
  private readonly inboundInFlight = new Set<string>();
  private clipboardWatchRunning = false;
  private clipboardWatchDesired = false;
  private clipboardWatchResetRequested = false;
  private clipboardWatchReconcileInFlight: Promise<void> | null = null;
  private autoObservationSequence = 0;
  private autoPublishInFlight: Promise<void> | null = null;
  private automaticPublishAuthRecoveryInFlight = false;
  private pendingAutoObservation: {
    payload: ClipboardPayloadV1;
    sequence: number;
  } | null = null;
  private readonly directClipboardReceives = new Map<
    string,
    {
      manifest: DirectClipboardStartV1;
      encryptedChunks: string[];
      sourceDeviceId: string;
      receivePolicyRevision: number;
    }
  >();
  private readonly terminalDirectClipboardTransfers = new Map<string, number>();
  private readonly terminalDirectClipboardTransferTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly directSignalValidations = new Map<
    string,
    {
      sourceDeviceId: string;
      sourceKeyVersion: number;
      expiresAt?: number;
      timer?: ReturnType<typeof setTimeout>;
      validation?: Promise<ClientVerifiedDevice>;
    }
  >();

  constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
    this.identityLoader = dependencies.identityLoader ?? getDeviceIdentity;
    this.identityCreator =
      dependencies.identityCreator ?? getOrCreateDeviceIdentity;
    this.registerDevice = dependencies.registerDevice ?? registerCurrentDevice;
    this.recoverDeviceWithCredential =
      dependencies.recoverDevice ?? recoverCurrentDevice;
    this.clearIdentity = dependencies.clearIdentity ?? clearDeviceIdentity;
    this.exportRecoveryKey =
      dependencies.exportRecoveryKey ?? exportRecoveryPrivateKey;
    this.sealRecoveryKey = dependencies.sealRecoveryKey ?? sealRecoveryCredential;
    this.encrypt = dependencies.encrypt ?? encryptClipboardItem;
    this.decrypt = dependencies.decrypt ?? decryptClipboardItemBytes;
    this.prepareDirect = dependencies.prepareDirect ?? prepareDirectClipboardTransfer;
    this.decryptDirect = dependencies.decryptDirect ?? decryptDirectClipboardTransfer;
    this.signChallenge = dependencies.signChallenge ?? signSocketChallenge;
    this.signApproval = dependencies.signApproval ?? signDeviceApproval;
    this.pendingAssistedImageStore =
      dependencies.pendingAssistedImageStore ?? new InMemoryPendingAssistedImageStore();
    this.assistedPngSuppressionStore =
      dependencies.assistedPngSuppressionStore ?? new InMemoryAssistedPngSuppressionStore();
    this.now = dependencies.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (!this.startup) {
      this.startup = this.startInternal();
    }
    return this.startup;
  }

  hasAuthenticatedSession(): boolean {
    return this.session !== null;
  }

  /**
   * Reconciles the durable account state with the live transport. This is the
   * only path used for recovery after a disconnect, alarm wake, or dormant
   * runtime command. Connectivity failures are deliberately contained here:
   * they update status and can be retried by a later event.
   */
  async reconcileConnectivity(
    reason: string,
    options: ConnectivityReconcileOptions = {},
  ): Promise<void> {
    let operation = this.connectivityReconcileInFlight;
    if (operation) {
      this.queueConnectivityEscalation(reason, options);
    } else {
      operation = this.beginConnectivityReconciliation(reason, options);
    }
    await this.awaitConnectivityOperation(
      operation,
      CONNECTIVITY_RECONCILIATION_TIMEOUT_MS,
    );

    if (options.waitForReady && this.session && !this.isSocketTransportReady()) {
      await this.waitForSocketReady(CONNECTIVITY_RECONCILIATION_TIMEOUT_MS);
    }
  }

  private async awaitConnectivityOperation(
    operation: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        operation,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new RuntimeError(
                "SOCKET_NOT_READY",
                "Copyyt connectivity recovery timed out",
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        // The reconciliation continues as the single-flight owner. A caller
        // timing out must not clear the in-flight marker and allow a second
        // recovery to create a parallel socket.
        this.setConnectionRecovering(
          "SOCKET_NOT_READY",
          "Copyyt connectivity recovery will retry after the current attempt timed out",
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private beginConnectivityReconciliation(
    reason: string,
    options: ConnectivityReconcileOptions,
  ): Promise<void> {
    const pending = this.pendingConnectivityIntent;
    this.pendingConnectivityIntent = null;
    const initialIntent: ConnectivityReconcileIntent = pending
      ? {
          reason: pending.reason,
          options: {
            ...options,
            forceSocketRecycle:
              Boolean(options.forceSocketRecycle) ||
              Boolean(pending.options.forceSocketRecycle),
            forceTokenRefresh:
              Boolean(options.forceTokenRefresh) ||
              Boolean(pending.options.forceTokenRefresh),
          },
        }
      : { reason, options };
    const operation = this.runConnectivityReconciliation(initialIntent)
      .finally(() => {
        if (this.connectivityReconcileInFlight === operation) {
          this.connectivityReconcileInFlight = null;
          this.activeConnectivityIntent = null;
          this.activeConnectivityAttempt = 0;
        }
      });
    this.connectivityReconcileInFlight = operation;
    return operation;
  }

  private queueConnectivityEscalation(
    reason: string,
    options: ConnectivityReconcileOptions,
  ): void {
    const active = this.activeConnectivityIntent;
    if (!active) return;
    const pending = this.pendingConnectivityIntent;
    const requestedForce =
      Boolean(options.forceSocketRecycle) ||
      Boolean(options.forceTokenRefresh);
    if (!requestedForce && !pending) return;

    this.pendingConnectivityIntent = {
      reason: requestedForce ? reason : pending!.reason,
      options: {
        forceSocketRecycle:
          Boolean(options.forceSocketRecycle) ||
          Boolean(pending?.options.forceSocketRecycle),
        forceTokenRefresh:
          Boolean(options.forceTokenRefresh) ||
          Boolean(pending?.options.forceTokenRefresh),
      },
    };
  }

  private async runConnectivityReconciliation(
    initialIntent: ConnectivityReconcileIntent,
  ): Promise<void> {
    let intent = initialIntent;
    let followUpCount = 0;

    try {
      while (true) {
        const attemptId = ++this.connectivityAttemptSequence;
        this.activeConnectivityAttempt = attemptId;
        this.activeConnectivityIntent = intent;
        this.activeConnectivitySatisfaction = {
          forceSocketRecycle: false,
          forceTokenRefresh: false,
        };
        await this.reconcileConnectivityInternal(
          intent.reason,
          intent.options,
        );

        const pending = this.pendingConnectivityIntent;
        this.pendingConnectivityIntent = null;
        const satisfaction = this.activeConnectivitySatisfaction;
        const unsatisfiedPending = pending && {
          reason: pending.reason,
          options: {
            forceSocketRecycle:
              Boolean(pending.options.forceSocketRecycle) &&
              !satisfaction?.forceSocketRecycle,
            forceTokenRefresh:
              Boolean(pending.options.forceTokenRefresh) &&
              !satisfaction?.forceTokenRefresh,
          },
        };
        if (
          !unsatisfiedPending?.options.forceSocketRecycle &&
          !unsatisfiedPending?.options.forceTokenRefresh
        ) {
          return;
        }
        if (
          followUpCount >= MAX_CONNECTIVITY_RECONCILIATION_FOLLOW_UPS
        ) {
          // Preserve a late escalation for the next recovery trigger while
          // keeping this operation bounded.
          this.pendingConnectivityIntent = unsatisfiedPending;
          return;
        }

        // A stronger request that arrived during an attempt is handled by a
        // bounded aggregated follow-up. Identical concurrent requests do not
        // create another follow-up or another socket once the work is known
        // to have been satisfied.
        followUpCount += 1;
        intent = unsatisfiedPending;
      }
    } finally {
      this.activeConnectivitySatisfaction = null;
    }
  }

  private isActiveConnectivityAttempt(attemptId: number): boolean {
    return this.activeConnectivityAttempt === attemptId;
  }

  private async reconcileConnectivityInternal(
    reason: string,
    options: ConnectivityReconcileOptions,
  ): Promise<void> {
    if (!this.session) return;

    const currentSession = this.requireSession();
    const accessTokenNeedsRefresh =
      options.forceTokenRefresh ||
      tokenNeedsRefresh(currentSession.accessToken, this.now());

    if (
      !options.forceSocketRecycle &&
      !accessTokenNeedsRefresh &&
      this.isSocketTransportReady()
    ) {
      // The periodic alarm is a cheap health probe when the live transport is
      // already fully ready. Do not touch account state, membership, socket,
      // or watcher state on this path.
      return;
    }

    const attemptId = this.activeConnectivityAttempt;
    const wasTransportReady = this.isSocketTransportReady();
    const socketBeforeAttempt = this.socket;
    this.recoveryReason = reason;
    if (!wasTransportReady || options.forceSocketRecycle) {
      this.pendingAutoObservation = null;
      this.setConnectionRecovering(
        "SOCKET_NOT_READY",
        `Copyyt is reconnecting (${reason})`,
      );
    }

    try {
      if (accessTokenNeedsRefresh) {
        await this.refreshAccessToken();
        if (this.activeConnectivitySatisfaction) {
          this.activeConnectivitySatisfaction.forceTokenRefresh = true;
        }
      }

      // These calls restore the local identity/trust view and refresh server
      // membership before a new socket is allowed to become sync-ready.
      await this.ensureAccountInitialized();
      if (!this.isActiveConnectivityAttempt(attemptId)) return;
      await this.refreshOnboarding();
      if (!this.isActiveConnectivityAttempt(attemptId)) return;
      if (!this.session || this.serverDeviceState !== "trusted") {
        this.maybeConnectSocket();
        return;
      }

      if (options.forceSocketRecycle) {
        this.destroySocket(this.socket);
        if (this.activeConnectivitySatisfaction) {
          this.activeConnectivitySatisfaction.forceSocketRecycle = true;
        }
      }
      this.connectSocket();
      if (
        this.socket &&
        this.socket !== socketBeforeAttempt &&
        this.activeConnectivitySatisfaction
      ) {
        // A normal attempt can also replace a stale transport (for example
        // after a token refresh). That satisfies a concurrent recycle request
        // without creating an unnecessary second replacement socket.
        this.activeConnectivitySatisfaction.forceSocketRecycle = true;
      }
      if (wasTransportReady && !options.forceSocketRecycle) {
        this.recoveryReason = null;
      }
    } catch (error) {
      if (!this.isActiveConnectivityAttempt(attemptId)) return;
      if (isFatalLocalInitializationFailure(error)) {
        throw error;
      }
      if (refreshFailureIsDefinitive(error)) {
        await this.clearSession();
        return;
      }
      if (
        error instanceof RuntimeError &&
        error.code === "AUTH_REQUIRED" &&
        !this.session
      ) {
        // refreshAccessToken already cleared the session after an
        // authoritative credential rejection.
        return;
      }

      // Network, Socket.IO, and temporary backend availability errors are
      // connection state—not runtime startup death. Do not poison the worker.
      this.serverDeviceState = "unknown";
      this.recoveryKeyActive = false;
      this.setConnectionRecovering(
        error instanceof RuntimeError ? error.code : "SOCKET_NOT_READY",
        error instanceof Error
          ? `Copyyt connectivity recovery is unavailable: ${error.message}`
          : "Copyyt connectivity recovery is temporarily unavailable",
      );
    }
  }

  private async waitForSocketReady(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isSocketTransportReady()) return;
      if (!this.socket || this.serverDeviceState !== "trusted") break;
      if (
        this.status.lastConnectionError &&
        this.socket &&
        !this.socket.connected
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new RuntimeError(
      "SOCKET_NOT_READY",
      "Copyyt is still reconnecting; the device connection is not ready",
    );
  }

  private isSocketTransportReady(): boolean {
    return Boolean(
      this.socket &&
        this.socket.connected &&
        this.socketReady &&
        this.status.connectionState === "ready" &&
        this.status.socket.connected &&
        this.status.socket.deviceAuthenticated,
    );
  }

  private async ensureRecoveryAlarm(): Promise<void> {
    if (!this.dependencies.recoveryAlarm) return;
    if (this.session) {
      await Promise.resolve(this.dependencies.recoveryAlarm.ensure()).catch(
        () => undefined,
      );
    } else {
      await Promise.resolve(this.dependencies.recoveryAlarm.clear()).catch(
        () => undefined,
      );
    }
  }

  private async startInternal(): Promise<void> {
    const persistedStatus = await this.dependencies.statusStore
      .get()
      .catch(() => null);
    this.session = await this.dependencies.sessionStore.get();
    let syncPreferences: SyncPreferences;
    try {
      const storedPreferences = await this.dependencies.syncPreferencesStore.get();
      syncPreferences = isSyncPreferences(storedPreferences)
        ? storedPreferences
        : { ...OFF_SYNC_PREFERENCES };
    } catch {
      // A preference read failure must never turn into accidental clipboard
      // participation. The control plane can still recover in Off mode.
      syncPreferences = { ...OFF_SYNC_PREFERENCES };
    }
    this.lastPersistedSyncPreferences = { ...syncPreferences };

    // Persisted status is useful context for the UI, but it is not live
    // authority. In particular, a worker recreation cannot inherit socket or
    // sync readiness from the previous worker instance.
    this.status = {
      ...DEFAULT_STATUS,
      ...(persistedStatus
        ? {
            device: { ...DEFAULT_STATUS.device, ...persistedStatus.device },
            onboarding: {
              ...DEFAULT_STATUS.onboarding,
              ...persistedStatus.onboarding,
            },
            ...(persistedStatus.lastSyncError
              ? { lastSyncError: persistedStatus.lastSyncError }
              : {}),
            ...(persistedStatus.lastConnectionError
              ? { lastConnectionError: persistedStatus.lastConnectionError }
              : {}),
            ...(persistedStatus.lastRecoveredAt
              ? { lastRecoveredAt: persistedStatus.lastRecoveredAt }
              : {}),
            ...(persistedStatus.lastRecoveryReason
              ? { lastRecoveryReason: persistedStatus.lastRecoveryReason }
              : {}),
            ...(persistedStatus.lastAutoSyncAt
              ? { lastAutoSyncAt: persistedStatus.lastAutoSyncAt }
              : {}),
            ...(persistedStatus.lastAutoPublishAcceptedAt
              ? { lastAutoPublishAcceptedAt: persistedStatus.lastAutoPublishAcceptedAt }
              : {}),
            ...(persistedStatus.lastDirectDeliveryAt
              ? { lastDirectDeliveryAt: persistedStatus.lastDirectDeliveryAt }
              : {}),
            ...(persistedStatus.lastAutoSyncError
              ? { lastAutoSyncError: persistedStatus.lastAutoSyncError }
              : {}),
          }
        : {}),
      connectionState: this.session ? "account-authenticated" : "signed-out",
      signedIn: this.session !== null,
      user: this.session ? userFromSession(this.session) : undefined,
      socket: { connected: false, deviceAuthenticated: false },
      syncReady: false,
      syncPreferences: { ...syncPreferences },
      clipboardWatch: "stopped",
    };
    await this.refreshPendingAssistedImageStatus();
    this.serverDeviceState = "unknown";
    this.recoveryKeyActive = false;
    this.socketReady = false;
    this.challengeInFlight = false;
    this.challengeReceived = false;
    this.clipboardWatchDesired = false;
    this.clipboardWatchRunning = false;
    this.clipboardWatchResetRequested = false;
    this.pendingAutoObservation = null;
    if (this.dependencies.clipboardAdapter.stopWatching) {
      await this.dependencies.clipboardAdapter.stopWatching().catch(() => undefined);
    }

    if (!this.session) {
      this.setStatus({
        ...this.status,
        connectionState: "signed-out",
        signedIn: false,
        user: undefined,
      });
      await this.ensureRecoveryAlarm();
      return;
    }
    this.setStatus({
      ...this.status,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(this.session),
    });
    let startupTimedOut = false;
    const startupConnectivity = this.beginConnectivityReconciliation(
      "startup",
      {},
    ).catch((error: unknown) => {
      // A local fatal error is allowed to fail startup when it is observed
      // during the bounded startup kick. If it occurs after the kick timed
      // out, contain it as a runtime diagnostic rather than creating an
      // unhandled rejection in the service worker.
      if (!startupTimedOut && isFatalLocalInitializationFailure(error)) {
        throw error;
      }
      if (isFatalLocalInitializationFailure(error)) {
        this.report(
          error,
          "DEVICE_NOT_REGISTERED",
          "The Copyyt local device state is not usable",
        );
      }
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        startupConnectivity,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, STARTUP_CONNECTIVITY_KICK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      startupTimedOut = true;
      if (timeout !== undefined) clearTimeout(timeout);
    }
    await this.ensureRecoveryAlarm();
  }

  getStatus(): RuntimeStatus {
    return structuredClone(this.status);
  }

  private async refreshPendingAssistedImageStatus(): Promise<void> {
    const records = this.session
      ? await this.pendingAssistedImageStore.list(this.session.user.id)
      : [];
    const summaries: PendingAssistedImageSummary[] = records.map((record) => ({
      itemId: record.itemId,
      sourceDeviceId: record.sourceDeviceId,
      ...(record.sourceDeviceName ? { sourceDeviceName: record.sourceDeviceName } : {}),
      receivedAt: record.receivedAt,
      expiresAt: record.expiresAt,
      hasPng: true,
    }));
    this.setStatus({ ...this.status, pendingAssistedImages: summaries });
  }

  /** Handles a validated, fire-and-forget observation from the offscreen document. */
  async handleClipboardObservation(message: unknown): Promise<void> {
    if (!isOffscreenClipboardObservation(message)) return;
    let payload: ClipboardPayloadV1;
    try {
      payload = message.payload ?? clipboardPayloadFromPlainText(message.text);
      validateClipboardPayloadV1(payload);
    } catch {
      return;
    }
    const png = getPngRepresentation(payload);
    if (png && this.session) {
      try {
        if (await this.assistedPngSuppressionStore.consumeNext(this.session.user.id)) {
          // The focused-page assisted write is an intentional local clipboard
          // change. Consume its durable one-shot guard before the observation
          // can enter the live publish path, even if the worker was reconstructed.
          this.autoObservationSequence += 1;
          this.pendingAutoObservation = null;
          return;
        }
      } catch {
        // A suppression-store failure must not make a valid clipboard item
        // unreadable. The normal publish path remains authoritative.
      }
    }
    const plain = findPlainTextRepresentation(payload);
    if (!plain) {
      // Image-only observations are now eligible for capability-aware
      // encrypted delivery. The publish path decides whether any compatible
      // recipient exists and whether the serialized bundle fits the relay.
    }
    if (plain?.data.length === 0 && payload.representations.length === 1) {
      this.pendingAutoObservation = null;
      return;
    }
    if (!this.status.syncPreferences.sendEnabled) {
      // Do not retain an observation while sending is disabled. The next
      // enable operation starts a fresh baseline instead of publishing the
      // value that was already on the clipboard.
      this.pendingAutoObservation = null;
      return;
    }
    if (!this.isAutomaticSyncEligible()) {
      if (
        this.autoPublishInFlight &&
        this.isAutomaticPublishAuthRecoveryActive()
      ) {
        // An auth recovery temporarily replaces the ready socket after the
        // access token rotates. Keep the existing latest-wins slot alive for
        // this bounded publish retry; ordinary socket recovery still drops
        // observations and establishes a fresh clipboard baseline.
        const observation = {
          payload,
          sequence: ++this.autoObservationSequence,
        };
        this.pendingAutoObservation = observation;
        await this.autoPublishInFlight;
        return;
      }
      // The observation is intentionally not retained. It may wake a dormant
      // runtime, but only a later clipboard change after a fresh baseline can
      // be published.
      if (this.session) {
        void this.reconcileConnectivity("clipboard-observation").catch(
          () => undefined,
        );
      }
      return;
    }

    const observation = {
      payload,
      sequence: ++this.autoObservationSequence,
    };
    if (this.autoPublishInFlight) {
      // Clipboard state is live, not history: retain only the newest value.
      this.pendingAutoObservation = observation;
      await this.autoPublishInFlight;
      return;
    }

    const operation = this.drainAutoObservations(observation);
    const trackedOperation = operation.finally(() => {
      if (this.autoPublishInFlight === trackedOperation) {
        this.autoPublishInFlight = null;
      }
    });
    this.autoPublishInFlight = trackedOperation;
    await trackedOperation;
  }

  async handleDirectTransportEvent(message: unknown): Promise<void> {
    if (!isOffscreenDirectTransportEvent(message)) return;
    const event = message.event;
    if (event.kind === "application-frame") {
      if (
        !this.directClipboardReceives.has(event.transferId) &&
        this.isTerminalDirectClipboardTransfer(event.transferId)
      ) {
        // A frame can already be crossing offscreen -> worker when the
        // transport reaches a terminal state. Preserve the terminal result.
        return;
      }
      try {
        await this.handleDirectClipboardFrame(event);
      } catch (error) {
        this.markTerminalDirectClipboardTransfer(event.transferId);
        this.directClipboardReceives.delete(event.transferId);
        await this.dependencies.directTransport
          ?.cancelTransfer(
            event.transferId,
            error instanceof Error ? error.message : "Direct clipboard validation failed",
          )
          .catch(() => undefined);
        this.recordSyncError(
          "DIRECT_TRANSPORT_FAILED",
          error instanceof Error ? error.message : "Direct clipboard validation failed",
        );
      }
      return;
    }
    if (event.kind === "status") {
      const previous = this.status.directTransfers ?? [];
      const next: DirectTransportStatus = {
        transferId: event.transferId,
        remoteDeviceId: event.remoteDeviceId,
        state: event.state,
        ...(event.bytesSent !== undefined ? { bytesSent: event.bytesSent } : {}),
        ...(event.bytesReceived !== undefined
          ? { bytesReceived: event.bytesReceived }
          : {}),
        ...(event.byteLength !== undefined ? { byteLength: event.byteLength } : {}),
        ...(event.startedAt ? { startedAt: event.startedAt } : {}),
        ...(event.finishedAt ? { finishedAt: event.finishedAt } : {}),
        ...(event.error ? { error: event.error } : {}),
      };
      const withoutTransfer = previous.filter(
        (transfer) => transfer.transferId !== event.transferId,
      );
      this.setStatus({
        ...this.status,
        directTransfers: [next, ...withoutTransfer].slice(0, 4),
      });
      if (event.state === "failed" || event.state === "cancelled") {
        this.markTerminalDirectClipboardTransfer(event.transferId);
        this.directClipboardReceives.delete(event.transferId);
        this.clearDirectSignalValidation(event.transferId);
      }
      if (event.state === "succeeded") {
        this.markTerminalDirectClipboardTransfer(event.transferId);
        this.clearDirectSignalValidation(event.transferId);
        this.setStatus({
          ...this.status,
          lastDirectDeliveryAt: this.now().toISOString(),
        });
      }
      if (
        event.state === "failed" &&
        event.error &&
        this.status.connectionState === "ready"
      ) {
        // Direct transport health is diagnostic only. Do not change socket or
        // clipboard readiness when a peer experiment fails.
        return;
      }
      return;
    }

    const transport = this.dependencies.directTransport;
    if (!transport) {
      return;
    }
    if (!this.isSocketTransportReady()) {
      void transport
        .cancelTransfer(event.transferId, "Copyyt socket is unavailable")
        .catch(() => undefined);
      return;
    }
    const request: DirectSignalRequest = {
      transferId: event.transferId,
      recipientDeviceId: event.remoteDeviceId,
      ...event.signal,
    };
    try {
      await this.emitDirectSignal(request);
    } catch (error) {
      if (event.signal.kind === "cancel") return;
      await transport
        .cancelTransfer(
          event.transferId,
          error instanceof Error ? error.message : "Direct signalling failed",
        )
        .catch(() => undefined);
    }
  }

  private async handleDirectClipboardFrame(
    event: Extract<DirectManagerEvent, { kind: "application-frame" }>,
  ): Promise<void> {
    if (event.frame.type === "clipboard-secure-chunk") {
      const pending = this.directClipboardReceives.get(event.transferId);
      if (!pending) {
        throw new RuntimeError(
          "DIRECT_TRANSPORT_FAILED",
          "The direct clipboard chunk has no manifest",
        );
      }
      if (!this.isReceivePolicyCurrent(pending.receivePolicyRevision)) {
        throw new RuntimeError(
          "CLIPBOARD_WRITE_FAILED",
          "Clipboard receiving is disabled for this device",
        );
      }
      if (event.remoteDeviceId !== pending.sourceDeviceId) {
        throw new RuntimeError(
          "DIRECT_TRANSPORT_FAILED",
          "The direct clipboard chunk source changed",
        );
      }
      if (pending.encryptedChunks.length >= pending.manifest.chunkCount) {
        throw new RuntimeError(
          "DIRECT_TRANSPORT_FAILED",
          "The direct clipboard transfer has an extra chunk",
        );
      }
      pending.encryptedChunks.push(event.frame.data);
      if (pending.encryptedChunks.length !== pending.manifest.chunkCount) return;
      await this.finishDirectClipboardReceive(event, pending);
      return;
    }

    const session = this.requireSession();
    const transport = this.dependencies.directTransport;
    if (!transport?.sendClipboardVerified) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_UNAVAILABLE",
        "The direct clipboard transport is not available in this build",
      );
    }
    if (!this.isReceivePolicyCurrent(this.receivePolicyRevision)) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard receiving is disabled for this device",
      );
    }
    if (this.directClipboardReceives.has(event.transferId)) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard manifest was repeated",
      );
    }
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError("DEVICE_NOT_REGISTERED", "The device is not registered");
    }
    const localRecipient = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (
      !isLocallyVerified(localRecipient) ||
      !identityMatchesLocalDevice(identity, localRecipient) ||
      !localRecipient.capabilities?.includes(CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY) ||
      !localRecipient.capabilities?.includes(CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY)
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "This device has not advertised direct assisted PNG receive",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.frame.manifest) as unknown;
    } catch {
      throw new RuntimeError("DIRECT_TRANSPORT_FAILED", "The direct clipboard manifest is invalid");
    }
    if (!isDirectClipboardStartV1(parsed)) {
      throw new RuntimeError("DIRECT_TRANSPORT_FAILED", "The direct clipboard manifest is invalid");
    }
    const manifest = parsed;
    if (
      manifest.transferId !== event.transferId ||
      manifest.sourceDeviceId !== event.remoteDeviceId ||
      manifest.userId !== session.user.id ||
      manifest.recipientDeviceId !== identity.deviceId ||
      manifest.recipientKeyVersion !== identity.keyVersion
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard manifest peer binding is invalid",
      );
    }
    const source = await this.requireActiveTrustedDirectSource(
      session,
      manifest.sourceDeviceId,
      manifest.sourceKeyVersion,
    );
    const now = this.now().getTime();
    const expiresAt = parseStrictExpiry(manifest.expiresAt);
    if (expiresAt === null || now >= expiresAt || !isLiveExpiryWithinPolicy(expiresAt, now)) {
      throw new RuntimeError("DIRECT_TRANSPORT_FAILED", "The direct clipboard transfer has expired");
    }
    if (
      Math.ceil(manifest.plaintextByteLength / manifest.chunkPlaintextSize) !==
      manifest.chunkCount
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard chunk count is invalid",
      );
    }
    if (
      !(await verifyDirectClipboardManifestSignature({
        manifest,
        sourceSignature: manifest.sourceSignature,
        sourceSigningPublicKey: source.signingPublicKey,
      }))
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard manifest signature is invalid",
      );
    }
    if (!source.capabilities?.includes(CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY)) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct source does not advertise clipboard direct transfer",
      );
    }
    this.directClipboardReceives.set(event.transferId, {
      manifest,
      encryptedChunks: [],
      sourceDeviceId: source.deviceId,
      receivePolicyRevision: this.receivePolicyRevision,
    });
  }

  private async finishDirectClipboardReceive(
    event: Extract<DirectManagerEvent, { kind: "application-frame" }>,
    pending: {
      manifest: DirectClipboardStartV1;
      encryptedChunks: string[];
      sourceDeviceId: string;
      receivePolicyRevision: number;
    },
  ): Promise<void> {
    const session = this.requireSession();
    const transport = this.dependencies.directTransport;
    if (!transport?.sendClipboardVerified) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_UNAVAILABLE",
        "The direct clipboard transport is not available in this build",
      );
    }
    if (!this.isReceivePolicyCurrent(pending.receivePolicyRevision)) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard receiving is disabled for this device",
      );
    }
    const identity = await this.identityLoader(session.user.id);
    if (
      !identity ||
      identity.keyVersion === null ||
      identity.deviceId !== pending.manifest.recipientDeviceId ||
      identity.keyVersion !== pending.manifest.recipientKeyVersion
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard recipient identity changed",
      );
    }
    const localRecipient = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (
      !isLocallyVerified(localRecipient) ||
      !identityMatchesLocalDevice(identity, localRecipient) ||
      !localRecipient.capabilities?.includes(CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY) ||
      !localRecipient.capabilities?.includes(CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY)
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "This device is no longer trusted for direct assisted PNG receive",
      );
    }
    const source = await this.requireActiveTrustedDirectSource(
      session,
      pending.manifest.sourceDeviceId,
      pending.manifest.sourceKeyVersion,
    );
    const expiresAt = parseStrictExpiry(pending.manifest.expiresAt);
    if (expiresAt === null || this.now().getTime() >= expiresAt) {
      throw new RuntimeError("DIRECT_TRANSPORT_FAILED", "The direct clipboard transfer has expired");
    }
    if (
      !(await verifyDirectClipboardManifestSignature({
        manifest: pending.manifest,
        sourceSignature: pending.manifest.sourceSignature,
        sourceSigningPublicKey: source.signingPublicKey,
      }))
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct clipboard manifest signature is invalid",
      );
    }
    if (!source.capabilities?.includes(CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY)) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The direct source no longer advertises clipboard direct transfer",
      );
    }
    const decrypted = await this.decryptDirect({
      userId: session.user.id,
      identity,
      sourceDevice: source,
      manifest: pending.manifest,
      encryptedChunks: pending.encryptedChunks,
      now: this.now,
    });
    if (!this.isReceivePolicyCurrent(pending.receivePolicyRevision)) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard receiving is disabled for this device",
      );
    }
    if (this.now().getTime() >= expiresAt) {
      throw new RuntimeError("DIRECT_TRANSPORT_FAILED", "The direct clipboard transfer has expired");
    }
    const png = getPngRepresentation(decrypted.payload);
    if (!png) throw new RuntimeError("INVALID_CLIPBOARD_CONTENT", "The direct clipboard bundle does not contain PNG data");
    getPngBytes(decrypted.payload);
    const text = findPlainTextRepresentation(decrypted.payload);
    if (text) {
      const textPayload = projectClipboardPayloadToText(decrypted.payload);
      if (this.dependencies.clipboardAdapter.writePayload) {
        await this.dependencies.clipboardAdapter.writePayload(textPayload);
      } else {
        await this.dependencies.clipboardAdapter.writeText(text.data);
      }
    }
    const pendingRecord = {
      userId: session.user.id,
      itemId: pending.manifest.transferId,
      sourceDeviceId: pending.manifest.sourceDeviceId,
      ...(source.name ? { sourceDeviceName: source.name } : {}),
      receivedAt: this.now().toISOString(),
      expiresAt: pending.manifest.expiresAt,
      hasPng: true as const,
      directPackage: {
        manifest: pending.manifest,
        encryptedChunks: [...pending.encryptedChunks],
      },
    };
    await this.pendingAssistedImageStore.put(pendingRecord);
    await this.dependencies.processedItemStore.mark({
      userId: session.user.id,
      itemId: pending.manifest.transferId,
      processedAt: this.now().toISOString(),
      sourceDeviceId: pending.manifest.sourceDeviceId,
      disposition: "pending-image",
    });
    this.markTerminalDirectClipboardTransfer(event.transferId);
    this.directClipboardReceives.delete(event.transferId);
    await transport.sendClipboardVerified({
      transferId: event.transferId,
      plaintextByteLength: pending.manifest.plaintextByteLength,
    });
    await this.refreshPendingAssistedImageStatus();
  }

  private pruneTerminalDirectClipboardTransfers(now = this.now().getTime()): void {
    for (const [transferId, expiresAt] of this.terminalDirectClipboardTransfers) {
      if (expiresAt <= now) {
        this.terminalDirectClipboardTransfers.delete(transferId);
        const timer = this.terminalDirectClipboardTransferTimers.get(transferId);
        if (timer !== undefined) clearTimeout(timer);
        this.terminalDirectClipboardTransferTimers.delete(transferId);
      }
    }
  }

  private isTerminalDirectClipboardTransfer(transferId: string): boolean {
    const now = this.now().getTime();
    this.pruneTerminalDirectClipboardTransfers(now);
    const expiresAt = this.terminalDirectClipboardTransfers.get(transferId);
    return expiresAt !== undefined && expiresAt > now;
  }

  private markTerminalDirectClipboardTransfer(transferId: string): void {
    const now = this.now().getTime();
    this.pruneTerminalDirectClipboardTransfers(now);
    const manifestExpiry = this.directClipboardReceives.get(transferId)?.manifest.expiresAt;
    const parsedManifestExpiry = manifestExpiry === undefined
      ? null
      : parseStrictExpiry(manifestExpiry);
    const boundedExpiry = now + LIVE_CLIPBOARD_TTL_MS;
    const drainExpiry = now + DIRECT_CLIPBOARD_TERMINAL_TOMBSTONE_TTL_MS;
    const expiresAt = parsedManifestExpiry === null
      ? drainExpiry
      : Math.min(boundedExpiry, Math.max(drainExpiry, parsedManifestExpiry));
    const previousTimer = this.terminalDirectClipboardTransferTimers.get(transferId);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    this.terminalDirectClipboardTransfers.set(transferId, expiresAt);
    const timer = setTimeout(() => {
      if (this.terminalDirectClipboardTransfers.get(transferId) !== expiresAt) return;
      this.terminalDirectClipboardTransfers.delete(transferId);
      this.terminalDirectClipboardTransferTimers.delete(transferId);
    }, Math.max(0, expiresAt - now));
    (
      timer as unknown as { unref?: () => void }
    ).unref?.();
    this.terminalDirectClipboardTransferTimers.set(transferId, timer);
  }

  private clearDirectSignalValidation(transferId: string): void {
    const validation = this.directSignalValidations.get(transferId);
    if (!validation) return;
    if (validation.timer !== undefined) clearTimeout(validation.timer);
    this.directSignalValidations.delete(transferId);
  }

  private clearAllDirectSignalValidations(): void {
    for (const transferId of this.directSignalValidations.keys()) {
      this.clearDirectSignalValidation(transferId);
    }
  }

  private reserveDirectSignalValidation(
    transferId: string,
    sourceDeviceId: string,
    sourceKeyVersion: number,
  ): {
    sourceDeviceId: string;
    sourceKeyVersion: number;
    validation?: Promise<ClientVerifiedDevice>;
    expiresAt?: number;
    timer?: ReturnType<typeof setTimeout>;
  } {
    while (this.directSignalValidations.size >= DIRECT_SIGNAL_VALIDATION_MAX) {
      const oldestTransferId = this.directSignalValidations.keys().next().value;
      if (typeof oldestTransferId !== "string") break;
      this.clearDirectSignalValidation(oldestTransferId);
    }
    const reservation = { sourceDeviceId, sourceKeyVersion };
    this.directSignalValidations.set(transferId, reservation);
    return reservation;
  }

  private promoteDirectSignalValidation(
    transferId: string,
    reservation: {
      sourceDeviceId: string;
      sourceKeyVersion: number;
    },
  ): void {
    if (this.directSignalValidations.get(transferId) !== reservation) return;
    const expiresAt = this.now().getTime() + DIRECT_SIGNAL_VALIDATION_TTL_MS;
    const timer = setTimeout(() => {
      const current = this.directSignalValidations.get(transferId);
      if (current?.expiresAt === expiresAt) {
        this.directSignalValidations.delete(transferId);
      }
    }, DIRECT_SIGNAL_VALIDATION_TTL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.directSignalValidations.set(transferId, {
      sourceDeviceId: reservation.sourceDeviceId,
      sourceKeyVersion: reservation.sourceKeyVersion,
      expiresAt,
      timer,
    });
  }

  private async requireActiveTrustedDirectSource(
    session: RuntimeSession,
    sourceDeviceId: string,
    sourceKeyVersion: number,
  ): Promise<ClientVerifiedDevice> {
    const localSource = await this.dependencies.trustStore.getDevice(
      session.user.id,
      sourceDeviceId,
    );
    if (!isLocallyVerified(localSource) || localSource.keyVersion !== sourceKeyVersion) {
      throw new RuntimeError("SOURCE_UNTRUSTED", "The direct clipboard source is not locally trusted");
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    const serverSource = snapshot.trustedDevices.find(
      (device) =>
        device.deviceId === sourceDeviceId &&
        device.keyVersion === sourceKeyVersion &&
        device.signingPublicKey === localSource.signingPublicKey &&
        device.encryptionPublicKey === localSource.encryptionPublicKey &&
        device.revokedAt == null,
    );
    if (
      !serverSource ||
      !serverSource.capabilities?.includes(CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY)
    ) {
      throw new RuntimeError("SOURCE_UNTRUSTED", "The direct clipboard source is no longer active and trusted");
    }
    return localSource;
  }

  async startDirectTestTransfer(
    recipientDeviceId: string,
  ): Promise<DirectTransportStatus> {
    const session = this.requireSession();
    const transport = this.dependencies.directTransport;
    if (!transport) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_UNAVAILABLE",
        "The direct transport is not available in this build",
      );
    }
    this.requireSocketReady();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "The device must be registered before starting a direct transfer",
      );
    }
    const localDevice = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (!isLocallyVerified(localDevice)) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Trust this device before starting a direct transfer",
      );
    }
    if (recipientDeviceId === identity.deviceId) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "A direct transfer cannot target this device",
      );
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    const recipient = snapshot.trustedDevices.find(
      (device) => device.deviceId === recipientDeviceId,
    );
    const localRecipient = await this.dependencies.trustStore.getDevice(
      session.user.id,
      recipientDeviceId,
    );
    if (
      !recipient ||
      !localRecipient ||
      !isLocallyVerified(localRecipient) ||
      localRecipient.keyVersion !== recipient.keyVersion ||
      localRecipient.signingPublicKey !== recipient.signingPublicKey ||
      localRecipient.encryptionPublicKey !== recipient.encryptionPublicKey
    ) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "The selected device is not an active locally trusted device",
      );
    }
    const transferId = globalThis.crypto.randomUUID();
    try {
      await transport.startTestTransfer({ transferId, recipientDeviceId });
    } catch (error) {
      throw error instanceof RuntimeError
        ? error
        : new RuntimeError(
            "DIRECT_TRANSPORT_FAILED",
            "The direct transport could not start",
          );
    }
    const status: DirectTransportStatus = {
      transferId,
      remoteDeviceId: recipientDeviceId,
      state: "connecting",
      startedAt: this.now().toISOString(),
    };
    this.setStatus({
      ...this.status,
      directTransfers: [
        status,
        ...(this.status.directTransfers ?? []).filter(
          (transfer) => transfer.transferId !== transferId,
        ),
      ].slice(0, 4),
    });
    return status;
  }

  async cancelDirectTestTransfer(transferId: string): Promise<void> {
    this.clearDirectSignalValidation(transferId);
    if (!this.dependencies.directTransport) return;
    await this.dependencies.directTransport.cancelTransfer(
      transferId,
      "Cancelled by the local device",
    );
  }

  private async receiveDirectSignal(payload: unknown): Promise<void> {
    if (!isDirectSignalDelivery(payload) || !this.session) return;
    if (!this.status.socket.deviceAuthenticated || !this.dependencies.directTransport) {
      return;
    }
    const existing = this.directSignalValidations.get(payload.transferId);
    if (existing) {
      if (
        existing.sourceDeviceId !== payload.sourceDeviceId ||
        existing.sourceKeyVersion !== payload.sourceKeyVersion
      ) {
        // A transfer binding is immutable, including while its first
        // authoritative validation is still in flight.
        return;
      }
      if (existing.validation) {
        try {
          await existing.validation;
        } catch {
          return;
        }
        const promoted = this.directSignalValidations.get(payload.transferId);
        if (
          !promoted ||
          promoted.sourceDeviceId !== payload.sourceDeviceId ||
          promoted.sourceKeyVersion !== payload.sourceKeyVersion ||
          promoted.validation
        ) {
          return;
        }
        await this.dependencies.directTransport.handleSignal(payload).catch(() => undefined);
        if (payload.kind === "cancel") {
          this.clearDirectSignalValidation(payload.transferId);
        }
        return;
      } else if (
        existing.expiresAt === undefined ||
        existing.expiresAt <= this.now().getTime()
      ) {
        this.clearDirectSignalValidation(payload.transferId);
      } else {
        await this.dependencies.directTransport.handleSignal(payload).catch(() => undefined);
        if (payload.kind === "cancel") {
          this.clearDirectSignalValidation(payload.transferId);
        }
        return;
      }
    }

    const localSource = await this.dependencies.trustStore.getDevice(
      this.session.user.id,
      payload.sourceDeviceId,
    );
    if (
      !isLocallyVerified(localSource) ||
      localSource.keyVersion !== payload.sourceKeyVersion
    ) {
      return;
    }

    const boundAfterLocalTrust = this.directSignalValidations.get(payload.transferId);
    if (boundAfterLocalTrust) {
      if (
        boundAfterLocalTrust.sourceDeviceId !== payload.sourceDeviceId ||
        boundAfterLocalTrust.sourceKeyVersion !== payload.sourceKeyVersion
      ) {
        return;
      }
      if (boundAfterLocalTrust.validation) {
        try {
          await boundAfterLocalTrust.validation;
        } catch {
          return;
        }
        const promoted = this.directSignalValidations.get(payload.transferId);
        if (
          !promoted ||
          promoted.sourceDeviceId !== payload.sourceDeviceId ||
          promoted.sourceKeyVersion !== payload.sourceKeyVersion ||
          promoted.validation
        ) {
          return;
        }
        await this.dependencies.directTransport.handleSignal(payload).catch(() => undefined);
        if (payload.kind === "cancel") {
          this.clearDirectSignalValidation(payload.transferId);
        }
        return;
      }
      if (
        boundAfterLocalTrust.expiresAt === undefined ||
        boundAfterLocalTrust.expiresAt <= this.now().getTime()
      ) {
        this.clearDirectSignalValidation(payload.transferId);
      } else {
        await this.dependencies.directTransport.handleSignal(payload).catch(() => undefined);
        if (payload.kind === "cancel") {
          this.clearDirectSignalValidation(payload.transferId);
        }
        return;
      }
    }

    // The first signal for a transfer (offer, answer, or pre-offer ICE) is
    // authoritative. Ordinary subsequent ICE candidates reuse only this
    // transfer-scoped, short-lived source binding.
    const reservation = this.reserveDirectSignalValidation(
      payload.transferId,
      payload.sourceDeviceId,
      payload.sourceKeyVersion,
    );
    const validation = this.requireActiveTrustedDirectSource(
      this.session,
      payload.sourceDeviceId,
      payload.sourceKeyVersion,
    );
    reservation.validation = validation;
    try {
      await validation;
    } catch {
      if (this.directSignalValidations.get(payload.transferId) === reservation) {
        this.clearDirectSignalValidation(payload.transferId);
      }
      return;
    }
    if (this.directSignalValidations.get(payload.transferId) !== reservation) {
      return;
    }
    this.promoteDirectSignalValidation(payload.transferId, reservation);
    await this.dependencies.directTransport.handleSignal(payload).catch(() => undefined);
    if (payload.kind === "cancel") {
      this.clearDirectSignalValidation(payload.transferId);
    }
  }

  async handleMessage(message: unknown): Promise<RuntimeResponse> {
    if (!isRuntimeRequest(message)) {
      throw new RuntimeError("AUTH_REQUIRED", "The runtime message is invalid");
    }
    try {
      const data = await this.handleCommand(message.command);
      return {
        source: RUNTIME_SOURCE,
        target: POPUP_SOURCE,
        requestId: message.requestId,
        ok: true,
        data,
      };
    } catch (error) {
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : isAuthCommand(message.command)
            ? authRuntimeError(error, message.command)
            : asRuntimeError(
                error,
                commandFallbackErrorCode(message.command),
                describeFailure(error) ?? "The runtime operation failed",
              );
      this.recordOperationError(runtimeError.code, runtimeError.message);
      return {
        source: RUNTIME_SOURCE,
        target: POPUP_SOURCE,
        requestId: message.requestId,
        ok: false,
        error: { code: runtimeError.code, message: runtimeError.message },
      };
    }
  }

  private isAutomaticSyncEligible(requireWatcher = true): boolean {
    const watcherReady =
      !this.dependencies.clipboardAdapter.startWatching ||
      this.clipboardWatchRunning;
    return Boolean(
      this.session &&
        this.status.syncReady &&
        this.status.device.registration === "registered" &&
        typeof this.status.device.deviceId === "string" &&
        typeof this.status.device.keyVersion === "number" &&
        isLocallyVerifiedStatus(this.status) &&
        this.serverDeviceState === "trusted" &&
        this.socket &&
        this.socket.connected &&
        this.socketReady &&
        this.status.socket.deviceAuthenticated &&
        this.status.syncPreferences.sendEnabled &&
        (!requireWatcher || watcherReady),
    );
  }

  private async drainAutoObservations(first: {
    payload: ClipboardPayloadV1;
    sequence: number;
  }): Promise<void> {
    let current = first;
    const sendPolicyRevision = this.sendPolicyRevision;
    let authRecoveryAttempted = false;
    while (true) {
      // The one bounded retry retained across an authoritative 401 belongs
      // to the observation that was already captured before recovery. The
      // watcher is restarted with a fresh baseline for future changes, but an
      // in-flight restart must not invalidate this transport-ready retry.
      if (!this.isAutomaticSyncEligible(!authRecoveryAttempted)) return;
      try {
        this.requireSendPolicy(sendPolicyRevision);
        await this.publishClipboardPayload(current.payload, current.sequence);
        this.setStatus({
          ...this.status,
          lastAutoSyncAt: this.now().toISOString(),
          lastAutoPublishAcceptedAt: this.now().toISOString(),
          lastAutoSyncError: undefined,
        });
      } catch (error) {
        const runtimeError = asRuntimeError(
          error,
          "SOCKET_PUBLISH_FAILED",
          "Automatic clipboard sync failed",
        );
        this.setStatus({
          ...this.status,
          lastAutoSyncError: {
            code: runtimeError.code,
            message: runtimeError.message,
            at: this.now().toISOString(),
          },
        });
        if (isAccessTokenRejection(error) && !authRecoveryAttempted) {
          authRecoveryAttempted = true;
          try {
            // Keep the recovery behind the same Send-policy barrier as the
            // original observation. This prevents Off -> On from replaying
            // plaintext that was observed before the policy transition.
            this.requireSendPolicy(sendPolicyRevision);
            this.automaticPublishAuthRecoveryInFlight = true;
            try {
              await this.reconcileConnectivity(
                "automatic-publish-auth-recovery",
                {
                  forceTokenRefresh: true,
                  waitForReady: true,
                },
              );
            } finally {
              this.automaticPublishAuthRecoveryInFlight = false;
            }
            // The retry must pass through requireSendPolicy even when the
            // recovery itself completed successfully.
            this.requireSendPolicy(sendPolicyRevision);
          } catch (recoveryError) {
            const recoveryRuntimeError = asRuntimeError(
              recoveryError,
              "SOCKET_PUBLISH_FAILED",
              "Automatic clipboard sync recovery failed",
            );
            this.setStatus({
              ...this.status,
              lastAutoSyncError: {
                code: recoveryRuntimeError.code,
                message: recoveryRuntimeError.message,
                at: this.now().toISOString(),
              },
            });
            this.pendingAutoObservation = null;
            return;
          }

          const pending = this.pendingAutoObservation;
          this.pendingAutoObservation = null;
          if (pending && pending.sequence > current.sequence) {
            current = pending;
          } else if (this.autoObservationSequence > current.sequence) {
            // A newer observation may be image-only and therefore have no
            // transportable payload to retain. Its sequence still cancels
            // this older retry.
            return;
          }
          continue;
        }
        if (
          runtimeError.code === "NO_VERIFIED_RECIPIENTS" ||
          runtimeError.code === "DEVICE_NOT_LOCALLY_TRUSTED" ||
          runtimeError.code === "DEVICE_NOT_REGISTERED" ||
          runtimeError.code === "SOCKET_NOT_READY" ||
          runtimeError.code === "AUTH_REQUIRED" ||
          runtimeError.code === "CLIPBOARD_SEND_DISABLED"
          || runtimeError.code === "CLIPBOARD_CONTENT_TOO_LARGE"
        ) {
          // These are eligibility failures, not transient publish failures.
          // Never carry a newer plaintext value across them.
          this.pendingAutoObservation = null;
          return;
        }
      }

      const pending = this.pendingAutoObservation;
      this.pendingAutoObservation = null;
      if (!pending || pending.sequence <= current.sequence) return;
      current = pending;
    }
  }

  async publishClipboardText(text: string): Promise<{ itemId: string; itemIds: string[]; projectionCount: number }> {
    this.requireSendPolicy(this.sendPolicyRevision);
    if (!isClipboardText(text)) {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned invalid text data",
      );
    }
    return this.publishClipboardPayload(clipboardPayloadFromPlainText(text));
  }

  private async startDirectClipboardTransfer(input: {
    session: RuntimeSession;
    identity: DeviceIdentity;
    recipient: ClientVerifiedDevice;
    payload: ClipboardPayloadV1;
    canonicalPlaintext: ClipboardBundleV1Bytes;
    sendPolicyRevision: number;
    observationSequence?: number;
  }): Promise<string | null> {
    const transport = this.dependencies.directTransport;
    const transferId = globalThis.crypto.randomUUID();
    const startStatus = (state: DirectTransportStatus, error?: string): void => {
      this.setStatus({
        ...this.status,
        directTransfers: [
          { ...state, ...(error ? { error } : {}) },
          ...(this.status.directTransfers ?? []).filter(
            (transfer) => transfer.transferId !== transferId,
          ),
        ].slice(0, 4),
      });
    };
    if (!transport?.startClipboardTransfer) {
      startStatus({
        transferId,
        remoteDeviceId: input.recipient.deviceId,
        state: "failed",
        startedAt: this.now().toISOString(),
      }, "The direct clipboard transport is unavailable");
      return null;
    }
    try {
      const prepared: PreparedDirectClipboardTransfer = await this.prepareDirect({
        userId: input.session.user.id,
        identity: input.identity,
        recipient: input.recipient,
        payload: input.payload,
        canonicalPlaintext: input.canonicalPlaintext,
        transferId,
        expiresAt: new Date(this.now().getTime() + LIVE_CLIPBOARD_TTL_MS),
      });
      if (
        input.observationSequence !== undefined &&
        this.autoObservationSequence > input.observationSequence
      ) {
        return null;
      }
      this.requireSendPolicy(input.sendPolicyRevision);
      await transport.startClipboardTransfer({
        transferId,
        recipientDeviceId: input.recipient.deviceId,
        manifest: JSON.stringify(prepared.manifest),
        encryptedChunks: prepared.encryptedChunks,
      });
      startStatus({
        transferId,
        remoteDeviceId: input.recipient.deviceId,
        state: "connecting",
        byteLength: prepared.manifest.plaintextByteLength,
        startedAt: this.now().toISOString(),
      });
      return transferId;
    } catch (error) {
      startStatus(
        {
          transferId,
          remoteDeviceId: input.recipient.deviceId,
          state: "failed",
          startedAt: this.now().toISOString(),
          finishedAt: this.now().toISOString(),
        },
        error instanceof Error ? error.message : "The direct clipboard transfer failed",
      );
      return null;
    }
  }

  async publishClipboardPayload(
    payload: ClipboardPayloadV1,
    observationSequence?: number,
  ): Promise<{ itemId: string; itemIds: string[]; projectionCount: number }> {
    const sendPolicyRevision = this.sendPolicyRevision;
    this.requireSendPolicy(sendPolicyRevision);
    try {
      validateClipboardPayloadV1(payload);
    } catch {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard payload is invalid",
      );
    }
    payload = this.applyPlanToPayload(payload);
    const session = this.requireSession();
    this.requireSocketReady();
    await this.ensureAccountInitialized();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "The device must be registered before publishing",
      );
    }
    const activeServerDevices = (await this.refreshServerDevices(session)).filter(
      (device) => device.trustState === "trusted",
    );
    const localRecipients =
      await this.dependencies.trustStore.listEncryptionRecipients(
        session.user.id,
      );
    const localDevice = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    const activeServerDevice = activeServerDevices.find(
      (device) => device.deviceId === identity.deviceId,
    );
    if (
      !activeServerDevice ||
      !identityMatchesServerDevice(identity, activeServerDevice)
    ) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "This device is no longer an active trusted device",
      );
    }
    const recipients = localRecipients.filter((localRecipient) => {
      const serverDevice = activeServerDevices.find(
        (device) => device.deviceId === localRecipient.deviceId,
      );
      return Boolean(
        serverDevice &&
          localRecipient.keyVersion === serverDevice.keyVersion &&
          localRecipient.signingPublicKey === serverDevice.signingPublicKey &&
          localRecipient.encryptionPublicKey ===
            serverDevice.encryptionPublicKey,
      );
    });
    // Keep the transport authenticated for onboarding, but do not let a
    // pending device publish even when another trusted recipient exists.
    if (!isLocallyVerified(localDevice) && recipients.length > 0) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Complete device pairing before syncing clipboard data",
      );
    }
    if (
      isLocallyVerified(localDevice) &&
      !recipients.some((item) => item.deviceId === identity.deviceId)
    ) {
      recipients.push(localDevice);
    }
    if (recipients.length === 0) {
      throw new RuntimeError(
        "NO_VERIFIED_RECIPIENTS",
        "No locally verified devices are available for encrypted delivery",
      );
    }
    const serverDeviceById = new Map(
      activeServerDevices.map((device) => [device.deviceId, device]),
    );
    const wireRecipients: ClipboardWireRecipient[] = recipients.map(
      (recipient) => ({
        local: recipient,
        server: serverDeviceById.get(recipient.deviceId) ?? {},
      }),
    );
    let routes;
    try {
      routes = selectClipboardDeliveryRoutes({
        payload,
        recipients: wireRecipients,
      });
      routes.direct = routes.direct.filter((direct) => {
        const recipientIndex = wireRecipients.indexOf(direct.recipient);
        return recipients[recipientIndex]?.deviceId !== identity.deviceId;
      });
      // Direct transfer is a Pro feature; the server refuses its signalling too.
      if (this.status.plan && !this.status.plan.limits.directTransfer) {
        routes.direct = [];
      }
    } catch (error) {
      if (error instanceof ClipboardWirePayloadTooLargeError) {
        throw new RuntimeError(
          "CLIPBOARD_CONTENT_TOO_LARGE",
          "The clipboard image is too large for the encrypted relay limit",
        );
      }
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        "This clipboard content has no compatible recipient representation",
      );
    }
    if (routes.relay.length === 0 && routes.direct.length === 0) {
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        routes.unsupported.length > 0 && getPngRepresentation(payload)
          ? "No selected device can receive this oversized clipboard image"
          : "No selected device can receive this clipboard image",
      );
    }

    const recipientByWire = new Map<
      ClipboardWireRecipient,
      ClientVerifiedDevice
    >();
    wireRecipients.forEach((wireRecipient, index) => {
      recipientByWire.set(wireRecipient, recipients[index]!);
    });
    const envelopes: ClipboardItemEnvelope[] = [];
    for (const projection of routes.relay) {
      const projectionRecipients = projection.recipients.map((recipient) =>
        recipientByWire.get(recipient),
      );
      if (projectionRecipients.some((recipient) => !recipient)) {
        throw new RuntimeError(
          "UNSUPPORTED_CLIPBOARD_CONTENT",
          "Clipboard recipient projection could not be resolved",
        );
      }
      try {
        envelopes.push(
          await this.encrypt({
            userId: session.user.id,
            identity,
            plaintext: projection.wirePayload.plaintext,
            contentType: projection.wirePayload.contentType,
            expiresAt: new Date(
              this.now().getTime() + LIVE_CLIPBOARD_TTL_MS,
            ),
            recipients: projectionRecipients as ClientVerifiedDevice[],
          }),
        );
      } catch (error) {
        if (error instanceof Error && /size limit/i.test(error.message)) {
          throw new RuntimeError(
            "CLIPBOARD_CONTENT_TOO_LARGE",
            "The clipboard image is too large for the encrypted relay limit",
          );
        }
        throw new RuntimeError(
          "ENCRYPTION_FAILED",
          "Clipboard encryption failed",
        );
      }
    }
    this.requireSendPolicy(sendPolicyRevision);
    // Record every envelope before emitting so synchronous self-echoes cannot
    // rewrite the clipboard and the projection decision survives a restart.
    for (const envelope of envelopes) {
      await this.dependencies.outboundItemStore.mark({
        userId: session.user.id,
        itemId: envelope.itemId,
        publishedAt: this.now().toISOString(),
        sourceDeviceId: envelope.sourceDeviceId,
      });
    }
    this.requireSendPolicy(sendPolicyRevision);
    for (const envelope of envelopes) await this.emitPublish(envelope);
    const directIds: string[] = [];
    for (const direct of routes.direct) {
      const recipient = recipientByWire.get(direct.recipient);
      if (!recipient || recipient.deviceId === identity.deviceId) continue;
      const transferId = await this.startDirectClipboardTransfer({
        session,
        identity,
        recipient,
        payload: direct.payload,
        canonicalPlaintext: direct.plaintext,
        sendPolicyRevision,
        observationSequence,
      });
      if (transferId) directIds.push(transferId);
    }
    if (envelopes.length === 0 && directIds.length === 0) {
      throw new RuntimeError(
        "DIRECT_TRANSPORT_FAILED",
        "No direct clipboard recipient was available",
      );
    }
    return {
      itemId: envelopes[0]?.itemId ?? directIds[0]!,
      itemIds: [...envelopes.map((envelope) => envelope.itemId), ...directIds],
      projectionCount: envelopes.length + directIds.length,
    };
  }

  async receiveClipboardItem(payload: unknown): Promise<void> {
    if (!this.socketReady || !this.status.syncReady || !this.session) return;
    const envelope = envelopeFromSocketPayload(payload);
    if (!envelope) {
      this.recordSyncError(
        "DECRYPTION_FAILED",
        "The incoming clipboard envelope is invalid",
      );
      return;
    }
    const session = this.session;
    const key = `${session.user.id}:${envelope.itemId}`;
    if (this.inboundInFlight.has(key)) return;
    const receivePolicyRevision = this.receivePolicyRevision;
    if (
      await this.dependencies.processedItemStore.has(
        session.user.id,
        envelope.itemId,
      )
    )
      return;
    this.inboundInFlight.add(key);
    try {
      const now = this.now().getTime();
      const expiresAt = parseStrictExpiry(envelope.expiresAt as string);
      if (
        expiresAt === null ||
        now >= expiresAt ||
        !isLiveExpiryWithinPolicy(expiresAt, now)
      ) {
        // Expired or otherwise non-live envelopes are expected stale data.
        // Consume them without decrypting so they cannot overwrite the OS
        // clipboard or surface as a cryptographic failure.
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "stale",
        });
        return;
      }

      if (!this.isReceivePolicyCurrent(receivePolicyRevision)) {
        // Receive-disabled is a deliberate local policy decision. The
        // envelope is consumed before decryption, including when receive was
        // disabled while the item was waiting on metadata, and is never
        // replayed after the preference changes.
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "receive-disabled",
        });
        return;
      }

      const locallyPublished = await this.dependencies.outboundItemStore.has(
        session.user.id,
        envelope.itemId,
      );
      const identity = await this.identityLoader(session.user.id);
      if (!identity || identity.keyVersion === null) {
        throw new RuntimeError(
          "DEVICE_NOT_REGISTERED",
          "The device is not registered",
        );
      }
      const source = await this.locallyVerifiedSource(
        session,
        envelope.sourceDeviceId,
      );
      if (!source) {
        throw new RuntimeError(
          "SOURCE_UNTRUSTED",
          "The clipboard source is not locally trusted",
        );
      }
      const selfEcho =
        locallyPublished && envelope.sourceDeviceId === identity.deviceId;
      if (!this.isReceivePolicyCurrent(receivePolicyRevision)) {
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "receive-disabled",
        });
        return;
      }
      let decrypted: { plaintextBytes: Uint8Array };
      try {
        decrypted = await this.decrypt({
          userId: session.user.id,
          identity,
          envelope,
          trustStore: this.dependencies.trustStore,
        });
      } catch {
        if (!this.isReceivePolicyCurrent(receivePolicyRevision)) {
          await this.dependencies.processedItemStore.mark({
            userId: session.user.id,
            itemId: envelope.itemId,
            processedAt: this.now().toISOString(),
            sourceDeviceId: envelope.sourceDeviceId,
            disposition: "receive-disabled",
          });
          return;
        }
        throw new RuntimeError(
          "DECRYPTION_FAILED",
          "Clipboard decryption or verification failed",
        );
      }
      if (!this.isReceivePolicyCurrent(receivePolicyRevision)) {
        // A receive-mode transition while decrypting invalidates this item.
        // Consume it without allowing the old plaintext to cross the new
        // policy boundary or replay after receive is enabled again.
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "receive-disabled",
        });
        return;
      }
      if (selfEcho) {
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "self-echo",
        });
        return;
      }
      if (
        envelope.contentType !== "text/plain" &&
        envelope.contentType !== CLIPBOARD_BUNDLE_V1_MIME
      ) {
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "unsupported-content",
        });
        return;
      }
      let clipboardPayload: ClipboardPayloadV1;
      try {
        clipboardPayload = envelope.contentType === "text/plain"
          ? decodeClipboardPlainText(decrypted.plaintextBytes)
          : decodeClipboardBundleV1(decrypted.plaintextBytes);
      } catch {
        const receiveEnabled = this.isReceivePolicyCurrent(receivePolicyRevision);
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: receiveEnabled ? "invalid-content" : "receive-disabled",
        });
        if (receiveEnabled) {
          this.recordSyncError(
            "INVALID_CLIPBOARD_CONTENT",
            "The incoming clipboard content is invalid",
          );
        }
        return;
      }
      // HTML and PNG stay inert data until all envelope and payload checks have
      // completed. PNG validation here is the last barrier before it can be
      // persisted as an encrypted-envelope reference or exposed to the popup.
      const plain = findPlainTextRepresentation(clipboardPayload);
      const receivedPng = getPngRepresentation(clipboardPayload);
      if (receivedPng) {
        try {
          getPngBytes(clipboardPayload);
        } catch {
          await this.dependencies.processedItemStore.mark({
            userId: session.user.id,
            itemId: envelope.itemId,
            processedAt: this.now().toISOString(),
            sourceDeviceId: envelope.sourceDeviceId,
            disposition: "invalid-content",
          });
          this.recordSyncError(
            "INVALID_CLIPBOARD_CONTENT",
            "The incoming clipboard image is invalid",
          );
          return;
        }
      }
      if (!this.isReceivePolicyCurrent(receivePolicyRevision)) {
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "receive-disabled",
        });
        return;
      }
      if (!this.dependencies.clipboardAdapter.writePayload && !plain && !receivedPng) {
        await this.dependencies.processedItemStore.mark({
          userId: session.user.id,
          itemId: envelope.itemId,
          processedAt: this.now().toISOString(),
          sourceDeviceId: envelope.sourceDeviceId,
          disposition: "unsupported-content",
        });
        this.recordSyncError(
          "UNSUPPORTED_CLIPBOARD_CONTENT",
          "This clipboard content cannot be applied by the current adapter",
        );
        return;
      }
      if (receivedPng) {
        await this.pendingAssistedImageStore.put({
          userId: session.user.id,
          itemId: envelope.itemId,
          sourceDeviceId: envelope.sourceDeviceId,
          ...(source.name ? { sourceDeviceName: source.name } : {}),
          receivedAt: this.now().toISOString(),
          expiresAt: String(envelope.expiresAt),
          hasPng: true,
          envelope,
        });
      }

      // The offscreen writer is intentionally given only the compatible text
      // projection. An image-only item never reaches WRITE_PAYLOAD.
      const textPayload = plain
        ? projectClipboardPayloadToText(clipboardPayload)
        : undefined;
      try {
        if (textPayload && this.dependencies.clipboardAdapter.writePayload) {
          await this.dependencies.clipboardAdapter.writePayload(textPayload);
        } else if (plain) {
          await this.dependencies.clipboardAdapter.writeText(plain!.data);
        }
      } catch {
        throw new RuntimeError(
          "CLIPBOARD_WRITE_FAILED",
          "The operating-system clipboard could not be written",
        );
      }
      await this.dependencies.processedItemStore.mark({
        userId: session.user.id,
        itemId: envelope.itemId,
        processedAt: this.now().toISOString(),
        sourceDeviceId: envelope.sourceDeviceId,
        disposition: receivedPng ? "pending-image" : "applied",
      });
      if (receivedPng) await this.refreshPendingAssistedImageStatus();
    } catch (error) {
      const runtimeError = asRuntimeError(
        error,
        "DECRYPTION_FAILED",
        "Clipboard delivery failed",
      );
      this.recordSyncError(runtimeError.code, runtimeError.message);
    } finally {
      this.inboundInFlight.delete(key);
    }
  }

  private async copyPendingImage(
    itemId: string,
  ): Promise<PendingAssistedImageCopyResult> {
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        "The pending clipboard image reference is invalid",
      );
    }
    const session = this.requireSession();
    const record = await this.pendingAssistedImageStore.get(
      session.user.id,
      itemId,
    );
    if (!record) {
      await this.refreshPendingAssistedImageStatus();
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        "The pending clipboard image has expired",
      );
    }
    const now = this.now().getTime();
    const expiresAt = parseStrictExpiry(record.expiresAt);
    if (
      expiresAt === null ||
      now >= expiresAt ||
      !isLiveExpiryWithinPolicy(expiresAt, now)
    ) {
      await this.pendingAssistedImageStore.remove(session.user.id, itemId);
      await this.refreshPendingAssistedImageStatus();
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        "The pending clipboard image has expired",
      );
    }
    if (!this.status.syncPreferences.receiveEnabled) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "Clipboard receiving is disabled for this device",
      );
    }

    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "The device is not registered",
      );
    }
    const source = await this.dependencies.trustStore.getDevice(
      session.user.id,
      record.sourceDeviceId,
    );
    if (!isLocallyVerified(source)) {
      await this.discardPendingImage(session.user.id, itemId);
      throw new RuntimeError(
        "SOURCE_UNTRUSTED",
        "The clipboard source is not locally trusted",
      );
    }
    let decrypted: { plaintextBytes: Uint8Array };
    let decryptedPayload: ClipboardPayloadV1 | undefined;
    try {
      if (record.directPackage) {
        const sourceForDirect = await this.requireActiveTrustedDirectSource(
          session,
          record.directPackage.manifest.sourceDeviceId,
          record.directPackage.manifest.sourceKeyVersion,
        );
        const direct = await this.decryptDirect({
          userId: session.user.id,
          identity,
          sourceDevice: sourceForDirect,
          manifest: record.directPackage.manifest,
          encryptedChunks: record.directPackage.encryptedChunks,
          now: this.now,
        });
        decrypted = { plaintextBytes: direct.plaintextBytes };
        decryptedPayload = direct.payload;
      } else {
        decrypted = await this.decrypt({
          userId: session.user.id,
          identity,
          envelope: record.envelope,
          trustStore: this.dependencies.trustStore,
        });
      }
    } catch {
      await this.discardPendingImage(session.user.id, itemId);
      throw new RuntimeError(
        "DECRYPTION_FAILED",
        "Clipboard decryption or verification failed",
      );
    }
    if (!record.directPackage && record.envelope.contentType !== CLIPBOARD_BUNDLE_V1_MIME) {
      await this.discardPendingImage(session.user.id, itemId);
      throw new RuntimeError(
        "INVALID_CLIPBOARD_CONTENT",
        "The pending clipboard image bundle is invalid",
      );
    }
    let pngBytes: Uint8Array;
    try {
      const payload = decryptedPayload ?? decodeClipboardBundleV1(decrypted.plaintextBytes);
      pngBytes = getPngBytes(payload);
    } catch {
      await this.discardPendingImage(session.user.id, itemId);
      throw new RuntimeError(
        "INVALID_CLIPBOARD_CONTENT",
        "The pending clipboard image is invalid",
      );
    }

    // Persist only a short-lived one-shot guard before returning the transient
    // bytes. This survives a worker restart between ClipboardItem.write() and
    // the next offscreen poll without persisting any image plaintext or
    // assuming the OS preserves the PNG byte representation.
    const suppressionExpiry = new Date(
      now + ASSISTED_PNG_SUPPRESSION_TTL_MS,
    ).toISOString();
    await this.assistedPngSuppressionStore.put({
      userId: session.user.id,
      itemId,
      expiresAt: suppressionExpiry,
    });
    // This is an immediate response to the explicit popup action only. Keep
    // the runtime message JSON-safe without persisting or exposing the image
    // through status, errors, or logs.
    return { itemId, pngBase64: bytesToBase64(pngBytes) };
  }

  private async completePendingImage(itemId: string): Promise<void> {
    const session = this.requireSession();
    let rebaselineSucceeded = false;
    try {
      if (!this.dependencies.clipboardAdapter.rebaselineFromClipboard) {
        throw new Error("The clipboard adapter cannot re-baseline the watcher");
      }
      await this.dependencies.clipboardAdapter.rebaselineFromClipboard();
      rebaselineSucceeded = true;
    } catch {
      // The focused-page write already succeeded. Keep the short-lived guard
      // so a watcher race or a failed offscreen read still consumes the next
      // PNG observation without turning the successful copy into a failure.
    }
    if (rebaselineSucceeded) {
      await this.assistedPngSuppressionStore
        .remove(session.user.id, itemId)
        .catch(() => undefined);
    }
    await this.pendingAssistedImageStore.remove(session.user.id, itemId);
    await this.refreshPendingAssistedImageStatus();
  }

  private async discardPendingImage(userId: string, itemId: string): Promise<void> {
    await this.pendingAssistedImageStore.remove(userId, itemId).catch(() => undefined);
    await this.assistedPngSuppressionStore.remove(userId, itemId).catch(() => undefined);
    await this.refreshPendingAssistedImageStatus().catch(() => undefined);
  }

  private async releasePendingImage(itemId: string): Promise<void> {
    const session = this.requireSession();
    await this.assistedPngSuppressionStore.remove(session.user.id, itemId);
  }

  private async handleCommand(command: RuntimeCommand): Promise<unknown> {
    switch (command.type) {
      case "runtime:get-status":
        await this.refreshPendingAssistedImageStatus().catch(() => undefined);
        if (this.session && !this.isSocketTransportReady()) {
          // Status is intentionally non-blocking. The recovery operation is
          // single-flight and continues after this response is delivered.
          void this.reconcileConnectivity("status").catch(() => undefined);
        }
        return this.getStatus();
      case "runtime:set-sync-preferences":
        if (!isSyncPreferencesCommand(command)) {
          throw new RuntimeError(
            "SYNC_PREFERENCES_INVALID",
            "Clipboard sync preferences must use boolean values",
          );
        }
        return this.setSyncPreferences({
          schemaVersion: 1,
          sendEnabled: command.sendEnabled,
          receiveEnabled: command.receiveEnabled,
        });
      case "runtime:send-current-clipboard": {
        this.requireSession();
        if (!this.status.syncPreferences.sendEnabled) {
          throw new RuntimeError(
            "CLIPBOARD_SEND_DISABLED",
            "Clipboard sending is disabled for this device",
          );
        }
        if (!this.isSocketTransportReady()) {
          await this.reconcileConnectivity("manual-send", {
            waitForReady: true,
          });
        }
        if (!this.isSocketTransportReady()) {
          throw new RuntimeError(
            "SOCKET_NOT_READY",
            "Copyyt is still reconnecting; the device connection is not ready",
          );
        }
        let payload: ClipboardPayloadV1;
        try {
          payload = this.dependencies.clipboardAdapter.readPayload
            ? await this.dependencies.clipboardAdapter.readPayload()
            : clipboardPayloadFromPlainText(
                await this.dependencies.clipboardAdapter.readText(),
              );
        } catch {
          throw new RuntimeError(
            "CLIPBOARD_READ_FAILED",
            "The operating-system clipboard could not be read",
          );
        }
        try {
          return await this.publishClipboardPayload(payload);
        } catch (error) {
          const runtimeError =
            error instanceof RuntimeError
              ? error
              : asRuntimeError(
                  error,
                  "SOCKET_PUBLISH_FAILED",
                  "The clipboard publish failed",
                );
          if (
            runtimeError.code !== "SOCKET_NOT_READY" &&
            runtimeError.code !== "SOCKET_PUBLISH_FAILED"
          ) {
            throw error;
          }

          // A sleeping laptop can leave Socket.IO's connected flag stale.
          // Recycle once after a transport publish failure, then use the same
          // shared publish path with the freshly authenticated socket.
          await this.reconcileConnectivity("manual-send-retry", {
            forceSocketRecycle: true,
            waitForReady: true,
          });
          return this.publishClipboardPayload(payload);
        }
      }
      case "runtime:copy-pending-image":
        return this.copyPendingImage(command.itemId);
      case "runtime:complete-pending-image":
        await this.completePendingImage(command.itemId);
        return this.getStatus();
      case "runtime:release-pending-image":
        await this.releasePendingImage(command.itemId);
        return this.getStatus();
      case "runtime:bootstrap-trust-anchor":
        return this.bootstrapTrustAnchor();
      case "runtime:export-recovery-credential":
        return this.exportRecoveryCredential();
      case "runtime:confirm-recovery-credential-saved":
        return this.confirmRecoveryCredentialSaved();
      case "runtime:recover-device":
        return this.recoverDevice(command.credential);
      case "runtime:list-devices":
        return this.listManagedDevices();
      case "runtime:reset-device":
        return this.resetRemovedDevice();
      case "runtime:request-account-reset-code":
        await this.dependencies
          .apiFactory(this.requireSession().accessToken)
          .auth.requestAccountResetCode();
        return this.getStatus();
      case "runtime:reset-account":
        return this.resetAccount(command.code);
      case "runtime:request-account-deletion-code":
        await this.dependencies
          .apiFactory(this.requireSession().accessToken)
          .auth.requestAccountDeletionCode();
        return this.getStatus();
      case "runtime:delete-account":
        return this.deleteAccount(command.code);
      case "runtime:update-profile":
        return this.updateProfileName(command.name);
      case "runtime:waitlist-status":
      case "runtime:join-waitlist": {
        const auth = this.dependencies.apiFactory(this.requireSession().accessToken).auth;
        const call = command.type === "runtime:join-waitlist" ? auth.joinWaitlist : auth.waitlistStatus;
        if (!call) return { joined: false };
        const { data } = await call("ios");
        return { joined: data?.joined === true };
      }
      case "runtime:revoke-device":
        return this.revokeAccountDevice(command.deviceId);
      case "runtime:refresh-onboarding":
        await this.refreshOnboarding();
        this.maybeConnectSocket();
        return this.getStatus();
      case "runtime:approve-pending-device":
        return this.approvePendingDevice(
          command.pendingDeviceId,
          command.confirmedFingerprint,
        );
      case "runtime:confirm-paired-approver":
        return this.confirmPairedApprover(
          command.approverDeviceId,
          command.confirmedFingerprint,
        );
      case "runtime:auth-google":
        return this.authenticate(() =>
          this.dependencies.apiFactory("").auth.googleSign(command.googleToken),
        );
      case "runtime:auth-passwordless":
        return (
          await this.dependencies
            .apiFactory("")
            .auth.signInPasswordless({ email: command.email })
        ).data;
      case "runtime:auth-verify-email":
        return this.authenticate(() =>
          this.dependencies.apiFactory("").auth.verifyEmail({
            email: command.email,
            ...(command.name ? { name: command.name } : {}),
            code: command.code,
          }),
        );
      case "runtime:auth-resend-email-otp":
        return (
          await this.dependencies
            .apiFactory("")
            .auth.resendEmailOtp(command.email)
        ).data;
      case "runtime:auth-refresh":
        return this.refreshSession();
      case "runtime:logout":
        return this.logout();
      case "runtime:test-clipboard":
        return this.testClipboard(command.marker);
      case "runtime:start-direct-test":
        return this.startDirectTestTransfer(command.recipientDeviceId);
      case "runtime:cancel-direct-test":
        await this.cancelDirectTestTransfer(command.transferId);
        return this.getStatus();
    }
  }

  private async setSyncPreferences(
    preferences: SyncPreferences,
  ): Promise<RuntimeStatus> {
    if (!isSyncPreferences(preferences)) {
      throw new RuntimeError(
        "SYNC_PREFERENCES_INVALID",
        "Clipboard sync preferences must use boolean values",
      );
    }

    const previous = { ...this.status.syncPreferences };
    const transitionRevision = ++this.syncPreferencesTransitionRevision;
    // Advance the in-memory barriers before awaiting durable persistence. A
    // clipboard operation can already be between awaits when this command is
    // accepted, so storage ordering cannot be the policy authority.
    this.applySyncPreferences(previous, preferences);

    // Serialize preference writes so rapid mode changes cannot leave storage
    // in an older state than the in-memory barrier that accepted them.
    const persistedPreferences = { ...preferences };
    const persistence = this.syncPreferencesWriteInFlight.then(
      () => this.dependencies.syncPreferencesStore.set(persistedPreferences),
      () => this.dependencies.syncPreferencesStore.set(persistedPreferences),
    );
    this.syncPreferencesWriteInFlight = persistence.then(
      () => undefined,
      () => undefined,
    );
    try {
      await persistence;
      this.lastPersistedSyncPreferences = { ...persistedPreferences };
    } catch {
      if (transitionRevision === this.syncPreferencesTransitionRevision) {
        // The failed transition is still the live state. Roll it back through
        // the same policy barrier so work that observed the failed mode can
        // never become valid again when the durable mode is restored.
        this.applySyncPreferences(
          this.status.syncPreferences,
          this.lastPersistedSyncPreferences,
          true,
        );
      }
      throw new RuntimeError(
        "SYNC_PREFERENCES_INVALID",
        "Clipboard sync preferences could not be saved",
      );
    }
    return this.getStatus();
  }

  private applySyncPreferences(
    previous: SyncPreferences,
    preferences: SyncPreferences,
    discardPendingAutoObservation = false,
  ): void {
    if (previous.sendEnabled !== preferences.sendEnabled) {
      this.sendPolicyRevision += 1;
    }
    if (previous.receiveEnabled !== preferences.receiveEnabled) {
      this.receivePolicyRevision += 1;
    }
    if (
      discardPendingAutoObservation ||
      !preferences.sendEnabled ||
      (!previous.sendEnabled && preferences.sendEnabled)
    ) {
      // Clear the latest-wins slot before persistence completes so a pending
      // observation cannot cross a policy barrier. Rollback explicitly clears
      // it even when the Send bit itself did not change.
      this.pendingAutoObservation = null;
    }

    if (!previous.sendEnabled && preferences.sendEnabled) {
      // Re-enable starts a fresh clipboard baseline. In particular, a failed
      // Off transition must not publish a value observed before the rollback.
      this.clipboardWatchResetRequested = true;
    }
    this.setStatus({
      ...this.status,
      syncPreferences: { ...preferences },
      ...(preferences.sendEnabled ? {} : { clipboardWatch: "stopped" }),
    });
  }

  private requireSendPolicy(revision: number): void {
    if (
      !this.status.syncPreferences.sendEnabled ||
      revision !== this.sendPolicyRevision
    ) {
      throw new RuntimeError(
        "CLIPBOARD_SEND_DISABLED",
        "Clipboard sending is disabled for this device",
      );
    }
  }

  private isReceivePolicyCurrent(revision: number): boolean {
    return (
      this.status.syncPreferences.receiveEnabled &&
      revision === this.receivePolicyRevision
    );
  }

  private async authenticate(
    request: () => Promise<AxiosResponse<SignInResponse>>,
  ): Promise<AuthenticatedRuntimeResult> {
    const response = await request();
    const result = authResult(response.data);
    await this.saveSession(response.data);
    try {
      await this.ensureAccountInitialized();
      await this.refreshOnboarding();
      this.maybeConnectSocket();
    } catch (error) {
      this.serverDeviceState = "unknown";
      this.recoveryKeyActive = false;
      this.report(
        error,
        "DEVICE_NOT_REGISTERED",
        "Signed in, but the device is not ready",
      );
    }
    return result;
  }

  private async refreshSession(): Promise<AuthenticatedRuntimeResult> {
    const session = await this.refreshAccessToken();
    const result: AuthenticatedRuntimeResult = {
      message: "Copyyt session refreshed",
      user: session.user,
    };
    try {
      await this.ensureAccountInitialized();
      await this.refreshOnboarding().catch(() => {
        this.serverDeviceState = "unknown";
        this.recoveryKeyActive = false;
        this.setOnboarding({ state: "unknown", bootstrapEligible: false });
      });
      this.maybeConnectSocket();
    } catch (error) {
      this.serverDeviceState = "unknown";
      this.recoveryKeyActive = false;
      this.report(
        error,
        "DEVICE_NOT_REGISTERED",
        "Signed in, but the device is not ready",
      );
    }
    return result;
  }

  private async refreshAccessToken(): Promise<RuntimeSession> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const session = this.requireSession();
    const sessionGeneration = this.sessionGeneration;
    this.refreshInFlight = (async () => {
      let response: AxiosResponse<SignInResponse>;
      try {
        response = await this.dependencies
          .apiFactory(session.accessToken)
          .auth.refreshTokens(
            isRuntimeSessionV2(session) ? session.refreshToken : undefined,
          );
      } catch (error) {
        if (refreshFailureIsDefinitive(error)) {
          await this.clearSession();
          throw new RuntimeError(
            "AUTH_REQUIRED",
            "The Copyyt session is no longer valid",
          );
        }
        if (isRefreshTokenNotFound(error)) {
          throw new RuntimeError(
            "AUTH_REQUIRED",
            isRuntimeSessionV2(session)
              ? "Copyyt could not find the durable refresh credential for this extension session. Sign in again to restore it."
              : "Copyyt could not restore this legacy session because its refresh credential is unavailable. Sign in again to continue.",
          );
        }
        throw error;
      }
      if (this.session !== session || this.sessionGeneration !== sessionGeneration) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "The Copyyt session changed before token refresh completed",
        );
      }
      await this.saveSession(response.data, {
        session,
        generation: sessionGeneration,
      });
      return this.session!;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async saveSession(
    response: SignInResponse,
    expected?: { session: RuntimeSession; generation: number },
  ): Promise<void> {
    if (typeof response.refreshToken !== "string" || !response.refreshToken.trim()) {
      throw new RuntimeError(
        "AUTH_REQUIRED",
        "The extension sign-in response did not include a refresh credential",
      );
    }
    const session: RuntimeSession = {
      schemaVersion: 2,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      user: response.user,
    };

    if (
      expected &&
      (this.session !== expected.session ||
        this.sessionGeneration !== expected.generation)
    ) {
      throw new RuntimeError(
        "AUTH_REQUIRED",
        "The Copyyt session changed before token refresh completed",
      );
    }

    if (!expected) this.sessionGeneration += 1;
    await this.enqueueSessionMutation(async () => {
      const previousUserId = this.session?.user.id;
      if (
        expected &&
        (this.session !== expected.session ||
          this.sessionGeneration !== expected.generation)
      ) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "The Copyyt session changed before token refresh completed",
        );
      }
      if (
        this.session &&
        this.session.user.id === response.user.id &&
        this.session.accessToken !== response.accessToken
      ) {
        this.destroySocket(this.socket);
      }
      if (previousUserId && previousUserId !== session.user.id) {
        await this.pendingAssistedImageStore.clearUser(previousUserId);
        await this.assistedPngSuppressionStore.clearUser(previousUserId);
      }
      await this.dependencies.sessionStore.set(session);
      // A clearSession() can invalidate a refresh while the storage write is
      // pending. The queued clear then runs after this write, leaving local
      // storage cleared rather than resurrecting the session.
      if (
        expected &&
        (this.session !== expected.session ||
          this.sessionGeneration !== expected.generation)
      ) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "The Copyyt session changed before token refresh completed",
        );
      }
      this.session = session;
      this.serverDeviceState = "unknown";
      this.recoveryKeyActive = false;
      this.setStatus({
        ...DEFAULT_STATUS,
        connectionState: "account-authenticated",
        signedIn: true,
        user: userFromSession(session),
        syncPreferences: { ...this.status.syncPreferences },
      });
    });
    await this.ensureRecoveryAlarm();
  }

  private enqueueSessionMutation(
    mutation: () => Promise<void>,
  ): Promise<void> {
    const operation = this.sessionMutationInFlight.then(mutation, mutation);
    this.sessionMutationInFlight = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async logout(): Promise<void> {
    const session = this.session;
    const refreshToken = session && isRuntimeSessionV2(session)
      ? session.refreshToken
      : undefined;

    // clearSession() invalidates the live session synchronously before it
    // awaits durable cleanup. Capture the token first, then start revocation
    // in parallel so the runtime remains alive for its bounded attempt.
    const localLogout = this.clearSession();
    const remoteLogout = session
      ? this.bestEffortBackendLogout(session.accessToken, refreshToken)
      : Promise.resolve();
    await localLogout;
    await remoteLogout;
  }

  private async bestEffortBackendLogout(
    accessToken: string,
    refreshToken?: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() =>
            this.dependencies
              .apiFactory(accessToken)
              .auth.logout(refreshToken),
          )
          .then(() => undefined)
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LOGOUT_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async clearSession(): Promise<void> {
    const previousUserId = this.session?.user.id;
    this.sessionGeneration += 1;
    this.session = null;
    this.destroySocket(this.socket);
    this.pendingConnectivityIntent = null;
    this.serverDeviceState = "unknown";
    this.recoveryKeyActive = false;
    this.setStatus({
      ...DEFAULT_STATUS,
      connectionState: "signed-out",
      syncPreferences: { ...this.status.syncPreferences },
    });
    const pendingImageCleanup = previousUserId
      ? Promise.all([
          this.pendingAssistedImageStore.clearUser(previousUserId),
          this.assistedPngSuppressionStore.clearUser(previousUserId),
        ]).catch(() => undefined)
      : Promise.resolve();
    await this.enqueueSessionMutation(() =>
      this.dependencies.sessionStore.clear(),
    );
    await pendingImageCleanup;
    await this.ensureRecoveryAlarm();
  }

  private async bootstrapTrustAnchor(): Promise<RuntimeStatus> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "Register this device before trusting it",
      );
    }
    let eligibility: boolean;
    try {
      eligibility = await this.getBootstrapEligibility(session, identity);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "PAIRING_FAILED") {
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
          error: { code: error.code, message: error.message },
        });
        throw error;
      }
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Initial trust eligibility could not be verified",
      );
    }
    if (!eligibility) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "This device is not eligible for initial trust bootstrap",
      );
    }
    const trustStore = this.dependencies.trustStore;
    await trustStore.bootstrapInitialTrustAnchor(session.user.id, identity, {
      name: identity.registration?.name,
      platform: identity.registration?.platform,
      capabilities: identity.registration?.capabilities,
      appVersion: identity.registration?.appVersion,
    });
    await this.updateDeviceStatus(identity);
    this.setOnboarding({ state: "complete", bootstrapEligible: false });
    return this.getStatus();
  }

  private async requireExportableRootIdentity(): Promise<DeviceIdentity> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "Register this device before exporting its recovery credential",
      );
    }
    const trust = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (trust?.trustState !== "root") {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only the account root device can export its recovery credential",
      );
    }
    if (identity.recoveryExportedAt) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "This recovery credential has already been exported",
      );
    }
    if (!this.recoveryKeyActive) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The server has not confirmed this device's recovery key yet; reconnect and try again",
      );
    }
    return identity;
  }

  /**
   * Returns the credential without sealing it. A popup can close before the
   * user copies it, so the private key is only deleted once the user confirms
   * the offline copy via runtime:confirm-recovery-credential-saved.
   */
  private async exportRecoveryCredential(): Promise<RecoveryCredentialResult> {
    const identity = await this.requireExportableRootIdentity();
    const privateKeyPkcs8Base64 = await this.exportRecoveryKey(identity);
    return {
      format: "copyyt-recovery-v1",
      rootDeviceId: identity.deviceId,
      privateKeyPkcs8Base64,
    };
  }

  private async confirmRecoveryCredentialSaved(): Promise<RuntimeStatus> {
    const identity = await this.requireExportableRootIdentity();
    await this.updateDeviceStatus(await this.sealRecoveryKey(identity));
    return this.getStatus();
  }

  private async recoverDevice(credential: string): Promise<RuntimeStatus> {
    const session = this.requireSession();
    const registered = await this.recoverDeviceWithCredential(
      this.dependencies.apiFactory(session.accessToken).devices,
      {
        userId: session.user.id,
        name: "Copyyt Chrome",
        capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
        appVersion: this.dependencies.appVersion,
        credential,
        trustStore: this.dependencies.trustStore,
      },
    );
    // The recovery endpoint has already authorized this identity. Keep the
    // success state visible even if a follow-up device snapshot is
    // temporarily unavailable (the durable trust transition above is atomic).
    this.serverDeviceState = "trusted";
    this.recoveryKeyActive = registered.recoveryKeyRotated;
    await this.updateDeviceStatus(registered.identity);
    // Re-register now so the server reports the active recovery key; for a
    // recovery whose rotation failed, this signed registration retries it.
    // A failure leaves recoveryRotationPending set; startup retries again.
    await this.ensureAccountInitialized().catch(() => undefined);
    this.setOnboarding({ state: "complete", bootstrapEligible: false });
    this.maybeConnectSocket();
    void this.refreshOnboarding().catch(() => undefined);
    return this.getStatus();
  }

  /**
   * Returns the locally verified source device. A device approved by the
   * root after this device last refreshed is unknown here until its approval
   * certificate is checked, so an unknown source triggers one trust refresh
   * (at most every UNKNOWN_SOURCE_REFRESH_MS, since the source ID is
   * relay-supplied) before the item is rejected.
   */
  private async locallyVerifiedSource(
    session: RuntimeSession,
    sourceDeviceId: string,
  ): Promise<LocalDeviceRecord | null> {
    const known = await this.dependencies.trustStore.getDevice(
      session.user.id,
      sourceDeviceId,
    );
    if (isLocallyVerified(known)) return known;
    const now = this.now().getTime();
    if (now - this.lastUnknownSourceRefreshAt < UNKNOWN_SOURCE_REFRESH_MS) {
      return null;
    }
    this.lastUnknownSourceRefreshAt = now;
    await this.refreshOnboarding().catch(() => undefined);
    const refreshed = await this.dependencies.trustStore.getDevice(
      session.user.id,
      sourceDeviceId,
    );
    return isLocallyVerified(refreshed) ? refreshed : null;
  }

  /**
   * A revoked identity can never be reactivated. Setting the device up again
   * discards it and all local trust for the account, then registers a brand
   * new identity, which must be paired and approved by the root like any new
   * device.
   */
  private async resetRemovedDevice(): Promise<RuntimeStatus> {
    const session = this.requireSession();
    if (this.serverDeviceState !== "revoked") {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "Only a device removed from the account can be set up again",
      );
    }
    return this.startWithFreshIdentity(session);
  }

  /**
   * Account reset, confirmed with an emailed code. The server revokes every
   * device and clears the recovery anchor; this device then starts over with
   * a new identity and is offered first-time setup as the new root.
   */
  private async resetAccount(code: number): Promise<RuntimeStatus> {
    const session = this.requireSession();
    if (!Number.isSafeInteger(code) || code < 100000 || code > 999999) {
      throw new RuntimeError("PAIRING_FAILED", "Enter the 6-digit code from the email");
    }
    await this.dependencies.apiFactory(session.accessToken).auth.resetAccount(code);
    return this.startWithFreshIdentity(session);
  }

  /**
   * Permanent account deletion, confirmed with an emailed code. The server
   * removes the account and all its data; this device then forgets its
   * identity, trust and session and returns to sign-in.
   */
  private async deleteAccount(code: number): Promise<RuntimeStatus> {
    const session = this.requireSession();
    if (!Number.isSafeInteger(code) || code < 100000 || code > 999999) {
      throw new RuntimeError("PAIRING_FAILED", "Enter the 6-digit code from the email");
    }
    await this.dependencies.apiFactory(session.accessToken).auth.deleteAccount(code);
    this.destroySocket(this.socket);
    await this.dependencies.trustStore.clearAccount?.(session.user.id);
    await this.clearIdentity(session.user.id);
    await this.clearSession();
    return this.getStatus();
  }

  /** Saves the account's display name and keeps the stored session in step. */
  private async updateProfileName(
    name: string,
  ): Promise<AuthenticatedRuntimeResult> {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > 100) {
      throw new RuntimeError("AUTH_REQUIRED", "Enter a name up to 100 characters");
    }
    const session = this.requireSession();
    const { data } = await this.dependencies
      .apiFactory(session.accessToken)
      .auth.updateProfile(trimmed);
    const savedName = data?.user?.name ?? trimmed;
    let user = session.user;
    await this.enqueueSessionMutation(async () => {
      // A sign-out or account switch while the request was in flight wins.
      const current = this.session;
      if (!current || current.user.id !== session.user.id) return;
      const updated = { ...current, user: { ...current.user, name: savedName } };
      await this.dependencies.sessionStore.set(updated);
      this.session = updated;
      user = updated.user;
      this.setStatus({ ...this.status, user: userFromSession(updated) });
    });
    return { message: "Profile updated", user };
  }

  /** Discards the local identity and trust for the account and registers anew. */
  private async startWithFreshIdentity(session: RuntimeSession): Promise<RuntimeStatus> {
    this.destroySocket(this.socket);
    await this.dependencies.trustStore.clearAccount?.(session.user.id);
    await this.clearIdentity(session.user.id);
    this.serverDeviceState = "unknown";
    this.recoveryKeyActive = false;
    await this.ensureAccountInitialized();
    await this.refreshOnboarding();
    this.maybeConnectSocket();
    return this.getStatus();
  }

  private async listManagedDevices(): Promise<ManagedDevice[]> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    const snapshot = await this.fetchDeviceSnapshot(session);
    const toManaged = (
      device: RegisteredDeviceResponse,
      state: ManagedDevice["state"],
    ): ManagedDevice => ({
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      state,
      current: device.deviceId === identity?.deviceId,
      root:
        state === "trusted" &&
        snapshot.accountRoot.state === "available" &&
        snapshot.accountRoot.device.deviceId === device.deviceId,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
    });
    return [
      ...snapshot.trustedDevices.map((device) => toManaged(device, "trusted")),
      ...snapshot.pendingDevices.map((device) => toManaged(device, "pending")),
    ];
  }

  /**
   * Revokes another device on the account. The backend only accepts the
   * request with a fresh signature from a currently trusted device, so this
   * device must be registered and locally verified.
   */
  private async revokeAccountDevice(deviceId: string): Promise<ManagedDevice[]> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "Register this device before managing other devices",
      );
    }
    if (deviceId === identity.deviceId) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "Remove this device from another trusted device",
      );
    }
    const self = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (!isLocallyVerified(self) || this.serverDeviceState !== "trusted") {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only a trusted device can remove other devices",
      );
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    const target = [...snapshot.trustedDevices, ...snapshot.pendingDevices].find(
      (device) => device.deviceId === deviceId,
    );
    if (!target) {
      throw new RuntimeError("PAIRING_FAILED", "That device is not on this account");
    }
    const timestamp = this.now().getTime();
    const nonce = globalThis.crypto.randomUUID();
    const signature = await signDeviceManagement({
      userId: session.user.id,
      identity,
      action: "revoke",
      targetDeviceId: target.deviceId,
      targetKeyVersion: target.keyVersion,
      timestamp,
      nonce,
    });
    await this.dependencies.apiFactory(session.accessToken).devices.revokeDevice(
      target.deviceId,
      {
        requestingDeviceId: identity.deviceId,
        requestingKeyVersion: identity.keyVersion,
        timestamp,
        nonce,
        signature,
      },
    );
    // Revocation is sticky locally: the device never receives keys again,
    // even if a stale server snapshot still lists it.
    await this.dependencies.trustStore.revokeDevice(session.user.id, target.deviceId);
    await this.refreshOnboarding().catch(() => undefined);
    return this.listManagedDevices();
  }

  private async getBootstrapEligibility(
    session: RuntimeSession,
    identity: DeviceIdentity,
    trustedDevices?: RegisteredDeviceResponse[],
    resolvedRoot?: AccountRootResolution,
  ): Promise<boolean> {
    const devices =
      trustedDevices ??
      trustedServerDevices(
        (
          await this.dependencies
            .apiFactory(session.accessToken)
            .devices.listDevices()
        ).data,
      );
    const accountRoot = resolvedRoot ?? resolveAccountRoot(devices);
    const rootDevice = requireAccountRoot(accountRoot);
    const current = devices.find(
      (device) => device.deviceId === identity.deviceId,
    );
    if (
      !current ||
      current.trustState !== "trusted" ||
      rootDevice.deviceId !== identity.deviceId ||
      !identityMatchesServerDevice(identity, current)
    ) {
      return false;
    }
    const localDevice = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (localDevice?.trustState === "root") return false;
    const localRecipients =
      await this.dependencies.trustStore.listEncryptionRecipients(
        session.user.id,
      );
    if (localRecipients.some((device) => device.trustState === "root"))
      return false;
    return true;
  }

  async approvePendingDevice(
    pendingDeviceId: string,
    confirmedFingerprint: string,
  ): Promise<RuntimeStatus> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "Register this device before approving a device",
      );
    }
    const localApprover = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (!isLocallyVerified(localApprover)) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only the initial account root can approve pairing",
      );
    }
    if (
      !isApprovingRoot(localApprover) ||
      !identityMatchesLocalDevice(identity, localApprover)
    ) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only the account root can approve pairing",
      );
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    if (snapshot.accountRoot.state !== "available") {
      const error = accountRootError(snapshot.accountRoot);
      this.setOnboarding({
        state: "pairing-required",
        bootstrapEligible: false,
        error: { code: error.code, message: error.message },
      });
      throw error;
    }
    const accountRoot = snapshot.accountRoot.device;
    if (
      accountRoot.deviceId !== identity.deviceId ||
      !identityMatchesServerDevice(identity, accountRoot)
    ) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only the account root device can approve pairing",
      );
    }
    const pending = snapshot.pendingDevices.find(
      (device) => device.deviceId === pendingDeviceId,
    );
    if (
      !pending ||
      !isActiveServerDevice(pending) ||
      pending.deviceId === identity.deviceId
    ) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The pending device is no longer available",
      );
    }
    const localPending =
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...pending,
        capabilities: validClipboardCapabilities(pending.capabilities),
        trustState: pending.trustState,
      });
    if (localPending.trustState !== "unverified") {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The pending device is already locally trusted or revoked",
      );
    }
    const fingerprint = await this.pairingFingerprintFor(identity, pending);
    if (fingerprint !== confirmedFingerprint) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The confirmed pairing fingerprint does not match",
      );
    }
    const approvalSignature = await this.signApproval({
      userId: session.user.id,
      approvingIdentity: identity,
      pendingDevice: {
        pendingDeviceId: pending.deviceId,
        pendingKeyVersion: pending.keyVersion,
        pendingEncryptionPublicKey: pending.encryptionPublicKey,
        pendingSigningPublicKey: pending.signingPublicKey,
      },
    });
    const certificate: DeviceApprovalCertificate = {
      approvingDeviceId: identity.deviceId,
      approvingKeyVersion: identity.keyVersion,
      pendingDeviceId: pending.deviceId,
      pendingKeyVersion: pending.keyVersion,
      pendingEncryptionPublicKey: pending.encryptionPublicKey,
      pendingSigningPublicKey: pending.signingPublicKey,
      approvalSignature,
    };
    const request: ApproveDeviceRequest = {
      approvingDeviceId: certificate.approvingDeviceId,
      pendingDeviceId: certificate.pendingDeviceId,
      approvalSignature: certificate.approvalSignature,
    };
    const approvalResponse = await this.dependencies
      .apiFactory(session.accessToken)
      .devices.approveDevice(request);
    const approved = approvalResponse.data;
    if (
      !approved ||
      typeof approved !== "object" ||
      approved.deviceId !== pending.deviceId ||
      approved.trustState !== "trusted" ||
      approved.keyVersion !== pending.keyVersion ||
      approved.signingPublicKey !== pending.signingPublicKey ||
      approved.encryptionPublicKey !== pending.encryptionPublicKey ||
      approved.approvedByDeviceId !== identity.deviceId ||
      approved.approvalSignature !== approvalSignature
    ) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The device approval response does not match the signed device",
      );
    }
    await this.dependencies.trustStore.applyApproval(
      session.user.id,
      certificate,
    );
    await this.updateDeviceStatus(identity);
    this.setOnboarding({ state: "complete", bootstrapEligible: false });
    return this.getStatus();
  }

  async confirmPairedApprover(
    approverDeviceId: string,
    confirmedFingerprint: string,
  ): Promise<RuntimeStatus> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError(
        "DEVICE_NOT_REGISTERED",
        "Register this device before completing pairing",
      );
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    // The root may approve before this device confirms the codes, in which
    // case the server already lists it as trusted. Server trust is not local
    // trust: this device still pins the approver and verifies the approval.
    const current =
      snapshot.pendingDevices.find(
        (device) => device.deviceId === identity.deviceId,
      ) ??
      snapshot.trustedDevices.find(
        (device) => device.deviceId === identity.deviceId,
      );
    if (snapshot.accountRoot.state !== "available") {
      const error = accountRootError(snapshot.accountRoot);
      this.setOnboarding({
        state: "pairing-required",
        bootstrapEligible: false,
        error: { code: error.code, message: error.message },
      });
      throw error;
    }
    const serverApprover = snapshot.accountRoot.device;
    if (!current) {
      // Removed while pairing (e.g. from the root's device list): show the
      // removed state instead of a misleading identity error.
      await this.refreshOnboarding().catch(() => undefined);
      throw new RuntimeError(
        "PAIRING_FAILED",
        "This device is no longer on your account. Set it up again to pair it.",
      );
    }
    if (!identityMatchesServerDevice(identity, current)) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The current device identity changed on the server",
      );
    }
    if (
      serverApprover.deviceId !== approverDeviceId ||
      serverApprover.deviceId === identity.deviceId
    ) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The paired device is not the account root",
      );
    }
    const localPending =
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...current,
        capabilities: validClipboardCapabilities(current.capabilities),
        trustState: current.trustState,
      });
    if (
      localPending.trustState !== "unverified" ||
      !identityMatchesLocalDevice(identity, localPending)
    ) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The pending device identity is not locally available",
      );
    }
    const localApprover =
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...serverApprover,
        capabilities: validClipboardCapabilities(serverApprover.capabilities),
        trustState: "trusted",
      });
    if (localApprover.trustState !== "unverified") {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The paired approver is already locally trusted or revoked",
      );
    }
    const fingerprint = await this.pairingFingerprintFor(
      identity,
      current,
      localApprover,
    );
    if (fingerprint !== confirmedFingerprint) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The confirmed pairing fingerprint does not match",
      );
    }
    await this.dependencies.trustStore.pinPairedApprover(
      session.user.id,
      identity,
      approverDeviceId,
      confirmedFingerprint,
    );
    const refreshedSnapshot = await this.fetchDeviceSnapshot(session);
    const refreshedCurrent = refreshedSnapshot.trustedDevices.find(
      (device) => device.deviceId === identity.deviceId,
    );
    if (
      refreshedCurrent &&
      identityMatchesServerDevice(identity, refreshedCurrent)
    ) {
      await this.reconcileBackendApprovals(
        session,
        refreshedSnapshot.trustedDevices,
      );
      const localCurrent = await this.dependencies.trustStore.getDevice(
        session.user.id,
        identity.deviceId,
      );
      if (localCurrent?.trustState === "verified") {
        this.serverDeviceState = "trusted";
        await this.updateDeviceStatus(identity);
        this.setOnboarding({ state: "complete", bootstrapEligible: false });
        this.maybeConnectSocket();
        return this.getStatus();
      }
    }
    this.serverDeviceState = "pending";
    await this.updateDeviceStatus(identity);
    this.setAccountAuthenticatedWithoutSocket();
    this.setOnboarding({
      state: "waiting-for-approval",
      bootstrapEligible: false,
      pairing: {
        role: "pending",
        fingerprint: confirmedFingerprint,
        approverDeviceId,
        pendingDeviceId: identity.deviceId,
        pendingDeviceName: current.name,
        pendingPlatform: current.platform,
      },
    });
    return this.getStatus();
  }

  private async reconcileBackendApprovals(
    session: RuntimeSession,
    trustedDevices: RegisteredDeviceResponse[],
  ): Promise<void> {
    // Upsert every server observation before walking certificates. The server
    // trust label is intentionally discarded by the trust store.
    for (const serverDevice of trustedDevices) {
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...serverDevice,
        capabilities: validClipboardCapabilities(serverDevice.capabilities),
        trustState: serverDevice.trustState,
      });
    }

    // A certificate may be reported before its approver's certificate. Each
    // promotion adds one locally trusted vertex, so at most N passes are
    // needed for N server devices. This is a bounded fixed-point walk.
    const maxPasses = Math.max(1, trustedDevices.length);
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let promoted = false;
      for (const serverDevice of trustedDevices) {
        if (
          typeof serverDevice.approvedByDeviceId !== "string" ||
          typeof serverDevice.approvalSignature !== "string"
        ) {
          continue;
        }
        const localPending = await this.dependencies.trustStore.getDevice(
          session.user.id,
          serverDevice.deviceId,
        );
        if (!localPending || localPending.trustState === "revoked") continue;
        if (isLocallyVerified(localPending)) continue;
        if (
          localPending.deviceId !== serverDevice.deviceId ||
          localPending.keyVersion !== serverDevice.keyVersion ||
          localPending.encryptionPublicKey !==
            serverDevice.encryptionPublicKey ||
          localPending.signingPublicKey !== serverDevice.signingPublicKey
        ) {
          throw new RuntimeError(
            "PAIRING_FAILED",
            "The approved device identity changed on the server",
          );
        }
        const localApprover = await this.dependencies.trustStore.getDevice(
          session.user.id,
          serverDevice.approvedByDeviceId,
        );
        if (!localApprover || !isLocallyVerified(localApprover)) continue;
        const certificate: DeviceApprovalCertificate = {
          approvingDeviceId: localApprover.deviceId,
          approvingKeyVersion: localApprover.keyVersion,
          pendingDeviceId: serverDevice.deviceId,
          pendingKeyVersion: serverDevice.keyVersion,
          pendingEncryptionPublicKey: serverDevice.encryptionPublicKey,
          pendingSigningPublicKey: serverDevice.signingPublicKey,
          approvalSignature: serverDevice.approvalSignature,
        };
        await this.dependencies.trustStore.applyApproval(
          session.user.id,
          certificate,
        );
        promoted = true;
      }
      if (!promoted) break;
    }
  }

  private async pairingFingerprintFor(
    identity: DeviceIdentity,
    pending: RegisteredDeviceResponse,
    approver?: LocalDeviceRecord,
  ): Promise<string> {
    const approvingDevice =
      approver ??
      (await this.dependencies.trustStore.getDevice(
        identity.userId,
        identity.deviceId,
      ));
    const approvingSigningPublicKey = approver
      ? approver.signingPublicKey
      : identity.signingPublicKeyBase64;
    const approvingEncryptionPublicKey = approver
      ? approver.encryptionPublicKey
      : identity.encryptionPublicKeyBase64;
    const approvingDeviceId = approver?.deviceId ?? identity.deviceId;
    const approvingKeyVersion = approver?.keyVersion ?? identity.keyVersion;
    if (
      !approvingDevice ||
      approvingDeviceId === pending.deviceId ||
      approvingKeyVersion === null ||
      approvingKeyVersion === undefined
    ) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The pairing identities are incomplete",
      );
    }
    return computePairingFingerprint({
      userId: identity.userId,
      approvingDeviceId,
      approvingKeyVersion,
      approvingSigningPublicKey,
      approvingEncryptionPublicKey,
      pendingDeviceId: pending.deviceId,
      pendingKeyVersion: pending.keyVersion,
      pendingSigningPublicKey: pending.signingPublicKey,
      pendingEncryptionPublicKey: pending.encryptionPublicKey,
    });
  }

  /** Best effort: an older backend without plans simply leaves it unknown. */
  private async refreshPlan(session: RuntimeSession): Promise<void> {
    const getPlan = this.dependencies.apiFactory(session.accessToken).auth.getPlan;
    if (!getPlan) return;
    try {
      const { data } = await getPlan();
      if (this.session?.user.id !== session.user.id || !isAccountPlan(data)) return;
      this.setStatus({ ...this.status, plan: data });
    } catch {
      // Keep the last known plan.
    }
  }

  /**
   * Free accounts don't send images. The server can't see content, so this is
   * enforced here: the image is dropped and any text alongside it still syncs.
   */
  private applyPlanToPayload(payload: ClipboardPayloadV1): ClipboardPayloadV1 {
    const plan = this.status.plan;
    if (!plan || plan.limits.images || !getPngRepresentation(payload)) return payload;
    const representations = payload.representations.filter(
      (representation) => representation.mime !== "image/png",
    );
    const withoutImage: ClipboardPayloadV1 = { ...payload, representations };
    try {
      validateClipboardPayloadV1(withoutImage);
    } catch {
      throw new RuntimeError(
        "UNSUPPORTED_CLIPBOARD_CONTENT",
        "Copying images between devices is part of Copyyt Pro",
      );
    }
    return withoutImage;
  }

  private async refreshOnboarding(): Promise<void> {
    const session = this.requireSession();
    void this.refreshPlan(session);
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      this.setOnboarding({ state: "unknown", bootstrapEligible: false });
      return;
    }
    const snapshot = await this.fetchDeviceSnapshot(session);
    const { trustedDevices, pendingDevices, accountRoot } = snapshot;
    for (const device of [...trustedDevices, ...pendingDevices]) {
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...device,
        capabilities: validClipboardCapabilities(device.capabilities),
        trustState: device.trustState,
      });
    }
    const currentPending = pendingDevices.find(
      (device) => device.deviceId === identity.deviceId,
    );
    const currentTrusted = trustedDevices.find(
      (device) => device.deviceId === identity.deviceId,
    );

    if (currentPending) {
      this.serverDeviceState = "pending";
      this.destroySocket(this.socket);
      this.setAccountAuthenticatedWithoutSocket();
      if (!identityMatchesServerDevice(identity, currentPending)) {
        throw new RuntimeError(
          "PAIRING_FAILED",
          "The current device identity changed on the server",
        );
      }
      if (accountRoot.state !== "available") {
        const error = accountRootError(accountRoot);
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      const approver = accountRoot.device;
      if (approver.deviceId === identity.deviceId) {
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
        });
        return;
      }
      const localApprover = await this.dependencies.trustStore.getDevice(
        session.user.id,
        approver.deviceId,
      );
      if (
        localApprover?.trustState === "root" &&
        localApprover.trustOrigin === "pairing" &&
        localApprover.pairedForDeviceId === identity.deviceId &&
        typeof localApprover.pairingFingerprint === "string"
      ) {
        this.setOnboarding({
          state: "waiting-for-approval",
          bootstrapEligible: false,
          pairing: {
            role: "pending",
            fingerprint: localApprover.pairingFingerprint,
            approverDeviceId: approver.deviceId,
            pendingDeviceId: identity.deviceId,
            pendingDeviceName: currentPending.name,
            pendingPlatform: currentPending.platform,
          },
        });
        return;
      }
      if (
        localApprover?.trustState === "root" ||
        localApprover?.trustState === "verified"
      ) {
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
        });
        return;
      }
      const fingerprint = await this.pairingFingerprintFor(
        identity,
        currentPending,
        localApprover ?? undefined,
      );
      this.setOnboarding({
        state: "pairing-ready",
        bootstrapEligible: false,
        pairing: {
          role: "pending",
          fingerprint,
          approverDeviceId: approver.deviceId,
          pendingDeviceId: identity.deviceId,
          pendingDeviceName: currentPending.name,
          pendingPlatform: currentPending.platform,
        },
      });
      return;
    }

    if (!currentTrusted) {
      this.serverDeviceState = "revoked";
      this.destroySocket(this.socket);
      this.setAccountAuthenticatedWithoutSocket();
      await this.updateDeviceStatus(identity);
      this.setOnboarding({ state: "unknown", bootstrapEligible: false });
      return;
    }

    this.serverDeviceState = "trusted";
    await this.reconcileBackendApprovals(session, trustedDevices);
    if (!identityMatchesServerDevice(identity, currentTrusted)) {
      throw new RuntimeError(
        "PAIRING_FAILED",
        "The current device identity changed on the server",
      );
    }
    const localCurrent = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );

    const bootstrapEligible =
      accountRoot.state === "available"
        ? await this.getBootstrapEligibility(
            session,
            identity,
            trustedDevices,
            accountRoot,
          )
        : false;
    if (bootstrapEligible) {
      this.setOnboarding({
        state: "bootstrap-eligible",
        bootstrapEligible: true,
      });
      return;
    }
    if (isLocallyVerified(localCurrent)) {
      await this.updateDeviceStatus(identity);
      const pending = [...pendingDevices].sort((left, right) =>
        left.deviceId.localeCompare(right.deviceId),
      )[0];
      if (accountRoot.state !== "available") {
        const error = accountRootError(accountRoot);
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
          error: { code: error.code, message: error.message },
          // The root was removed: this trusted device can take over as root
          // with the offline recovery credential.
          ...(accountRoot.state === "missing" ? { rootMissing: true } : {}),
        });
        return;
      }
      if (!pending) {
        this.setOnboarding({ state: "complete", bootstrapEligible: false });
        return;
      }
      if (
        !isApprovingRoot(localCurrent) ||
        accountRoot.device.deviceId !== identity.deviceId
      ) {
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
        });
        return;
      }
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        ...pending,
        capabilities: validClipboardCapabilities(pending.capabilities),
        trustState: pending.trustState,
      });
      const fingerprint = await this.pairingFingerprintFor(identity, pending);
      this.setOnboarding({
        state: "pairing-ready",
        bootstrapEligible: false,
        pairing: {
          role: "approver",
          fingerprint,
          approverDeviceId: identity.deviceId,
          pendingDeviceId: pending.deviceId,
          pendingDeviceName: pending.name,
          pendingPlatform: pending.platform,
        },
      });
      return;
    }
    if (accountRoot.state !== "available") {
      const error = accountRootError(accountRoot);
      this.setOnboarding({
        state: "pairing-required",
        bootstrapEligible: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    const approver = accountRoot.device;
    if (approver.deviceId === identity.deviceId) {
      this.setOnboarding({
        state: "pairing-required",
        bootstrapEligible: false,
      });
      return;
    }
    await this.dependencies.trustStore.upsertServerReportedDevice({
      userId: session.user.id,
      ...approver,
      capabilities: validClipboardCapabilities(approver.capabilities),
      trustState: approver.trustState,
    });
    const localApprover = await this.dependencies.trustStore.getDevice(
      session.user.id,
      approver.deviceId,
    );
    if (
      localApprover?.trustState === "root" &&
      localApprover.trustOrigin === "pairing" &&
      localApprover.pairedForDeviceId === identity.deviceId &&
      typeof localApprover.pairingFingerprint === "string"
    ) {
      this.setOnboarding({
        state: "waiting-for-approval",
        bootstrapEligible: false,
        pairing: {
          role: "pending",
          fingerprint: localApprover.pairingFingerprint,
          approverDeviceId: approver.deviceId,
          pendingDeviceId: identity.deviceId,
          pendingDeviceName: currentTrusted.name,
          pendingPlatform: currentTrusted.platform,
        },
      });
      return;
    }
    const fingerprint = await this.pairingFingerprintFor(
      identity,
      currentTrusted,
      localApprover ?? undefined,
    );
    this.setOnboarding({
      state: "pairing-ready",
      bootstrapEligible: false,
      pairing: {
        role: "pending",
        fingerprint,
        approverDeviceId: approver.deviceId,
        pendingDeviceId: identity.deviceId,
        pendingDeviceName: currentTrusted.name,
        pendingPlatform: currentTrusted.platform,
      },
    });
  }

  private async testClipboard(
    marker: string,
  ): Promise<{ ping: boolean; readText: boolean; writeText: boolean }> {
    if (typeof marker !== "string" || marker.length === 0) {
      throw new RuntimeError(
        "CLIPBOARD_WRITE_FAILED",
        "The clipboard test marker is invalid",
      );
    }
    if (this.dependencies.clipboardAdapter.ping) {
      await this.dependencies.clipboardAdapter.ping();
    }
    await this.dependencies.clipboardAdapter.writeText(marker);
    const value = await this.dependencies.clipboardAdapter.readText();
    if (typeof value !== "string") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned non-text data",
      );
    }
    await this.dependencies.clipboardAdapter.writeText(marker);
    return { ping: true, readText: value === marker, writeText: true };
  }

  private requireSession(): RuntimeSession {
    if (!this.session)
      throw new RuntimeError("AUTH_REQUIRED", "Sign in to use Copyyt");
    return this.session;
  }

  private requireSocketReady(): void {
    if (
      !this.socket ||
      !this.socketReady ||
      !this.socket.connected ||
      !this.status.socket.connected ||
      !this.status.socket.deviceAuthenticated ||
      this.status.connectionState !== "ready"
    ) {
      throw new RuntimeError(
        "SOCKET_NOT_READY",
        "The Copyyt device connection is not ready",
      );
    }
  }

  private async ensureAccountInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    const session = this.requireSession();
    this.initialization = (async () => {
      let identity = await this.identityLoader(session.user.id);
      if (!identity) identity = await this.identityCreator(session.user.id);
      try {
        const registered = await this.registerDevice(
          this.dependencies.apiFactory(session.accessToken).devices,
          {
            userId: session.user.id,
            name: "Copyyt Chrome",
            capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
            appVersion: this.dependencies.appVersion,
            trustStore: this.dependencies.trustStore,
          },
        );
        identity = registered.identity;
        this.recoveryKeyActive = registered.device.recoveryKeyActive === true;
        this.serverDeviceState =
          registered.device.trustState === "trusted"
            ? "trusted"
            : registered.device.trustState === "pending"
              ? "pending"
              : registered.device.trustState === "revoked"
                ? "revoked"
                : "unknown";
      } catch {
        if (identity.keyVersion === null) {
          throw new RuntimeError(
            "DEVICE_NOT_REGISTERED",
            "The device is not registered with Copyyt",
          );
        }
      }
      await this.updateDeviceStatus(identity);
    })().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  private async updateDeviceStatus(identity: DeviceIdentity): Promise<void> {
    const trust = await this.dependencies.trustStore.getDevice(
      identity.userId,
      identity.deviceId,
    );
    const locallyReady = isLocallyVerified(trust);
    this.setStatus({
      ...this.status,
      connectionState:
        this.serverDeviceState === "trusted" &&
        this.socketReady &&
        this.status.socket.connected
          ? "ready"
          : this.serverDeviceState === "pending" ||
              this.serverDeviceState === "revoked"
            ? "account-authenticated"
            : this.status.connectionState,
      device: {
        deviceId: identity.deviceId,
        ...(identity.keyVersion === null
          ? {}
          : { keyVersion: identity.keyVersion }),
        registration:
          identity.keyVersion === null ? "not-registered" : "registered",
        trustState: trust?.trustState ?? "unverified",
        recoveryAvailable:
          this.recoveryKeyActive &&
          typeof identity.recoveryPublicKeyBase64 === "string" &&
          identity.recoveryPublicKeyBase64.length > 0,
        ...(this.serverDeviceState === "revoked" ? { removed: true } : {}),
        // A root whose recovery key the server has not confirmed (e.g. a
        // recovery whose key rotation failed). Registration retries it.
        ...(trust?.trustState === "root" && !this.recoveryKeyActive
          ? { recoveryRotationPending: true }
          : {}),
        ...(identity.recoveryExportedAt
          ? { recoveryExportedAt: identity.recoveryExportedAt }
          : {}),
      },
      syncReady:
        this.serverDeviceState === "trusted" &&
        this.socketReady &&
        locallyReady,
    });
  }

  private setAccountAuthenticatedWithoutSocket(): void {
    if (!this.session) return;
    this.socketReady = false;
    this.clipboardWatchResetRequested = true;
    this.setStatus({
      ...this.status,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(this.session),
      socket: { connected: false, deviceAuthenticated: false },
      syncReady: false,
      clipboardWatch: "stopped",
    });
  }

  private maybeConnectSocket(): void {
    if (!this.session || this.serverDeviceState !== "trusted") {
      this.destroySocket(this.socket);
      this.setAccountAuthenticatedWithoutSocket();
      return;
    }
    this.connectSocket();
  }

  private connectSocket(): void {
    const session = this.requireSession();
    if (this.serverDeviceState !== "trusted") {
      this.setAccountAuthenticatedWithoutSocket();
      return;
    }
    if (this.socket && this.socketAccountId === session.user.id) {
      if (this.isSocketTransportReady()) return;
      if (this.socket.connected) {
        // A connected transport that is not fully Copyyt-ready is not
        // reusable. Recycle it through the listener-safe path and continue
        // into the fresh-socket branch below.
        this.destroySocket(this.socket);
      }
    }
    if (this.socket && this.socketAccountId === session.user.id) {
      this.socketReady = false;
      this.setStatus({
        ...this.status,
        connectionState: "connecting",
        socket: { connected: false, deviceAuthenticated: false },
        syncReady: false,
      });
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.destroySocket(this.socket);
    this.socketReady = false;
    this.socketAccountId = session.user.id;
    this.setStatus({
      ...this.status,
      connectionState: "connecting",
      signedIn: true,
      user: userFromSession(session),
      socket: { connected: false, deviceAuthenticated: false },
    });
    const socket = this.dependencies.socketFactory(
      this.dependencies.socketUrl,
      {
        auth: { token: session.accessToken },
        transports: ["websocket"],
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 10000,
      },
    );
    this.socket = socket;
    const onConnect = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      this.challengeReceived = false;
      this.setStatus({
        ...this.status,
        connectionState: "account-authenticated",
        syncReady: false,
        clipboardWatch: "stopped",
        socket: { connected: true, deviceAuthenticated: false },
      });
    };
    const onDisconnect = (reason?: unknown): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      this.challengeInFlight = false;
      this.pendingAutoObservation = null;
      this.setConnectionError(
        "SOCKET_NOT_READY",
        reason instanceof Error
          ? `Socket disconnected: ${reason.message}`
          : typeof reason === "string"
            ? `Socket disconnected: ${reason}`
            : "Copyyt is reconnecting after a socket disconnect",
      );
      if (reason === "io server disconnect") {
        void this.reconcileConnectivity("socket-disconnect", {
          forceSocketRecycle: true,
        }).catch(() => undefined);
      } else if (reason !== "io client disconnect") {
        // Socket.IO normally retries transport closes itself. The explicit
        // reconciliation also covers implementations/reasons where connect()
        // is required, while the microtask keeps the disconnect state
        // observable to the event that delivered it.
        queueMicrotask(() => {
          if (this.socket !== socket || !this.session) return;
          void this.reconcileConnectivity("socket-disconnect").catch(
            () => undefined,
          );
        });
      }
    };
    const onConnectError = (error?: unknown): void => {
      if (this.socket !== socket) return;

      this.socketReady = false;
      this.markTransportDisconnected(
        error instanceof Error
          ? `Socket connection failed: ${error.message}`
          : "Copyyt is reconnecting after a socket connection failure",
      );

      if (isSocketAuthenticationFailure(error)) {
        if (this.challengeReceived) {
          void this.handleDeviceAuthenticationFailure(socket);
        } else {
          void this.reconcileConnectivity("socket-auth-failure", {
            forceSocketRecycle: true,
            forceTokenRefresh: true,
          }).catch(() => undefined);
        }
      } else {
        void this.reconcileConnectivity("socket-connect-error").catch(
          () => undefined,
        );
      }
    };
    const onChallenge = (payload: unknown): void => {
      if (this.socket !== socket) return;
      this.challengeReceived = true;
      void this.authenticateDevice(socket, payload);
    };
    const onReady = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = true;
      const syncReady =
        this.serverDeviceState === "trusted" &&
        isLocallyVerifiedStatus(this.status);
      this.setStatus({
        ...this.status,
        connectionState: "ready",
        syncReady,
        socket: { connected: true, deviceAuthenticated: true },
        ...(this.recoveryReason
          ? {
              lastRecoveredAt: this.now().toISOString(),
              lastRecoveryReason: this.recoveryReason,
            }
          : {}),
      });
      this.recoveryReason = null;
      // The pre-connect reconciliation has already refreshed membership. This
      // second refresh catches trust changes that raced the challenge without
      // delaying the established transport event.
      void this.refreshServerDevices(session).then(
        () => {
          if (this.socket !== socket) return;
          const locallyTrusted = isLocallyVerifiedStatus(this.status);
          this.setStatus({
            ...this.status,
            syncReady:
              this.serverDeviceState === "trusted" && locallyTrusted,
          });
        },
        () => {
          if (this.socket !== socket) return;
          this.recordSyncError(
            "SOCKET_PUBLISH_FAILED",
            "Device trust synchronization failed",
          );
        },
      );
    };
    const onAuthFailure = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      if (this.challengeReceived) {
        void this.handleDeviceAuthenticationFailure(socket);
      } else {
        this.markTransportDisconnected(
          "Copyyt is reconnecting after account socket authentication failed",
        );
        void this.reconcileConnectivity("socket-auth-failure", {
          forceSocketRecycle: true,
          forceTokenRefresh: true,
        })
          .catch(() => undefined)
          .then(() => {
            if (this.session && !this.isSocketTransportReady()) {
              this.setConnectionError(
                "AUTH_REQUIRED",
                "The account socket authentication was rejected",
              );
            }
          });
      }
    };
    const onClipboardItem = (payload: unknown): void => {
      if (this.socket !== socket) return;
      void this.receiveClipboardItem(payload);
    };
    const onDirectSignal = (payload: unknown): void => {
      if (this.socket !== socket) return;
      void this.receiveDirectSignal(payload);
    };

    this.attachSocketListeners(socket, [
      ["connect", onConnect],
      ["disconnect", onDisconnect],
      ["connect_error", onConnectError],
      ["auth:challenge", onChallenge],
      ["auth:ready", onReady],
      ["auth:failure", onAuthFailure],
      ["clipboard:item", onClipboardItem],
      ["direct:signal", onDirectSignal],
    ]);
    socket.connect();
  }

  private attachSocketListeners(
    socket: SocketLike,
    listeners: Array<[
      string,
      (...args: unknown[]) => void,
    ]>,
  ): void {
    this.detachSocketListeners(socket);
    const bindings = listeners.map(([event, listener]) => ({ event, listener }));
    this.socketListeners.set(socket, bindings);
    for (const { event, listener } of bindings) socket.on(event, listener);
  }

  private detachSocketListeners(socket: SocketLike): void {
    const bindings = this.socketListeners.get(socket);
    if (!bindings) return;
    if (socket.off) {
      for (const { event, listener } of bindings) {
        socket.off(event, listener);
      }
    }
    this.socketListeners.delete(socket);
  }

  private async authenticateDevice(
    socket: SocketLike,
    payload: unknown,
  ): Promise<void> {
    if (this.challengeInFlight || this.socket !== socket || !socket.connected) {
      return;
    }
    this.challengeInFlight = true;
    try {
      const session = this.requireSession();
      const identity = await this.identityLoader(session.user.id);
      if (!identity || identity.keyVersion === null) {
        throw new RuntimeError(
          "DEVICE_NOT_REGISTERED",
          "The device must be registered before socket authentication",
        );
      }
      const parts = challengeParts(payload, socket.id ?? "");
      if (
        !parts ||
        (parts.userId !== undefined && parts.userId !== session.user.id)
      ) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "The socket authentication challenge is invalid",
        );
      }
      this.setStatus({
        ...this.status,
        connectionState: "device-authenticating",
        socket: { connected: true, deviceAuthenticated: false },
        syncReady: false,
        clipboardWatch: "stopped",
      });
      const signature = await this.signChallenge({
        userId: session.user.id,
        identity,
        socketId: parts.socketId,
        challenge: parts.challenge,
      });
      if (this.socket !== socket || !socket.connected) return;
      socket.emit("auth:device", {
        deviceId: identity.deviceId,
        keyVersion: identity.keyVersion,
        signature,
      });
    } catch (error) {
      const runtimeError = asRuntimeError(
        error,
        "AUTH_REQUIRED",
        "The device socket authentication failed",
      );
      this.setConnectionError(runtimeError.code, runtimeError.message);
      this.socketReady = false;
    } finally {
      this.challengeInFlight = false;
    }
  }

  private async handleDeviceAuthenticationFailure(
    socket: SocketLike,
  ): Promise<void> {
    if (this.socket !== socket) return;
    this.destroySocket(socket);
    try {
      await this.refreshOnboarding();
      if (this.serverDeviceState === "pending") {
        this.setAccountAuthenticatedWithoutSocket();
        return;
      }
      if (this.serverDeviceState === "revoked") {
        this.setConnectionError(
          "DEVICE_AUTH_FAILED",
          "This device is no longer trusted by Copyyt",
        );
        return;
      }
      this.setConnectionError(
        "DEVICE_AUTH_FAILED",
        "Copyyt rejected this device's authentication",
      );
    } catch {
      this.setConnectionError(
        "DEVICE_AUTH_FAILED",
        "Copyyt could not verify this device",
      );
    }
  }

  private destroySocket(socket: SocketLike | null): void {
    if (!socket) return;
    const isCurrent = this.socket === socket;
    this.detachSocketListeners(socket);
    if (isCurrent) {
      this.clearAllDirectSignalValidations();
      const hasActiveDirectTransfer = (this.status.directTransfers ?? []).some(
        (transfer) =>
          transfer.state !== "succeeded" &&
          transfer.state !== "failed" &&
          transfer.state !== "cancelled",
      );
      if (hasActiveDirectTransfer && this.dependencies.directTransport) {
        void this.dependencies.directTransport
          .cancelAll("Copyyt socket is unavailable")
          .catch(() => undefined);
      }
      this.socket = null;
      this.socketAccountId = null;
      this.socketReady = false;
      this.challengeInFlight = false;
      this.challengeReceived = false;
      if (!this.isAutomaticPublishAuthRecoveryActive()) {
        this.pendingAutoObservation = null;
      }
      this.clipboardWatchResetRequested = true;
      this.setStatus({
        ...this.status,
        connectionState: this.session ? "account-authenticated" : "signed-out",
        socket: { connected: false, deviceAuthenticated: false },
        syncReady: false,
        clipboardWatch: "stopped",
      });
    }
    try {
      socket.disconnect();
    } catch {
      // A stale socket is best-effort cleanup during token replacement.
    }
  }

  private isAutomaticPublishAuthRecoveryActive(): boolean {
    return this.automaticPublishAuthRecoveryInFlight;
  }

  private markTransportDisconnected(message: string): void {
    this.socketReady = false;
    this.challengeInFlight = false;
    this.pendingAutoObservation = null;
    this.clipboardWatchResetRequested = true;
    this.setConnectionRecovering("SOCKET_NOT_READY", message);
  }

  /*
   * The old socket-authentication-specific recovery path was intentionally
   * removed. Token refresh, socket replacement, membership refresh, and
   * challenge authentication all go through reconcileConnectivity so there is
   * one single-flight owner for recovery.
   */

  private async fetchDeviceSnapshot(
    session: RuntimeSession,
  ): Promise<DeviceSnapshot> {
    const api = this.dependencies.apiFactory(session.accessToken).devices;
    // Devices only move pending -> trusted, so read pending first. Reading
    // both at once (or trusted first) can miss a device approved between the
    // two reads, which then looks as if it had vanished from the account.
    const pendingResponse = await api.listPendingDevices();
    const trustedResponse = await api.listDevices();
    const trustedDevices = trustedServerDevices(trustedResponse.data);
    const trustedIds = new Set(trustedDevices.map((device) => device.deviceId));
    return {
      trustedDevices,
      pendingDevices: pendingServerDevices(pendingResponse.data).filter(
        (device) => !trustedIds.has(device.deviceId),
      ),
      accountRoot: resolveAccountRoot(trustedDevices),
    };
  }

  private async refreshServerDevices(
    session: RuntimeSession,
  ): Promise<RegisteredDeviceResponse[]> {
    // A full trust refresh is an invalidation boundary for signaling bindings.
    this.clearAllDirectSignalValidations();
    const snapshot = await this.fetchDeviceSnapshot(session);
    const devices = [...snapshot.trustedDevices, ...snapshot.pendingDevices];
    for (const device of devices) {
      await this.dependencies.trustStore.upsertServerReportedDevice({
        userId: session.user.id,
        deviceId: device.deviceId,
        keyVersion: device.keyVersion,
        encryptionPublicKey: device.encryptionPublicKey,
        signingPublicKey: device.signingPublicKey,
        name: device.name,
        platform: device.platform,
        capabilities: validClipboardCapabilities(device.capabilities),
        appVersion: device.appVersion,
        trustState: device.trustState,
      });
    }
    const identity = await this.identityLoader(session.user.id);
    if (identity) {
      this.setStatus({
        ...this.status,
        directTargets: snapshot.trustedDevices
          .filter((device) => device.deviceId !== identity.deviceId)
          .map((device) => ({
            deviceId: device.deviceId,
            name: device.name,
            platform: device.platform,
            keyVersion: device.keyVersion,
          })),
      });
      const currentPending = snapshot.pendingDevices.find(
        (device) => device.deviceId === identity.deviceId,
      );
      const currentTrusted = snapshot.trustedDevices.find(
        (device) => device.deviceId === identity.deviceId,
      );
      this.serverDeviceState = currentPending
        ? "pending"
        : currentTrusted
          ? "trusted"
          : "revoked";
      await this.reconcileBackendApprovals(session, snapshot.trustedDevices);
      await this.updateDeviceStatus(identity);
      if (
        (this.serverDeviceState === "trusted" ||
          this.serverDeviceState === "pending") &&
        snapshot.accountRoot.state !== "available"
      ) {
        const error = accountRootError(snapshot.accountRoot);
        this.setOnboarding({
          state: "pairing-required",
          bootstrapEligible: false,
          error: { code: error.code, message: error.message },
        });
      }
      if (this.serverDeviceState !== "trusted") {
        await this.pendingAssistedImageStore.clearUser(session.user.id).catch(() => undefined);
        await this.assistedPngSuppressionStore.clearUser(session.user.id).catch(() => undefined);
        if ((this.status.pendingAssistedImages?.length ?? 0) > 0) {
          this.setStatus({ ...this.status, pendingAssistedImages: [] });
        }
        this.destroySocket(this.socket);
        this.setAccountAuthenticatedWithoutSocket();
      }
    }
    return snapshot.trustedDevices;
  }

  private async emitPublish(envelope: ClipboardItemEnvelope): Promise<void> {
    this.requireSocketReady();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new RuntimeError(
              "SOCKET_PUBLISH_FAILED",
              "The clipboard publish acknowledgement timed out",
            ),
          );
        }
      }, 10000);
      const finish = (ack: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isAcknowledgement(ack, envelope.itemId)) resolve();
        else
          reject(
            new RuntimeError(
              "SOCKET_PUBLISH_FAILED",
              "The server rejected the clipboard publish",
            ),
          );
      };
      try {
        this.socket!.emit("clipboard:publish", envelope, finish);
      } catch {
        clearTimeout(timer);
        reject(
          new RuntimeError(
            "SOCKET_PUBLISH_FAILED",
            "The clipboard publish failed",
          ),
        );
      }
    });
  }

  private async emitDirectSignal(signal: DirectSignalRequest): Promise<void> {
    this.requireSocketReady();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new RuntimeError(
            "DIRECT_TRANSPORT_FAILED",
            "The direct signalling acknowledgement timed out",
          ),
        );
      }, 10_000);
      const finish = (ack: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isDirectAcknowledgement(ack, signal.transferId)) {
          resolve();
        } else {
          reject(
            new RuntimeError(
              "DIRECT_TRANSPORT_FAILED",
              "The server rejected the direct signal",
            ),
          );
        }
      };
      try {
        this.socket!.emit("direct:signal", signal, finish);
      } catch {
        clearTimeout(timer);
        reject(
          new RuntimeError(
            "DIRECT_TRANSPORT_FAILED",
            "The direct signal could not be sent",
          ),
        );
      }
    });
  }

  private requestClipboardWatcherReconcile(): void {
    this.clipboardWatchDesired = this.isAutomaticSyncEligible(false);
    if (
      !this.dependencies.clipboardAdapter.startWatching ||
      !this.dependencies.clipboardAdapter.stopWatching
    ) {
      if (!this.clipboardWatchDesired && this.status.clipboardWatch !== "stopped") {
        this.status = { ...this.status, clipboardWatch: "stopped" };
      }
      return;
    }
    if (this.clipboardWatchReconcileInFlight) return;
    const operation = Promise.resolve().then(() =>
      this.reconcileClipboardWatcher(),
    );
    this.clipboardWatchReconcileInFlight = operation;
    void operation.then(undefined, () => undefined).then(() => {
      if (this.clipboardWatchReconcileInFlight === operation) {
        this.clipboardWatchReconcileInFlight = null;
      }
    });
  }

  private async reconcileClipboardWatcher(): Promise<void> {
    const adapter = this.dependencies.clipboardAdapter;
    if (!adapter.startWatching || !adapter.stopWatching) return;

    while (true) {
      const desired = this.clipboardWatchDesired;
      if (
        desired &&
        (!this.clipboardWatchRunning || this.clipboardWatchResetRequested)
      ) {
        this.setStatus({ ...this.status, clipboardWatch: "starting" });
        try {
          if (this.clipboardWatchRunning) {
            await adapter.stopWatching();
            this.clipboardWatchRunning = false;
          }
          await adapter.startWatching({ resetBaseline: true });
          this.clipboardWatchRunning = true;
          this.clipboardWatchResetRequested = false;
          this.setStatus({ ...this.status, clipboardWatch: "watching" });
        } catch {
          this.clipboardWatchRunning = false;
          this.setStatus({ ...this.status, clipboardWatch: "error" });
          return;
        }
      }

      if (!this.clipboardWatchDesired && this.clipboardWatchRunning) {
        try {
          await adapter.stopWatching();
          this.clipboardWatchRunning = false;
          this.setStatus({ ...this.status, clipboardWatch: "stopped" });
        } catch {
          this.clipboardWatchRunning = false;
          this.setStatus({ ...this.status, clipboardWatch: "error" });
          return;
        }
      }

      if (desired === this.clipboardWatchDesired) break;
    }
  }

  private setStatus(next: RuntimeStatus): void {
    if (
      next.syncPreferences.sendEnabled &&
      !this.status.syncPreferences.sendEnabled
    ) {
      this.clipboardWatchResetRequested = true;
    }
    if (
      next.clipboardWatch === "stopped" &&
      this.status.clipboardWatch !== "stopped" &&
      this.clipboardWatchRunning
    ) {
      this.clipboardWatchResetRequested = true;
    }
    this.status = next;
    void this.dependencies.statusStore
      .set(this.getStatus())
      .catch(() => undefined);
    if (this.dependencies.broadcastStatus) {
      void this.dependencies.broadcastStatus({
        source: RUNTIME_SOURCE,
        target: POPUP_SOURCE,
        type: "runtime:status",
        status: this.getStatus(),
      });
    }
    this.requestClipboardWatcherReconcile();
  }

  private setOnboarding(onboarding: RuntimeStatus["onboarding"]): void {
    this.setStatus({ ...this.status, onboarding });
  }

  private recordSyncError(code: RuntimeErrorCode, message: string): void {
    this.setStatus({
      ...this.status,
      lastSyncError: { code, message, at: this.now().toISOString() },
    });
  }

  private setConnectionError(code: RuntimeErrorCode, message: string): void {
    this.clipboardWatchResetRequested = true;
    this.setStatus({
      ...this.status,
      connectionState: "error",
      syncReady: false,
      socket: {
        connected: false,
        deviceAuthenticated: false,
      },
      clipboardWatch: "stopped",
      lastConnectionError: { code, message, at: this.now().toISOString() },
    });
  }

  private setConnectionRecovering(
    code: RuntimeErrorCode,
    message: string,
  ): void {
    this.clipboardWatchResetRequested = true;
    this.setStatus({
      ...this.status,
      connectionState: this.session ? "connecting" : "signed-out",
      syncReady: false,
      socket: {
        connected: false,
        deviceAuthenticated: false,
      },
      clipboardWatch: "stopped",
      lastConnectionError: { code, message, at: this.now().toISOString() },
    });
  }

  private recordOperationError(code: RuntimeErrorCode, message: string): void {
    if (
      code === "CLIPBOARD_READ_FAILED" ||
      code === "CLIPBOARD_WRITE_FAILED" ||
      code === "UNSUPPORTED_CLIPBOARD_CONTENT" ||
      code === "INVALID_CLIPBOARD_CONTENT" ||
      code === "NO_VERIFIED_RECIPIENTS" ||
      code === "ENCRYPTION_FAILED" ||
      code === "DECRYPTION_FAILED" ||
      code === "SOURCE_UNTRUSTED" ||
      code === "SOCKET_PUBLISH_FAILED" ||
      code === "PAIRING_FAILED" ||
      code === "DEVICE_NOT_LOCALLY_TRUSTED" ||
      code === "DEVICE_NOT_REGISTERED" ||
      code === "CLIPBOARD_SEND_DISABLED" ||
      code === "CLIPBOARD_CONTENT_TOO_LARGE" ||
      code === "SYNC_PREFERENCES_INVALID"
    ) {
      this.recordSyncError(code, message);
    } else {
      this.setConnectionError(code, message);
    }
  }

  private report(
    error: unknown,
    fallbackCode: RuntimeErrorCode,
    fallbackMessage: string,
  ): void {
    const runtimeError = asRuntimeError(error, fallbackCode, fallbackMessage);
    this.recordOperationError(runtimeError.code, runtimeError.message);
  }
}
