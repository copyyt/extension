import type { AxiosResponse } from "axios";
import {
  decryptClipboardItem,
  encryptClipboardItem,
  getDeviceIdentity,
  getOrCreateDeviceIdentity,
  signSocketChallenge,
  type ClipboardItemEnvelope,
  type DeviceIdentity,
} from "../crypto/index.ts";
import {
  registerCurrentDevice,
  type DeviceRegistrationApi,
  type RegisteredDeviceListResponse,
  type RegisteredDeviceResponse,
} from "../crypto/device-registration.ts";
import type {
  ClientTrustStore,
  ClientVerifiedDevice,
  LocalDeviceRecord,
} from "../crypto/trust-store.ts";
import type { SignInResponse, ILoginResponse, IVerifyEmail } from "../interfaces/auth.interface.ts";
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
import type { RuntimeSession, SessionStore, StatusStore } from "./session-store.ts";

export interface RuntimeApi {
  auth: {
    signInPasswordless(data: { email: string }): Promise<AxiosResponse<ILoginResponse>>;
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
};

function userFromSession(session: RuntimeSession): IUser {
  return { ...session.user };
}

function isLocallyVerified(device: LocalDeviceRecord | null): device is ClientVerifiedDevice {
  return device?.trustState === "root" || device?.trustState === "verified";
}

function serverDevices(response: RegisteredDeviceListResponse): RegisteredDeviceResponse[] {
  if (Array.isArray(response)) return response;
  if ("devices" in response && Array.isArray(response.devices)) return response.devices;
  if ("data" in response && Array.isArray(response.data)) return response.data;
  throw new RuntimeError("SOCKET_PUBLISH_FAILED", "The device list response is invalid");
}

function authResult(response: SignInResponse): AuthenticatedRuntimeResult {
  return { message: response.message, user: response.user };
}

function isAcknowledgement(value: unknown, itemId: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === itemId;
  if (typeof value !== "object") return false;
  const candidate = value as { accepted?: unknown; ok?: unknown; itemId?: unknown; error?: unknown };
  if (candidate.error) return false;
  if (candidate.accepted === false || candidate.ok === false) return false;
  return candidate.itemId === undefined || candidate.itemId === itemId;
}

function challengeParts(payload: unknown, fallbackSocketId: string): { socketId: string; challenge: string; userId?: string } | null {
  if (typeof payload === "string") {
    return { socketId: fallbackSocketId, challenge: payload };
  }
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { socketId?: unknown; challenge?: unknown; nonce?: unknown; userId?: unknown };
  const socketId = candidate.socketId ?? fallbackSocketId;
  const challenge = candidate.challenge ?? candidate.nonce;
  if (typeof socketId !== "string" || typeof challenge !== "string") return null;
  return {
    socketId,
    challenge,
    ...(typeof candidate.userId === "string" ? { userId: candidate.userId } : {}),
  };
}

export class CopyytServiceWorkerRuntime {
  private readonly dependencies: RuntimeDependencies;
  private readonly identityLoader: (userId: string) => Promise<DeviceIdentity | null>;
  private readonly identityCreator: (userId: string) => Promise<DeviceIdentity>;
  private readonly registerDevice: typeof registerCurrentDevice;
  private readonly encrypt: typeof encryptClipboardItem;
  private readonly decrypt: typeof decryptClipboardItem;
  private readonly signChallenge: typeof signSocketChallenge;
  private readonly now: () => Date;
  private status: RuntimeStatus = DEFAULT_STATUS;
  private session: RuntimeSession | null = null;
  private socket: SocketLike | null = null;
  private socketAccountId: string | null = null;
  private socketReady = false;
  private challengeInFlight = false;
  private initialization: Promise<void> | null = null;
  private readonly inboundInFlight = new Set<string>();

  constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
    this.identityLoader = dependencies.identityLoader ?? getDeviceIdentity;
    this.identityCreator = dependencies.identityCreator ?? getOrCreateDeviceIdentity;
    this.registerDevice = dependencies.registerDevice ?? registerCurrentDevice;
    this.encrypt = dependencies.encrypt ?? encryptClipboardItem;
    this.decrypt = dependencies.decrypt ?? decryptClipboardItem;
    this.signChallenge = dependencies.signChallenge ?? signSocketChallenge;
    this.now = dependencies.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    const persistedStatus = await this.dependencies.statusStore.get().catch(() => null);
    if (persistedStatus) this.status = persistedStatus;
    this.session = await this.dependencies.sessionStore.get();
    if (!this.session) {
      this.setStatus({
        ...DEFAULT_STATUS,
        connectionState: "signed-out",
      });
      return;
    }
    this.setStatus({
      ...DEFAULT_STATUS,
      connectionState: "account-authenticated",
      signedIn: true,
      user: userFromSession(this.session),
    });
    try {
      await this.ensureAccountInitialized();
      this.connectSocket();
    } catch (error) {
      this.report(error, "DEVICE_NOT_REGISTERED", "The Copyyt device is not ready");
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
      const runtimeError = asRuntimeError(error, "AUTH_REQUIRED", "The runtime operation failed");
      this.setError(runtimeError.code, runtimeError.message);
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
      throw new RuntimeError("CLIPBOARD_READ_FAILED", "The clipboard adapter returned non-text data");
    }
    const session = this.requireSession();
    this.requireSocketReady();
    await this.ensureAccountInitialized();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError("DEVICE_NOT_REGISTERED", "The device must be registered before publishing");
    }
    await this.refreshServerDevices(session);
    const recipients = await this.dependencies.trustStore.listEncryptionRecipients(session.user.id);
    const localDevice = await this.dependencies.trustStore.getDevice(
      session.user.id,
      identity.deviceId,
    );
    if (isLocallyVerified(localDevice) && !recipients.some((item) => item.deviceId === identity.deviceId)) {
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
      throw new RuntimeError("ENCRYPTION_FAILED", "Clipboard encryption failed");
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
    if (!this.socketReady || !this.session) return;
    const envelope = envelopeFromSocketPayload(payload);
    if (!envelope) {
      this.setError("DECRYPTION_FAILED", "The incoming clipboard envelope is invalid");
      return;
    }
    const session = this.session;
    const key = `${session.user.id}:${envelope.itemId}`;
    if (this.inboundInFlight.has(key)) return;
    const locallyPublished = await this.dependencies.outboundItemStore.has(
      session.user.id,
      envelope.itemId,
    );
    if (await this.dependencies.processedItemStore.has(session.user.id, envelope.itemId)) return;
    this.inboundInFlight.add(key);
    try {
      const identity = await this.identityLoader(session.user.id);
      if (!identity || identity.keyVersion === null) {
        throw new RuntimeError("DEVICE_NOT_REGISTERED", "The device is not registered");
      }
      const source = await this.dependencies.trustStore.getDevice(
        session.user.id,
        envelope.sourceDeviceId,
      );
      if (!isLocallyVerified(source)) {
        throw new RuntimeError("SOURCE_UNTRUSTED", "The clipboard source is not locally trusted");
      }
      const selfEcho = locallyPublished && envelope.sourceDeviceId === identity.deviceId;
      let decrypted: { plaintext: string; plaintextBytes: Uint8Array };
      try {
        decrypted = await this.decrypt({
          userId: session.user.id,
          identity,
          envelope,
          trustStore: this.dependencies.trustStore,
        });
      } catch {
        throw new RuntimeError("DECRYPTION_FAILED", "Clipboard decryption or verification failed");
      }
      if (selfEcho) return;
      await this.dependencies.clipboardAdapter.writeText(decrypted.plaintext).catch(() => {
        throw new RuntimeError("CLIPBOARD_WRITE_FAILED", "The operating-system clipboard could not be written");
      });
      await this.dependencies.processedItemStore.mark({
        userId: session.user.id,
        itemId: envelope.itemId,
        processedAt: this.now().toISOString(),
        sourceDeviceId: envelope.sourceDeviceId,
      });
    } catch (error) {
      const runtimeError = asRuntimeError(error, "DECRYPTION_FAILED", "Clipboard delivery failed");
      this.setError(runtimeError.code, runtimeError.message);
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
          throw new RuntimeError("CLIPBOARD_READ_FAILED", "The operating-system clipboard could not be read");
        }
        return this.publishClipboardText(text);
      }
      case "runtime:bootstrap-trust-anchor":
        return this.bootstrapTrustAnchor();
      case "runtime:auth-google":
        return this.authenticate(() => this.dependencies.apiFactory("").auth.googleSign(command.googleToken));
      case "runtime:auth-passwordless":
        return (await this.dependencies.apiFactory("").auth.signInPasswordless({ email: command.email })).data;
      case "runtime:auth-verify-email":
        return this.authenticate(() =>
          this.dependencies.apiFactory("").auth.verifyEmail({
            email: command.email,
            ...(command.name ? { name: command.name } : {}),
            code: command.code,
          }),
        );
      case "runtime:auth-resend-email-otp":
        return (await this.dependencies.apiFactory("").auth.resendEmailOtp(command.email)).data;
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
      this.connectSocket();
    } catch (error) {
      this.report(error, "DEVICE_NOT_REGISTERED", "Signed in, but the device is not ready");
    }
    return result;
  }

  private async refreshSession(): Promise<AuthenticatedRuntimeResult> {
    let response: AxiosResponse<SignInResponse>;
    try {
      response = await this.dependencies.apiFactory(this.session?.accessToken ?? "").auth.refreshTokens();
    } catch {
      await this.dependencies.sessionStore.clear();
      this.socket?.disconnect();
      this.socket = null;
      this.socketReady = false;
      this.session = null;
      this.setStatus({ ...DEFAULT_STATUS, connectionState: "signed-out" });
      throw new RuntimeError("AUTH_REQUIRED", "The Copyyt session is no longer valid");
    }
    const result = authResult(response.data);
    await this.saveSession(response.data);
    try {
      await this.ensureAccountInitialized();
      this.connectSocket();
    } catch (error) {
      this.report(error, "DEVICE_NOT_REGISTERED", "Signed in, but the device is not ready");
    }
    return result;
  }

  private async saveSession(response: SignInResponse): Promise<void> {
    if (
      this.session &&
      this.session.user.id === response.user.id &&
      this.session.accessToken !== response.accessToken
    ) {
      this.socket?.disconnect();
      this.socket = null;
      this.socketAccountId = null;
      this.socketReady = false;
    }
    const session: RuntimeSession = {
      schemaVersion: 1,
      accessToken: response.accessToken,
      user: response.user,
    };
    await this.dependencies.sessionStore.set(session);
    this.session = session;
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
        await this.dependencies.apiFactory(this.session.accessToken).auth.logout();
      } catch {
        // Local logout still completes if the server is unavailable.
      }
    }
    this.socket?.disconnect();
    this.socket = null;
    this.socketAccountId = null;
    this.socketReady = false;
    this.session = null;
    await this.dependencies.sessionStore.clear();
    this.setStatus({ ...DEFAULT_STATUS, connectionState: "signed-out" });
  }

  private async bootstrapTrustAnchor(): Promise<RuntimeStatus> {
    const session = this.requireSession();
    const identity = await this.identityLoader(session.user.id);
    if (!identity || identity.keyVersion === null) {
      throw new RuntimeError("DEVICE_NOT_REGISTERED", "Register this device before trusting it");
    }
    const trustStore = this.dependencies.trustStore;
    await trustStore.bootstrapInitialTrustAnchor(session.user.id, identity, {
      name: identity.registration?.name,
      platform: identity.registration?.platform,
      capabilities: identity.registration?.capabilities,
      appVersion: identity.registration?.appVersion,
    });
    await this.updateDeviceStatus(identity);
    return this.getStatus();
  }

  private async testClipboard(marker: string): Promise<{ ping: boolean; readText: boolean; writeText: boolean }> {
    if (typeof marker !== "string" || marker.length === 0) {
      throw new RuntimeError("CLIPBOARD_WRITE_FAILED", "The clipboard test marker is invalid");
    }
    if (this.dependencies.clipboardAdapter.ping) {
      await this.dependencies.clipboardAdapter.ping();
    }
    await this.dependencies.clipboardAdapter.writeText(marker);
    const value = await this.dependencies.clipboardAdapter.readText();
    if (typeof value !== "string") {
      throw new RuntimeError("CLIPBOARD_READ_FAILED", "The clipboard adapter returned non-text data");
    }
    await this.dependencies.clipboardAdapter.writeText(marker);
    return { ping: true, readText: value === marker, writeText: true };
  }

  private requireSession(): RuntimeSession {
    if (!this.session) throw new RuntimeError("AUTH_REQUIRED", "Sign in to use Copyyt");
    return this.session;
  }

  private requireSocketReady(): void {
    if (!this.socket || !this.socketReady || this.status.connectionState !== "ready") {
      throw new RuntimeError("SOCKET_NOT_READY", "The Copyyt device connection is not ready");
    }
  }

  private async ensureAccountInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    const session = this.requireSession();
    this.initialization = (async () => {
      let identity = await this.identityLoader(session.user.id);
      if (!identity) identity = await this.identityCreator(session.user.id);
      try {
        const registered = await this.registerDevice(this.dependencies.apiFactory(session.accessToken).devices, {
          userId: session.user.id,
          name: "Copyyt Chrome",
          capabilities: ["clipboard"],
          appVersion: this.dependencies.appVersion,
          trustStore: this.dependencies.trustStore,
        });
        identity = registered.identity;
      } catch {
        if (identity.keyVersion === null) {
          throw new RuntimeError("DEVICE_NOT_REGISTERED", "The device is not registered with Copyyt");
        }
      }
      await this.updateDeviceStatus(identity);
    })().finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  private async updateDeviceStatus(identity: DeviceIdentity): Promise<void> {
    const trust = await this.dependencies.trustStore.getDevice(identity.userId, identity.deviceId);
    this.setStatus({
      ...this.status,
      connectionState:
        this.socketReady && this.status.socket.connected
          ? "ready"
          : this.status.connectionState,
      device: {
        deviceId: identity.deviceId,
        ...(identity.keyVersion === null ? {} : { keyVersion: identity.keyVersion }),
        registration: identity.keyVersion === null ? "not-registered" : "registered",
        trustState: trust?.trustState ?? "unverified",
      },
    });
  }

  private connectSocket(): void {
    const session = this.requireSession();
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
    const socket = this.dependencies.socketFactory(this.dependencies.socketUrl, {
      auth: { token: session.accessToken },
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
    });
    this.socket = socket;
    const onConnect = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      this.setStatus({
        ...this.status,
        connectionState: "account-authenticated",
        socket: { connected: true, deviceAuthenticated: false },
      });
    };
    const onDisconnect = (): void => {
      if (this.socket !== socket) return;
      const wasReady = this.socketReady;
      this.socketReady = false;
      this.setStatus({
        ...this.status,
        connectionState: "error",
        socket: { connected: false, deviceAuthenticated: false },
        lastSyncError: {
          code: "SOCKET_NOT_READY",
          message: wasReady ? "The Copyyt socket disconnected" : "The socket disconnected before device authentication",
          at: this.now().toISOString(),
        },
      });
    };
    const onConnectError = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      this.setError("SOCKET_NOT_READY", "The Copyyt socket connection failed");
    };
    const onChallenge = (payload: unknown): void => {
      if (this.socket !== socket) return;
      void this.authenticateDevice(payload);
    };
    const onReady = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = true;
      this.setStatus({
        ...this.status,
        connectionState: "ready",
        socket: { connected: true, deviceAuthenticated: true },
      });
      void this.refreshServerDevices(session).catch((error) => {
        this.report(error, "SOCKET_PUBLISH_FAILED", "Device trust synchronization failed");
      });
    };
    const onAuthFailure = (): void => {
      if (this.socket !== socket) return;
      this.socketReady = false;
      this.setError("AUTH_REQUIRED", "The device socket authentication was rejected");
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
        throw new RuntimeError("DEVICE_NOT_REGISTERED", "The device must be registered before socket authentication");
      }
      const parts = challengeParts(payload, this.socket.id ?? "");
      if (!parts || (parts.userId !== undefined && parts.userId !== session.user.id)) {
        throw new RuntimeError("AUTH_REQUIRED", "The socket authentication challenge is invalid");
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
      const runtimeError = asRuntimeError(error, "AUTH_REQUIRED", "The device socket authentication failed");
      this.setError(runtimeError.code, runtimeError.message);
      this.socketReady = false;
    } finally {
      this.challengeInFlight = false;
    }
  }

  private async refreshServerDevices(session: RuntimeSession): Promise<void> {
    const response = await this.dependencies.apiFactory(session.accessToken).devices.listDevices();
    for (const device of serverDevices(response.data)) {
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
    if (identity) await this.updateDeviceStatus(identity);
  }

  private async emitPublish(envelope: ClipboardItemEnvelope): Promise<void> {
    this.requireSocketReady();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new RuntimeError("SOCKET_PUBLISH_FAILED", "The clipboard publish acknowledgement timed out"));
        }
      }, 10000);
      const finish = (ack: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isAcknowledgement(ack, envelope.itemId)) resolve();
        else reject(new RuntimeError("SOCKET_PUBLISH_FAILED", "The server rejected the clipboard publish"));
      };
      try {
        this.socket!.emit("clipboard:publish", envelope, finish);
      } catch {
        clearTimeout(timer);
        reject(new RuntimeError("SOCKET_PUBLISH_FAILED", "The clipboard publish failed"));
      }
    });
  }

  private setStatus(next: RuntimeStatus): void {
    this.status = next;
    void this.dependencies.statusStore.set(this.getStatus()).catch(() => undefined);
    if (this.dependencies.broadcastStatus) {
      void this.dependencies.broadcastStatus({
        source: RUNTIME_SOURCE,
        target: POPUP_SOURCE,
        type: "runtime:status",
        status: this.getStatus(),
      });
    }
  }

  private setError(code: RuntimeErrorCode, message: string): void {
    this.setStatus({
      ...this.status,
      connectionState: "error",
      socket: {
        ...this.status.socket,
        deviceAuthenticated: false,
      },
      lastSyncError: { code, message, at: this.now().toISOString() },
    });
  }

  private report(error: unknown, fallbackCode: RuntimeErrorCode, fallbackMessage: string): void {
    const runtimeError = asRuntimeError(error, fallbackCode, fallbackMessage);
    this.setError(runtimeError.code, runtimeError.message);
  }
}
