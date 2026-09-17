import { isAxiosError, type AxiosResponse } from "axios";
import { jwtDecode } from "jwt-decode";
import {
  computePairingFingerprint,
  decryptClipboardItem,
  encryptClipboardItem,
  getDeviceIdentity,
  getOrCreateDeviceIdentity,
  signDeviceApproval,
  signSocketChallenge,
  type ClipboardItemEnvelope,
  type DeviceIdentity,
} from "../crypto/index.ts";
import {
  registerCurrentDevice,
  type ApproveDeviceRequest,
  type DeviceRegistrationApi,
  type RegisteredDeviceListResponse,
  type RegisteredDeviceResponse,
} from "../crypto/device-registration.ts";
import type { DeviceApprovalCertificate } from "../crypto/crypto-core.ts";
import type {
  ClientTrustStore,
  ClientVerifiedDevice,
  LocalDeviceRecord,
} from "../crypto/trust-store.ts";
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
  isRuntimeRequest,
  POPUP_SOURCE,
  RUNTIME_SOURCE,
  type AuthenticatedRuntimeResult,
  type RuntimeCommand,
  type RuntimeResponse,
  type RuntimeStatus,
  type RuntimeStatusBroadcast,
} from "./messages.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import type { OutboundItemStore, ProcessedItemStore } from "./runtime-db.ts";
import type {
  RuntimeSession,
  SessionStore,
  StatusStore,
} from "./session-store.ts";

export interface RuntimeApi {
  auth: {
    signInPasswordless(data: {
      email: string;
    }): Promise<AxiosResponse<ILoginResponse>>;
    googleSign(token: string): Promise<AxiosResponse<SignInResponse>>;
    verifyEmail(data: IVerifyEmail): Promise<AxiosResponse<SignInResponse>>;
    refreshTokens(): Promise<AxiosResponse<SignInResponse>>;
    logout(): Promise<AxiosResponse<unknown>>;
    resendEmailOtp(email: string): Promise<AxiosResponse<unknown>>;
  };
  devices: DeviceRegistrationApi & {
    listDevices(): Promise<AxiosResponse<RegisteredDeviceListResponse>>;
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

export interface RuntimeDependencies {
  socketUrl: string;
  appVersion: string;
  sessionStore: SessionStore;
  statusStore: StatusStore<RuntimeStatus>;
  trustStore: ClientTrustStore;
  clipboardAdapter: ClipboardAdapter;
  processedItemStore: ProcessedItemStore;
  outboundItemStore: OutboundItemStore;
  apiFactory: (accessToken: string) => RuntimeApi;
  socketFactory: (url: string, options: SocketOptions) => SocketLike;
  identityLoader?: (userId: string) => Promise<DeviceIdentity | null>;
  identityCreator?: (userId: string) => Promise<DeviceIdentity>;
  registerDevice?: typeof registerCurrentDevice;
  encrypt?: typeof encryptClipboardItem;
  decrypt?: typeof decryptClipboardItem;
  signChallenge?: typeof signSocketChallenge;
  signApproval?: typeof signDeviceApproval;
  now?: () => Date;
  broadcastStatus?: (message: RuntimeStatusBroadcast) => Promise<void> | void;
}

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
  onboarding: {
    state: "unknown",
    bootstrapEligible: false,
  },
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

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

function refreshFailureIsDefinitive(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
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
    case "runtime:send-current-clipboard":
      return "SOCKET_PUBLISH_FAILED";
    case "runtime:test-clipboard":
      return "CLIPBOARD_WRITE_FAILED";
    case "runtime:bootstrap-trust-anchor":
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
  private readonly encrypt: typeof encryptClipboardItem;
  private readonly decrypt: typeof decryptClipboardItem;
  private readonly signChallenge: typeof signSocketChallenge;
  private readonly signApproval: typeof signDeviceApproval;
  private readonly now: () => Date;
  private status: RuntimeStatus = DEFAULT_STATUS;
  private session: RuntimeSession | null = null;
  private socket: SocketLike | null = null;
  private socketAccountId: string | null = null;
  private socketReady = false;
  private challengeInFlight = false;
  private challengeReceived = false;
  private serverDeviceState: ServerDeviceState = "unknown";
  private startup: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private refreshInFlight: Promise<RuntimeSession> | null = null;
  private socketRecoveryInFlight: Promise<void> | null = null;
  private socketRecoveryTarget: SocketLike | null = null;
  private readonly inboundInFlight = new Set<string>();

  constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
    this.identityLoader = dependencies.identityLoader ?? getDeviceIdentity;
    this.identityCreator =
      dependencies.identityCreator ?? getOrCreateDeviceIdentity;
    this.registerDevice = dependencies.registerDevice ?? registerCurrentDevice;
    this.encrypt = dependencies.encrypt ?? encryptClipboardItem;
    this.decrypt = dependencies.decrypt ?? decryptClipboardItem;
    this.signChallenge = dependencies.signChallenge ?? signSocketChallenge;
    this.signApproval = dependencies.signApproval ?? signDeviceApproval;
    this.now = dependencies.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (!this.startup) {
      this.startup = this.startInternal();
    }
    return this.startup;
  }

  private async startInternal(): Promise<void> {
    const persistedStatus = await this.dependencies.statusStore
      .get()
      .catch(() => null);
    this.session = await this.dependencies.sessionStore.get();

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
          }
        : {}),
      connectionState: this.session ? "account-authenticated" : "signed-out",
      signedIn: this.session !== null,
      user: this.session ? userFromSession(this.session) : undefined,
      socket: { connected: false, deviceAuthenticated: false },
      syncReady: false,
    };
    this.serverDeviceState = "unknown";
    this.socketReady = false;
    this.challengeInFlight = false;
    this.challengeReceived = false;

    if (!this.session) {
      this.setStatus({
        ...this.status,
        connectionState: "signed-out",
        signedIn: false,
        user: undefined,
      });
      return;
    }
    this.setStatus({
      ...this.status,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(this.session),
    });
    try {
      if (tokenNeedsRefresh(this.session.accessToken, this.now())) {
        try {
          await this.refreshAccessToken();
        } catch (error) {
          if (refreshFailureIsDefinitive(error)) throw error;
          // Keep the local session during a transient refresh outage. Socket
          // connection/reconnection can recover when the service is back.
        }
      }
      await this.ensureAccountInitialized();
      await this.refreshOnboarding().catch(() => {
        // Onboarding is fail-closed when the backend cannot be queried.
        this.serverDeviceState = "unknown";
        this.setOnboarding({ state: "unknown", bootstrapEligible: false });
      });
      this.maybeConnectSocket();
    } catch (error) {
      if (
        refreshFailureIsDefinitive(error) ||
        (!this.session &&
          error instanceof RuntimeError &&
          error.code === "AUTH_REQUIRED")
      ) {
        await this.clearSession();
      } else {
        this.serverDeviceState = "unknown";
        this.report(
          error,
          "DEVICE_NOT_REGISTERED",
          "The Copyyt device is not ready",
        );
      }
    }
  }

  getStatus(): RuntimeStatus {
    return structuredClone(this.status);
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
                "The runtime operation failed",
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

  async publishClipboardText(text: string): Promise<{ itemId: string }> {
    if (typeof text !== "string") {
      throw new RuntimeError(
        "CLIPBOARD_READ_FAILED",
        "The clipboard adapter returned non-text data",
      );
    }
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
    const activeServerDevices = await this.refreshServerDevices(session);
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
    let envelope: ClipboardItemEnvelope;
    try {
      envelope = await this.encrypt({
        userId: session.user.id,
        identity,
        plaintext: text,
        contentType: "text/plain",
        expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000),
        recipients,
      });
    } catch {
      throw new RuntimeError(
        "ENCRYPTION_FAILED",
        "Clipboard encryption failed",
      );
    }
    // Record before emitting so a synchronous self-echo cannot rewrite the
    // clipboard, and so the decision survives a worker restart.
    await this.dependencies.outboundItemStore.mark({
      userId: session.user.id,
      itemId: envelope.itemId,
      publishedAt: this.now().toISOString(),
      sourceDeviceId: envelope.sourceDeviceId,
    });
    await this.emitPublish(envelope);
    return { itemId: envelope.itemId };
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
    const locallyPublished = await this.dependencies.outboundItemStore.has(
      session.user.id,
      envelope.itemId,
    );
    if (
      await this.dependencies.processedItemStore.has(
        session.user.id,
        envelope.itemId,
      )
    )
      return;
    this.inboundInFlight.add(key);
    try {
      const identity = await this.identityLoader(session.user.id);
      if (!identity || identity.keyVersion === null) {
        throw new RuntimeError(
          "DEVICE_NOT_REGISTERED",
          "The device is not registered",
        );
      }
      const source = await this.dependencies.trustStore.getDevice(
        session.user.id,
        envelope.sourceDeviceId,
      );
      if (!isLocallyVerified(source)) {
        throw new RuntimeError(
          "SOURCE_UNTRUSTED",
          "The clipboard source is not locally trusted",
        );
      }
      const selfEcho =
        locallyPublished && envelope.sourceDeviceId === identity.deviceId;
      let decrypted: { plaintext: string; plaintextBytes: Uint8Array };
      try {
        decrypted = await this.decrypt({
          userId: session.user.id,
          identity,
          envelope,
          trustStore: this.dependencies.trustStore,
        });
      } catch {
        throw new RuntimeError(
          "DECRYPTION_FAILED",
          "Clipboard decryption or verification failed",
        );
      }
      if (selfEcho) return;
      await this.dependencies.clipboardAdapter
        .writeText(decrypted.plaintext)
        .catch(() => {
          throw new RuntimeError(
            "CLIPBOARD_WRITE_FAILED",
            "The operating-system clipboard could not be written",
          );
        });
      await this.dependencies.processedItemStore.mark({
        userId: session.user.id,
        itemId: envelope.itemId,
        processedAt: this.now().toISOString(),
        sourceDeviceId: envelope.sourceDeviceId,
      });
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

  private async handleCommand(command: RuntimeCommand): Promise<unknown> {
    switch (command.type) {
      case "runtime:get-status":
        return this.getStatus();
      case "runtime:send-current-clipboard": {
        this.requireSession();
        let text: string;
        try {
          text = await this.dependencies.clipboardAdapter.readText();
        } catch {
          throw new RuntimeError(
            "CLIPBOARD_READ_FAILED",
            "The operating-system clipboard could not be read",
          );
        }
        return this.publishClipboardText(text);
      }
      case "runtime:bootstrap-trust-anchor":
        return this.bootstrapTrustAnchor();
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
    }
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
        this.setOnboarding({ state: "unknown", bootstrapEligible: false });
      });
      this.maybeConnectSocket();
    } catch (error) {
      this.serverDeviceState = "unknown";
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
    this.refreshInFlight = (async () => {
      let response: AxiosResponse<SignInResponse>;
      try {
        response = await this.dependencies
          .apiFactory(session.accessToken)
          .auth.refreshTokens();
      } catch (error) {
        if (refreshFailureIsDefinitive(error)) {
          await this.clearSession();
          throw new RuntimeError(
            "AUTH_REQUIRED",
            "The Copyyt session is no longer valid",
          );
        }
        throw error;
      }
      await this.saveSession(response.data);
      return this.session!;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async saveSession(response: SignInResponse): Promise<void> {
    if (
      this.session &&
      this.session.user.id === response.user.id &&
      this.session.accessToken !== response.accessToken
    ) {
      this.destroySocket(this.socket);
    }
    const session: RuntimeSession = {
      schemaVersion: 1,
      accessToken: response.accessToken,
      user: response.user,
    };
    await this.dependencies.sessionStore.set(session);
    this.session = session;
    this.serverDeviceState = "unknown";
    this.setStatus({
      ...DEFAULT_STATUS,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(session),
    });
  }

  private async logout(): Promise<void> {
    if (this.session) {
      try {
        await this.dependencies
          .apiFactory(this.session.accessToken)
          .auth.logout();
      } catch {
        // Local logout still completes if the server is unavailable.
      }
    }
    await this.clearSession();
  }

  private async clearSession(): Promise<void> {
    this.destroySocket(this.socket);
    this.session = null;
    this.serverDeviceState = "unknown";
    await this.dependencies.sessionStore.clear();
    this.setStatus({ ...DEFAULT_STATUS, connectionState: "signed-out" });
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
      localApprover.trustState !== "root" ||
      localApprover.trustOrigin !== "initial-tofu" ||
      !identityMatchesLocalDevice(identity, localApprover)
    ) {
      throw new RuntimeError(
        "DEVICE_NOT_LOCALLY_TRUSTED",
        "Only the initial account root can approve pairing",
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
        capabilities: [...pending.capabilities],
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
    const current = snapshot.pendingDevices.find(
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
    if (!current || !identityMatchesServerDevice(identity, current)) {
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
        capabilities: [...current.capabilities],
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
        capabilities: [...serverApprover.capabilities],
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
        capabilities: [...serverDevice.capabilities],
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

  private async refreshOnboarding(): Promise<void> {
    const session = this.requireSession();
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
        capabilities: [...device.capabilities],
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
        });
        return;
      }
      if (!pending) {
        this.setOnboarding({ state: "complete", bootstrapEligible: false });
        return;
      }
      if (
        localCurrent.trustState !== "root" ||
        localCurrent.trustOrigin !== "initial-tofu" ||
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
        capabilities: [...pending.capabilities],
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
      capabilities: [...approver.capabilities],
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
            capabilities: ["clipboard"],
            appVersion: this.dependencies.appVersion,
            trustStore: this.dependencies.trustStore,
          },
        );
        identity = registered.identity;
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
    this.setStatus({
      ...this.status,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(this.session),
      socket: { connected: false, deviceAuthenticated: false },
      syncReady: false,
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
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.socket?.disconnect();
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
        socket: { connected: true, deviceAuthenticated: false },
      });
    };
    const onDisconnect = (): void => {
      if (this.socket !== socket) return;
      const wasReady = this.socketReady;
      this.socketReady = false;
      this.setConnectionError(
        "SOCKET_NOT_READY",
        wasReady
          ? "The Copyyt socket disconnected"
          : "The socket disconnected before device authentication",
      );
    };
    const onConnectError = (error?: unknown): void => {
      console.error("COPYyt socket connect_error", error);

      if (this.socket !== socket) return;

      this.socketReady = false;
      this.setConnectionError(
        "SOCKET_NOT_READY",
        error instanceof Error
          ? `Socket connection failed: ${error.message}`
          : "The Copyyt socket connection failed",
      );

      if (isSocketAuthenticationFailure(error)) {
        if (this.challengeReceived) {
          void this.handleDeviceAuthenticationFailure(socket);
        } else {
          void this.recoverSocketAuthentication(socket);
        }
      }
    };
    const onChallenge = (payload: unknown): void => {
      if (this.socket !== socket) return;
      this.challengeReceived = true;
      void this.authenticateDevice(payload);
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
      });
      void this.refreshServerDevices(session).catch(() => {
        this.recordSyncError(
          "SOCKET_PUBLISH_FAILED",
          "Device trust synchronization failed",
        );
      });
    };
    const onAuthFailure = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      if (this.challengeReceived) {
        void this.handleDeviceAuthenticationFailure(socket);
      } else {
        this.setConnectionError(
          "AUTH_REQUIRED",
          "The account socket authentication was rejected",
        );
        void this.recoverSocketAuthentication(socket);
      }
    };
    const onClipboardItem = (payload: unknown): void => {
      if (this.socket !== socket) return;
      void this.receiveClipboardItem(payload);
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("auth:challenge", onChallenge);
    socket.on("auth:ready", onReady);
    socket.on("auth:failure", onAuthFailure);
    socket.on("clipboard:item", onClipboardItem);
    socket.connect();
  }

  private async authenticateDevice(payload: unknown): Promise<void> {
    if (this.challengeInFlight || !this.socket) return;
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
      const parts = challengeParts(payload, this.socket.id ?? "");
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
      });
      const signature = await this.signChallenge({
        userId: session.user.id,
        identity,
        socketId: parts.socketId,
        challenge: parts.challenge,
      });
      this.socket.emit("auth:device", {
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

  private async recoverSocketAuthentication(socket: SocketLike): Promise<void> {
    if (this.socket !== socket) return;
    if (this.socketRecoveryTarget === socket && this.socketRecoveryInFlight) {
      return this.socketRecoveryInFlight;
    }
    this.socketRecoveryTarget = socket;
    this.socketRecoveryInFlight = (async () => {
      try {
        await this.refreshAccessToken();
        if (!this.session || (this.socket !== null && this.socket !== socket))
          return;
        this.destroySocket(socket);
        await this.ensureAccountInitialized();
        this.connectSocket();
      } catch {
        if (this.session) {
          this.setConnectionError(
            "AUTH_REQUIRED",
            "The Copyyt session could not be renewed",
          );
        }
      } finally {
        this.socketRecoveryInFlight = null;
        this.socketRecoveryTarget = null;
      }
    })();
    return this.socketRecoveryInFlight;
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
    if (this.socket === socket) {
      this.socket = null;
      this.socketAccountId = null;
      this.socketReady = false;
      this.challengeInFlight = false;
      this.challengeReceived = false;
    }
    try {
      socket.disconnect();
    } catch {
      // A stale socket is best-effort cleanup during token replacement.
    }
  }

  private async fetchDeviceSnapshot(
    session: RuntimeSession,
  ): Promise<DeviceSnapshot> {
    const api = this.dependencies.apiFactory(session.accessToken).devices;
    const [trustedResponse, pendingResponse] = await Promise.all([
      api.listDevices(),
      api.listPendingDevices(),
    ]);
    const trustedDevices = trustedServerDevices(trustedResponse.data);
    return {
      trustedDevices,
      pendingDevices: pendingServerDevices(pendingResponse.data),
      accountRoot: resolveAccountRoot(trustedDevices),
    };
  }

  private async refreshServerDevices(
    session: RuntimeSession,
  ): Promise<RegisteredDeviceResponse[]> {
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
        capabilities: [...device.capabilities],
        appVersion: device.appVersion,
        trustState: device.trustState,
      });
    }
    const identity = await this.identityLoader(session.user.id);
    if (identity) {
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

  private setStatus(next: RuntimeStatus): void {
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
    this.setStatus({
      ...this.status,
      connectionState: "error",
      syncReady: false,
      socket: {
        connected: false,
        deviceAuthenticated: false,
      },
      lastConnectionError: { code, message, at: this.now().toISOString() },
    });
  }

  private recordOperationError(code: RuntimeErrorCode, message: string): void {
    if (
      code === "CLIPBOARD_READ_FAILED" ||
      code === "CLIPBOARD_WRITE_FAILED" ||
      code === "NO_VERIFIED_RECIPIENTS" ||
      code === "ENCRYPTION_FAILED" ||
      code === "DECRYPTION_FAILED" ||
      code === "SOURCE_UNTRUSTED" ||
      code === "SOCKET_PUBLISH_FAILED" ||
      code === "PAIRING_FAILED" ||
      code === "DEVICE_NOT_LOCALLY_TRUSTED" ||
      code === "DEVICE_NOT_REGISTERED"
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
