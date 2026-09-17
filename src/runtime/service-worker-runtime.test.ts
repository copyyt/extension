import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosResponse } from "axios";
import type { DeviceIdentity } from "../crypto/key-store.ts";
import type { RegisteredDeviceResponse } from "../crypto/device-registration.ts";
import type { ClientTrustStore, ClientVerifiedDevice, LocalDeviceRecord } from "../crypto/trust-store.ts";
import type { IUser } from "../interfaces/user.interface.ts";
import type { ILoginResponse, SignInResponse } from "../interfaces/auth.interface.ts";
import { RuntimeError } from "./errors.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import type { ClipboardWatcherOptions } from "./clipboard-watcher.ts";
import { createRuntimeMessageListener } from "./service-worker-bootstrap.ts";
import { createOffscreenClipboardWatcher } from "./offscreen-watcher.ts";
import { InMemoryItemMetadataStore } from "./runtime-db.ts";
import type { RuntimeSession, SessionStore, StatusStore } from "./session-store.ts";
import {
  CopyytServiceWorkerRuntime,
  findUniqueAccountRootCandidate,
  type RuntimeDependencies,
  type RuntimeApi,
  type SocketLike,
  type SocketOptions,
} from "./service-worker-runtime.ts";
import type { RuntimeCommand, RuntimeStatus } from "./messages.ts";

const user: IUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  googleSubject: "google-subject",
};
const identity = {
  userId: user.id,
  deviceId: "00000000-0000-4000-8000-000000000001",
  keyVersion: 1,
  signingPublicKey: new Uint8Array(32),
  signingPublicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  encryptionPublicKey: new Uint8Array(32),
  encryptionPublicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  registration: { keyVersion: 1, name: "Test", platform: "chrome", capabilities: [] },
} as unknown as DeviceIdentity;
const registeredDevice: RegisteredDeviceResponse = {
  deviceId: identity.deviceId,
  name: "Test",
  platform: "chrome",
  encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  signingPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  trustState: "trusted",
  keyVersion: 1,
  capabilities: [],
};
const pendingDevice: RegisteredDeviceResponse = {
  deviceId: "00000000-0000-4000-8000-000000000002",
  name: "Second Chrome",
  platform: "chrome",
  encryptionPublicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  signingPublicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  trustState: "pending",
  keyVersion: 1,
  capabilities: ["clipboard"],
};

class MemorySessionStore implements SessionStore {
  private session: RuntimeSession | null;
  constructor(session: RuntimeSession | null) { this.session = session; }
  async get(): Promise<RuntimeSession | null> { return this.session; }
  async set(session: RuntimeSession): Promise<void> { this.session = session; }
  async clear(): Promise<void> { this.session = null; }
}

class MemoryStatusStore implements StatusStore<RuntimeStatus> {
  status: RuntimeStatus | null = null;
  async get(): Promise<RuntimeStatus | null> { return this.status; }
  async set(status: RuntimeStatus): Promise<void> { this.status = status; }
}

class FakeSocket implements SocketLike {
  id = "socket-1";
  connected = false;
  readonly events = new Map<string, (...args: unknown[]) => void>();
  readonly emissions: Array<{ event: string; args: unknown[] }> = [];
  private readonly emitConnectEventOnConnect: boolean;
  constructor(emitConnectEventOnConnect = true) {
    this.emitConnectEventOnConnect = emitConnectEventOnConnect;
  }
  on(event: string, listener: (...args: unknown[]) => void): void { this.events.set(event, listener); }
  connect(): void {
    this.connected = true;
    if (this.emitConnectEventOnConnect) this.events.get("connect")?.();
  }
  disconnect(): void { this.connected = false; this.events.get("disconnect")?.(); }
  emit(event: string, ...args: unknown[]): void {
    this.emissions.push({ event, args });
    if (event === "clipboard:publish") {
      const envelope = args[0] as { itemId: string };
      (args[1] as (ack: unknown) => void)({ accepted: true, itemId: envelope.itemId });
    }
  }
  trigger(event: string, ...args: unknown[]): void { this.events.get(event)?.(...args); }
}

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

function makeRuntime(overrides: Partial<{
  trustStore: ClientTrustStore;
  clipboardAdapter: ClipboardAdapter;
  socket: FakeSocket;
  localTrustState: LocalDeviceRecord["trustState"];
  accessToken: string;
  refreshTokens: () => Promise<AxiosResponse<SignInResponse>>;
  googleSign: () => Promise<AxiosResponse<SignInResponse>>;
  verifyEmail: () => Promise<AxiosResponse<SignInResponse>>;
  signInPasswordless: () => Promise<AxiosResponse<ILoginResponse>>;
  resendEmailOtp: () => Promise<AxiosResponse<unknown>>;
  initialSession: RuntimeSession | null;
  listDevices: () => Promise<AxiosResponse<unknown>>;
  listPendingDevices: () => Promise<AxiosResponse<unknown>>;
  approveDevice: (request: unknown) => Promise<AxiosResponse<unknown>>;
  signApproval: RuntimeDependencies["signApproval"];
  decrypt: RuntimeDependencies["decrypt"];
  encrypt: RuntimeDependencies["encrypt"];
  identity: DeviceIdentity;
  registeredDevice: typeof registeredDevice;
  sessionStore: SessionStore;
  statusStore: StatusStore<RuntimeStatus>;
  identityLoader: (userId: string) => Promise<DeviceIdentity | null>;
  identityCreator: (userId: string) => Promise<DeviceIdentity>;
  registerDevice: RuntimeDependencies["registerDevice"];
}> = {}) {
  const runtimeIdentity = overrides.identity ?? identity;
  const runtimeRegisteredDevice = overrides.registeredDevice ?? registeredDevice;
  const initialSession: RuntimeSession | null = overrides.initialSession === undefined
    ? { schemaVersion: 1, accessToken: overrides.accessToken ?? "access-token", user }
    : overrides.initialSession;
  const sessionStore = overrides.sessionStore ?? new MemorySessionStore(initialSession);
  const statusStore = overrides.statusStore ?? new MemoryStatusStore();
  const socket = overrides.socket ?? new FakeSocket();
  const clipboardAdapter = overrides.clipboardAdapter ?? {
    readText: async () => "secret plaintext",
    writeText: async () => undefined,
  };
  const localDevice: LocalDeviceRecord = {
    userId: user.id,
    deviceId: runtimeIdentity.deviceId,
    keyVersion: 1,
    encryptionPublicKey: runtimeRegisteredDevice.encryptionPublicKey,
    signingPublicKey: runtimeRegisteredDevice.signingPublicKey,
    trustState: overrides.localTrustState ?? "unverified",
  };
  const trustStore = overrides.trustStore ?? ({
    getDevice: async () => localDevice,
    upsertServerReportedDevice: async (device) => ({ ...device, trustState: "unverified" }),
    bootstrapInitialTrustAnchor: async () => ({ ...localDevice, trustState: "root", trustOrigin: "initial-tofu" }),
    pinPairedApprover: async () => { throw new Error("not used"); },
    pinInitialDevice: async () => { throw new Error("not used"); },
    applyApproval: async () => { throw new Error("not used"); },
    revokeDevice: async () => undefined,
    listEncryptionRecipients: async () => [],
  } satisfies ClientTrustStore);
  const api = {
    auth: {
      signInPasswordless: overrides.signInPasswordless ?? (async () => response({ message: "ok", data: { isNew: false } })),
      googleSign: overrides.googleSign ?? (async () => { throw new Error("not used"); }),
      verifyEmail: overrides.verifyEmail ?? (async () => { throw new Error("not used"); }),
      refreshTokens: overrides.refreshTokens ?? (async () => { throw new Error("not used"); }),
      logout: async () => response(undefined),
      resendEmailOtp: overrides.resendEmailOtp ?? (async () => response(undefined)),
    },
    devices: {
      registerDevice: async () => response(runtimeRegisteredDevice),
      listDevices: (overrides.listDevices ?? (async () => response([runtimeRegisteredDevice]))) as RuntimeApi["devices"]["listDevices"],
      listPendingDevices: (overrides.listPendingDevices ?? (async () => response([]))) as RuntimeApi["devices"]["listPendingDevices"],
      approveDevice: (overrides.approveDevice ?? (async () => { throw new Error("not used"); })) as RuntimeApi["devices"]["approveDevice"],
    },
  } as unknown as RuntimeApi;
  let socketOptions: SocketOptions | undefined;
  const runtime = new CopyytServiceWorkerRuntime({
    socketUrl: "https://socket.example",
    appVersion: "test",
    sessionStore,
    statusStore,
    trustStore,
    clipboardAdapter,
    processedItemStore: new InMemoryItemMetadataStore(),
    outboundItemStore: new InMemoryItemMetadataStore(),
    apiFactory: () => api,
    socketFactory: (url: string, options: SocketOptions) => {
      void url;
      socketOptions = options;
      return socket;
    },
    identityLoader: overrides.identityLoader ?? (async () => runtimeIdentity),
    identityCreator: overrides.identityCreator ?? (async () => runtimeIdentity),
    registerDevice: overrides.registerDevice ?? (async () => ({ identity: runtimeIdentity, device: runtimeRegisteredDevice })),
    signChallenge: async () => "signed-challenge",
    signApproval: overrides.signApproval,
    encrypt: overrides.encrypt ?? (async (input) => ({
      itemId: "22222222-2222-4222-8222-222222222222",
      sourceDeviceId: input.identity.deviceId,
      sourceKeyVersion: 1,
      sourceSignature: "signature",
      protocolVersion: 1,
      contentType: "text/plain",
      ciphertext: "ciphertext",
      nonce: "nonce",
      recipients: [],
      expiresAt: new Date().toISOString(),
    })),
    decrypt: overrides.decrypt ?? (async () => ({ plaintext: "decrypted plaintext", plaintextBytes: new Uint8Array() })),
  });
  return { runtime, socket, sessionStore, statusStore, trustStore, clipboardAdapter, getSocketOptions: () => socketOptions };
}

test("runtime start is single-flight and worker recreation restores session without stale readiness", async () => {
  const sessionStore = new MemorySessionStore({ schemaVersion: 1, accessToken: "durable-token", user });
  const statusStore = new MemoryStatusStore();
  let identityCreations = 0;
  let registrations = 0;
  const identityLoader = async (): Promise<DeviceIdentity> => identity;
  const identityCreator = async (): Promise<DeviceIdentity> => {
    identityCreations += 1;
    return identity;
  };
  const registerDevice: RuntimeDependencies["registerDevice"] = async () => {
    registrations += 1;
    return { identity, device: registeredDevice };
  };

  const first = makeRuntime({
    localTrustState: "verified",
    sessionStore,
    statusStore,
    identityLoader,
    identityCreator,
    registerDevice,
  });
  await Promise.all([first.runtime.start(), first.runtime.start()]);
  assert.equal(registrations, 1);
  assert.equal(identityCreations, 0);
  first.socket.trigger("auth:ready");
  assert.equal(first.runtime.getStatus().socket.deviceAuthenticated, true);

  const recreatedSocket = new FakeSocket(false);
  const recreated = makeRuntime({
    localTrustState: "verified",
    sessionStore,
    statusStore,
    trustStore: first.trustStore,
    socket: recreatedSocket,
    identityLoader,
    identityCreator,
    registerDevice,
  });
  await recreated.runtime.start();

  assert.equal((await sessionStore.get())?.accessToken, "durable-token");
  assert.equal(recreated.runtime.getStatus().signedIn, true);
  assert.equal(recreated.runtime.getStatus().device.deviceId, identity.deviceId);
  assert.equal(recreated.runtime.getStatus().socket.connected, false);
  assert.equal(recreated.runtime.getStatus().socket.deviceAuthenticated, false);
  assert.equal(recreated.runtime.getStatus().syncReady, false);
  assert.equal(registrations, 2);
  assert.equal(identityCreations, 0);

  recreatedSocket.trigger("auth:ready");
  assert.equal(recreated.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(recreated.runtime.getStatus().syncReady, true);
});

test("socket uses handshake auth token and device auth waits for challenge", async () => {
  const { runtime, socket, getSocketOptions } = makeRuntime();
  await runtime.start();
  assert.deepEqual(getSocketOptions()?.auth, { token: "access-token" });
  assert.equal("extraHeaders" in (getSocketOptions() ?? {}), false);
  assert.equal(socket.emissions.length, 0);
  socket.trigger("auth:challenge", { socketId: "socket-1", challenge: "challenge" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(socket.emissions[0], {
    event: "auth:device",
    args: [{ deviceId: identity.deviceId, keyVersion: 1, signature: "signed-challenge" }],
  });
  assert.notEqual(runtime.getStatus().connectionState, "ready");
  socket.trigger("auth:ready");
  assert.equal(runtime.getStatus().connectionState, "ready");
});

test("server observation alone cannot publish and plaintext is not persisted", async () => {
  const { runtime, socket } = makeRuntime();
  await runtime.start();
  await assert.rejects(
    runtime.publishClipboardText("secret plaintext"),
    (error: unknown) => error instanceof RuntimeError && error.code === "SOCKET_NOT_READY",
  );
  socket.trigger("auth:ready");
  await assert.rejects(
    runtime.publishClipboardText("secret plaintext"),
    (error: unknown) => error instanceof RuntimeError && error.code === "NO_VERIFIED_RECIPIENTS",
  );
});

test("invalid or untrusted inbound items never reach the clipboard", async () => {
  let writes = 0;
  const clipboardAdapter = {
    readText: async () => "",
    writeText: async () => { writes += 1; },
  };
  const { runtime, socket } = makeRuntime({ clipboardAdapter });
  await runtime.start();
  socket.trigger("auth:ready");
  await runtime.receiveClipboardItem({ itemId: "not-an-envelope" });
  assert.equal(writes, 0);
});

test("a verified inbound envelope is written once and duplicates are ignored", async () => {
  let writes = 0;
  const clipboardAdapter = {
    readText: async () => "",
    writeText: async () => { writes += 1; },
  };
  const { runtime, socket } = makeRuntime({
    clipboardAdapter,
    localTrustState: "verified",
  });
  await runtime.start();
  socket.trigger("auth:ready");
  const envelope = {
    itemId: "33333333-3333-4333-8333-333333333333",
    sourceDeviceId: identity.deviceId,
    sourceKeyVersion: 1,
    sourceSignature: "signature",
    protocolVersion: 1 as const,
    contentType: "text/plain",
    ciphertext: "ciphertext",
    nonce: "nonce",
    recipients: [{ deviceId: identity.deviceId, deviceKeyVersion: 1, wrapNonce: "nonce", wrappedContentKey: "wrapped" }],
    expiresAt: new Date().toISOString(),
  };
  await runtime.receiveClipboardItem(envelope);
  await runtime.receiveClipboardItem(envelope);
  assert.equal(writes, 1);
});

test("a self-echo is decrypted but does not rewrite the local clipboard", async () => {
  let writes = 0;
  const clipboardAdapter = {
    readText: async () => "",
    writeText: async () => { writes += 1; },
  };
  const { runtime, socket } = makeRuntime({
    clipboardAdapter,
    localTrustState: "verified",
  });
  await runtime.start();
  socket.trigger("auth:ready");
  await runtime.publishClipboardText("secret plaintext");
  const published = socket.emissions.find((item) => item.event === "clipboard:publish")?.args[0];
  assert.ok(published);
  await runtime.receiveClipboardItem(published);
  assert.equal(writes, 0);
});

function runtimeMessage(command: RuntimeCommand, requestId = crypto.randomUUID()) {
  return {
    source: "popup" as const,
    target: "service-worker" as const,
    requestId,
    command,
  };
}

test("Google authentication saves its response as the normal runtime session", async () => {
  const setup = makeRuntime({
    initialSession: null,
    googleSign: async () =>
      response({
        message: "Google Auth Successful",
        accessToken: "google-access-token",
        refreshToken: "google-refresh-token",
        user,
      }),
  });

  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-google", googleToken: "google-token" }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 1,
    accessToken: "google-access-token",
    user,
  });
  assert.equal(setup.runtime.getStatus().signedIn, true);
});

test("OTP verification saves its response as the normal runtime session", async () => {
  const setup = makeRuntime({
    initialSession: null,
    verifyEmail: async () =>
      response({
        message: "Signin Successful",
        accessToken: "otp-access-token",
        refreshToken: "otp-refresh-token",
        user,
      }),
  });

  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:auth-verify-email",
      email: "test@example.com",
      code: 123456,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal((await setup.sessionStore.get())?.accessToken, "otp-access-token");
  assert.equal(setup.runtime.getStatus().signedIn, true);
});

async function startReady(overrides: Parameters<typeof makeRuntime>[0] = {}) {
  const setup = makeRuntime({ localTrustState: "verified", ...overrides });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  return setup;
}

test("sync failures preserve a ready authenticated socket and a later publish succeeds", async () => {
  const setup = await startReady({
    clipboardAdapter: {
      readText: async () => { throw new Error("read failed"); },
      writeText: async () => undefined,
    },
  });
  const failedRead = await setup.runtime.handleMessage(runtimeMessage({ type: "runtime:send-current-clipboard" }));
  assert.equal(failedRead.ok, false);
  assert.equal(setup.runtime.getStatus().connectionState, "ready");
  assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(setup.runtime.getStatus().syncReady, true);
  assert.equal(setup.runtime.getStatus().lastSyncError?.code, "CLIPBOARD_READ_FAILED");

  const published = await setup.runtime.publishClipboardText("valid after read failure");
  assert.equal(published.itemId, "22222222-2222-4222-8222-222222222222");
  assert.equal(setup.runtime.getStatus().connectionState, "ready");
});

test("NO_VERIFIED_RECIPIENTS preserves a ready transport for onboarding", async () => {
  const setup = makeRuntime();
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  const result = await setup.runtime.handleMessage(runtimeMessage({ type: "runtime:send-current-clipboard" }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "NO_VERIFIED_RECIPIENTS");
  assert.equal(setup.runtime.getStatus().connectionState, "ready");
  assert.equal(setup.runtime.getStatus().socket.connected, true);
  assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(setup.runtime.getStatus().lastSyncError?.code, "NO_VERIFIED_RECIPIENTS");
});

test("invalid envelopes and bad source signatures do not demote a ready socket", async () => {
  const invalid = await startReady();
  await invalid.runtime.receiveClipboardItem({ invalid: true });
  assert.equal(invalid.runtime.getStatus().connectionState, "ready");
  assert.equal(invalid.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(invalid.runtime.getStatus().lastSyncError?.code, "DECRYPTION_FAILED");

  const badSignature = await startReady({
    decrypt: async () => { throw new Error("bad signature"); },
  });
  await badSignature.runtime.receiveClipboardItem({
    itemId: "33333333-3333-4333-8333-333333333333",
    sourceDeviceId: identity.deviceId,
    sourceKeyVersion: 1,
    sourceSignature: "signature",
    protocolVersion: 1 as const,
    contentType: "text/plain",
    ciphertext: "ciphertext",
    nonce: "nonce",
    recipients: [{ deviceId: identity.deviceId, deviceKeyVersion: 1, wrapNonce: "nonce", wrappedContentKey: "wrapped" }],
    expiresAt: new Date().toISOString(),
  });
  assert.equal(badSignature.runtime.getStatus().connectionState, "ready");
  assert.equal(badSignature.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(badSignature.runtime.getStatus().lastSyncError?.code, "DECRYPTION_FAILED");
});

test("disconnect and authentication failure are connection errors", async () => {
  const disconnected = await startReady();
  disconnected.socket.trigger("disconnect");
  assert.equal(disconnected.runtime.getStatus().connectionState, "error");
  assert.equal(disconnected.runtime.getStatus().socket.deviceAuthenticated, false);

  const authFailure = await startReady();
  authFailure.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(authFailure.runtime.getStatus().connectionState, "error");
  assert.equal(authFailure.runtime.getStatus().socket.deviceAuthenticated, false);
});

function jwtWithExpiry(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.unsigned`;
}

function refreshedSession(token: string): SignInResponse {
  return { message: "refreshed", accessToken: token, refreshToken: "refresh", user };
}

test("normal signed-out startup does not attempt refresh or produce an auth error", async () => {
  let refreshCalls = 0;
  const setup = makeRuntime({
    initialSession: null,
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession("unexpected-token"));
    },
  });

  await setup.runtime.start();

  assert.equal(refreshCalls, 0);
  assert.equal(setup.runtime.getStatus().signedIn, false);
  assert.equal(setup.runtime.getStatus().user, undefined);
  assert.equal(setup.runtime.getStatus().lastConnectionError, undefined);
});

test("an expired persisted token is refreshed before the first socket", async () => {
  const newToken = "fresh-access-token";
  let refreshCalls = 0;
  const setup = makeRuntime({
    accessToken: jwtWithExpiry(Math.floor(Date.now() / 1000) - 10),
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession(newToken));
    },
  });
  await setup.runtime.start();
  assert.equal(refreshCalls, 1);
  assert.deepEqual(setup.getSocketOptions()?.auth, { token: newToken });
});

test("socket auth failure recreates the socket with a refreshed token", async () => {
  const newToken = "reconnected-access-token";
  let refreshCalls = 0;
  const setup = makeRuntime({
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession(newToken));
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  assert.deepEqual(setup.getSocketOptions()?.auth, { token: newToken });
});

test("a post-challenge auth failure does not refresh the account token", async () => {
  let refreshCalls = 0;
  const setup = makeRuntime({
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession("unexpected-token"));
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:challenge", { socketId: "socket-1", challenge: "challenge" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  setup.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 0);
  assert.equal(setup.runtime.getStatus().lastConnectionError?.code, "DEVICE_AUTH_FAILED");
});

test("concurrent socket authentication failures perform one refresh", async () => {
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const setup = makeRuntime({
    refreshTokens: async () => {
      refreshCalls += 1;
      await refreshGate;
      return response(refreshedSession("single-flight-token"));
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:failure");
  setup.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  releaseRefresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(setup.getSocketOptions()?.auth, { token: "single-flight-token" });
});

test("transient refresh failure retains the local session while definitive rejection clears it", async () => {
  const transient = makeRuntime({ refreshTokens: async () => { throw new Error("network down"); } });
  await transient.runtime.start();
  transient.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(await transient.sessionStore.get());

  const definitive = makeRuntime({
    refreshTokens: async () => { throw { response: { status: 401 } }; },
  });
  await definitive.runtime.start();
  definitive.socket.trigger("auth:failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await definitive.sessionStore.get(), null);
});

function makePairingTrustStore(
  rootIdentity: DeviceIdentity = identity,
  rootDevice: RegisteredDeviceResponse = registeredDevice,
  initialDevice?: { identity: DeviceIdentity; device: RegisteredDeviceResponse },
): {
  trustStore: ClientTrustStore;
  records: Map<string, LocalDeviceRecord>;
  applied: LocalDeviceRecord["approvalCertificate"];
} {
  const records = new Map<string, LocalDeviceRecord>();
  const rootRecord: LocalDeviceRecord = {
    userId: user.id,
    deviceId: rootIdentity.deviceId,
    keyVersion: 1,
    encryptionPublicKey: rootDevice.encryptionPublicKey,
    signingPublicKey: rootDevice.signingPublicKey,
    trustState: "root",
    trustOrigin: "initial-tofu",
  };
  if (initialDevice) {
    records.set(`${user.id}:${initialDevice.identity.deviceId}`, {
      userId: user.id,
      deviceId: initialDevice.identity.deviceId,
      keyVersion: initialDevice.device.keyVersion,
      encryptionPublicKey: initialDevice.device.encryptionPublicKey,
      signingPublicKey: initialDevice.device.signingPublicKey,
      trustState: "unverified",
    });
  } else {
    records.set(`${user.id}:${rootIdentity.deviceId}`, rootRecord);
  }
  let applied: LocalDeviceRecord["approvalCertificate"];
  const key = (deviceId: string) => `${user.id}:${deviceId}`;
  const trustStore: ClientTrustStore = {
    getDevice: async (_userId, deviceId) => records.get(key(deviceId)) ?? null,
    upsertServerReportedDevice: async (device) => {
      const current = records.get(key(device.deviceId));
      if (current?.trustState === "root" || current?.trustState === "verified") return current;
      const next: LocalDeviceRecord = {
        ...device,
        trustState: device.trustState === "revoked" ? "revoked" : "unverified",
      };
      records.set(key(device.deviceId), next);
      return next;
    },
    bootstrapInitialTrustAnchor: async () => records.get(key(rootIdentity.deviceId))! as ClientVerifiedDevice,
    pinPairedApprover: async (_userId, localIdentity, approverDeviceId, confirmedFingerprint) => {
      const approver = records.get(key(approverDeviceId));
      if (!approver || approver.trustState !== "unverified") throw new Error("approver missing");
      const paired: ClientVerifiedDevice = {
        ...approver,
        trustState: "root",
        trustOrigin: "pairing",
        pairedForDeviceId: localIdentity.deviceId,
        pairingFingerprint: confirmedFingerprint,
        pinnedAt: new Date().toISOString(),
      };
      records.set(key(approverDeviceId), paired);
      return paired;
    },
    pinInitialDevice: async () => { throw new Error("not used"); },
    applyApproval: async (_userId, certificate) => {
      const pending = records.get(key(certificate.pendingDeviceId));
      if (!pending) throw new Error("pending device missing");
      const verified = { ...pending, trustState: "verified", approvalCertificate: certificate } as ClientVerifiedDevice;
      records.set(key(certificate.pendingDeviceId), verified);
      applied = certificate;
      return verified;
    },
    revokeDevice: async () => undefined,
    listEncryptionRecipients: async () => [...records.values()].filter(
      (device): device is ClientVerifiedDevice => device.trustState === "root" || device.trustState === "verified",
    ),
  };
  return { trustStore, records, get applied() { return applied; } };
}

function putLocalRecord(
  records: Map<string, LocalDeviceRecord>,
  device: RegisteredDeviceResponse,
  trustState: LocalDeviceRecord["trustState"],
  extra: Partial<LocalDeviceRecord> = {},
): void {
  records.set(`${user.id}:${device.deviceId}`, {
    userId: user.id,
    deviceId: device.deviceId,
    keyVersion: device.keyVersion,
    encryptionPublicKey: device.encryptionPublicKey,
    signingPublicKey: device.signingPublicKey,
    trustState,
    ...extra,
  });
}

test("bootstrap is backend-gated and the approver requires an exact pairing fingerprint", async () => {
  const pendingIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: ["clipboard"] },
  } as unknown as DeviceIdentity;
  const laterDevice = makeRuntime({
    identity: pendingIdentity,
    registeredDevice: pendingDevice,
    listDevices: async () => response([registeredDevice, pendingDevice]),
  });
  await laterDevice.runtime.start();
  const blocked = await laterDevice.runtime.handleMessage(runtimeMessage({ type: "runtime:bootstrap-trust-anchor" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "DEVICE_NOT_LOCALLY_TRUSTED");

  const firstDevice = makeRuntime({ listDevices: async () => response([registeredDevice]) });
  await firstDevice.runtime.start();
  assert.equal(firstDevice.runtime.getStatus().onboarding.bootstrapEligible, true);
  const bootstrapped = await firstDevice.runtime.handleMessage(runtimeMessage({ type: "runtime:bootstrap-trust-anchor" }));
  assert.equal(bootstrapped.ok, true);
});

test("the runtime approver displays the full-key fingerprint and applies the signed approval locally", async () => {
  const pairing = makePairingTrustStore();
  let approvalRequests = 0;
  let approvalRequestKeys: string[] = [];
  const setup = makeRuntime({
    trustStore: pairing.trustStore,
    localTrustState: "root",
    listDevices: async () => response([registeredDevice, pendingDevice]),
    listPendingDevices: async () => response([pendingDevice]),
    signApproval: async () => "approval-signature",
    approveDevice: async (request) => {
      approvalRequests += 1;
      approvalRequestKeys = Object.keys(request as object).sort();
      assert.deepEqual(approvalRequestKeys, ["approvalSignature", "approvingDeviceId", "pendingDeviceId"]);
      const certificate = request as { approvingDeviceId: string; approvalSignature: string };
      return response({
        ...pendingDevice,
        trustState: "trusted",
        approvedByDeviceId: certificate.approvingDeviceId,
        approvalSignature: certificate.approvalSignature,
      });
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  const pairingStatus = setup.runtime.getStatus().onboarding.pairing;
  assert.equal(pairingStatus?.role, "approver");
  assert.ok(pairingStatus?.fingerprint);

  const wrong = await setup.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: pendingDevice.deviceId,
    confirmedFingerprint: "0000-0000-0000-0000-0000-0000",
  }));
  assert.equal(wrong.ok, false);
  assert.equal(approvalRequests, 0);
  assert.equal(setup.runtime.getStatus().connectionState, "ready");

  const approved = await setup.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: pendingDevice.deviceId,
    confirmedFingerprint: pairingStatus!.fingerprint,
  }));
  assert.equal(approved.ok, true);
  assert.equal(approvalRequests, 1);
  assert.deepEqual(approvalRequestKeys, ["approvalSignature", "approvingDeviceId", "pendingDeviceId"]);
  assert.equal(pairing.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "verified");
  assert.equal(pairing.applied?.approvalSignature, "approval-signature");
});

test("account-root selection is independent of server array order and fails closed", () => {
  const approvedChild: RegisteredDeviceResponse = {
    ...pendingDevice,
    trustState: "trusted",
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "approval-signature",
  };
  assert.equal(
    findUniqueAccountRootCandidate([approvedChild, registeredDevice]).deviceId,
    registeredDevice.deviceId,
  );
  assert.equal(
    findUniqueAccountRootCandidate([registeredDevice, approvedChild]).deviceId,
    registeredDevice.deviceId,
  );
  assert.throws(
    () => findUniqueAccountRootCandidate([approvedChild]),
    /could not identify the account root/i,
  );
  assert.throws(
    () => findUniqueAccountRootCandidate([
      registeredDevice,
      { ...pendingDevice, trustState: "trusted" },
    ]),
    /multiple account root devices/i,
  );
});

test("a verified secondary device cannot approve a pending device", async () => {
  const secondaryIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const secondaryDevice: RegisteredDeviceResponse = {
    ...pendingDevice,
    trustState: "trusted",
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "approval-signature",
  };
  const thirdDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Third Chrome",
    trustState: "pending",
  };
  let signCalls = 0;
  let approvalCalls = 0;
  const setup = makeRuntime({
    identity: secondaryIdentity,
    registeredDevice: secondaryDevice,
    localTrustState: "verified",
    listDevices: async () => response([secondaryDevice, registeredDevice]),
    listPendingDevices: async () => response([thirdDevice]),
    signApproval: async () => {
      signCalls += 1;
      return "should-not-sign";
    },
    approveDevice: async () => {
      approvalCalls += 1;
      return response(thirdDevice);
    },
  });
  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: thirdDevice.deviceId,
    confirmedFingerprint: "0000-0000-0000-0000-0000-0000",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEVICE_NOT_LOCALLY_TRUSTED");
  assert.equal(signCalls, 0);
  assert.equal(approvalCalls, 0);
});

test("certificate reconciliation promotes a device from any locally trusted approver", async () => {
  const bIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const bServer: RegisteredDeviceResponse = {
    ...pendingDevice,
    trustState: "trusted",
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "a-to-b",
  };
  const cServer: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Third Chrome",
    trustState: "trusted",
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "a-to-c",
  };
  const pairing = makePairingTrustStore();
  pairing.records.set(`${user.id}:${bServer.deviceId}`, {
    userId: user.id,
    deviceId: bServer.deviceId,
    keyVersion: bServer.keyVersion,
    encryptionPublicKey: bServer.encryptionPublicKey,
    signingPublicKey: bServer.signingPublicKey,
    trustState: "verified",
  });
  pairing.records.set(`${user.id}:${cServer.deviceId}`, {
    userId: user.id,
    deviceId: cServer.deviceId,
    keyVersion: cServer.keyVersion,
    encryptionPublicKey: cServer.encryptionPublicKey,
    signingPublicKey: cServer.signingPublicKey,
    trustState: "unverified",
  });
  const setup = makeRuntime({
    identity: bIdentity,
    registeredDevice: bServer,
    trustStore: pairing.trustStore,
    listDevices: async () => response([cServer, bServer, registeredDevice]),
    listPendingDevices: async () => response([]),
  });
  await setup.runtime.start();
  assert.equal(setup.runtime.getStatus().onboarding.state, "complete");
  assert.equal(pairing.records.get(`${user.id}:${cServer.deviceId}`)?.trustState, "verified");
  assert.equal(pairing.applied?.approvingDeviceId, registeredDevice.deviceId);
  assert.equal(pairing.applied?.pendingDeviceId, cServer.deviceId);
});

test("three devices converge on the original account root regardless of refresh order", async () => {
  const bIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const cDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Third Chrome",
    trustState: "pending",
  };
  const cIdentity = {
    ...identity,
    deviceId: cDevice.deviceId,
    registration: { keyVersion: 1, name: cDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const devices = new Map<string, RegisteredDeviceResponse>([
    [registeredDevice.deviceId, registeredDevice],
    [pendingDevice.deviceId, pendingDevice],
  ]);
  let listOrder = 0;
  let approvalCalls = 0;
  const listTrusted = async () => {
    const active = [...devices.values()].filter((device) => device.trustState === "trusted");
    const ordered = listOrder++ % 2 === 0 ? active.reverse() : active;
    return response(ordered);
  };
  const listPending = async () => response(
    [...devices.values()].filter((device) => device.trustState === "pending").reverse(),
  );
  const approve = async (request: unknown) => {
    approvalCalls += 1;
    const dto = request as { approvingDeviceId: string; pendingDeviceId: string; approvalSignature: string };
    assert.equal(dto.approvingDeviceId, registeredDevice.deviceId);
    const current = devices.get(dto.pendingDeviceId)!;
    const approved = {
      ...current,
      trustState: "trusted" as const,
      approvedByDeviceId: dto.approvingDeviceId,
      approvalSignature: dto.approvalSignature,
    };
    devices.set(dto.pendingDeviceId, approved);
    return response(approved);
  };
  const apiOverrides = {
    listDevices: listTrusted,
    listPendingDevices: listPending,
    approveDevice: approve,
  };

  const aStore = makePairingTrustStore();
  const a = makeRuntime({
    trustStore: aStore.trustStore,
    localTrustState: "root",
    ...apiOverrides,
    signApproval: async ({ pendingDevice: pending }) =>
      pending.pendingDeviceId === pendingDevice.deviceId ? "a-to-b" : "a-to-c",
  });
  const bStore = makePairingTrustStore(bIdentity, pendingDevice, {
    identity: bIdentity,
    device: pendingDevice,
  });
  const b = makeRuntime({
    identity: bIdentity,
    registeredDevice: {
      ...pendingDevice,
      trustState: "trusted",
      approvedByDeviceId: registeredDevice.deviceId,
      approvalSignature: "a-to-b",
    },
    trustStore: bStore.trustStore,
    ...apiOverrides,
  });

  await a.runtime.start();
  await b.runtime.start();
  const bPairing = b.runtime.getStatus().onboarding.pairing!;
  assert.equal(bPairing.approverDeviceId, registeredDevice.deviceId);
  await b.runtime.handleMessage(runtimeMessage({
    type: "runtime:confirm-paired-approver",
    approverDeviceId: bPairing.approverDeviceId,
    confirmedFingerprint: bPairing.fingerprint,
  }));
  const aPairingForB = a.runtime.getStatus().onboarding.pairing!;
  await a.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: pendingDevice.deviceId,
    confirmedFingerprint: aPairingForB.fingerprint,
  }));
  await b.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  assert.equal(bStore.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "verified");

  devices.set(cDevice.deviceId, cDevice);
  await a.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  await b.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  const cStore = makePairingTrustStore(cIdentity, cDevice, {
    identity: cIdentity,
    device: cDevice,
  });
  const c = makeRuntime({
    identity: cIdentity,
    registeredDevice: cDevice,
    trustStore: cStore.trustStore,
    ...apiOverrides,
  });
  await c.runtime.start();
  const cPairing = c.runtime.getStatus().onboarding.pairing!;
  assert.equal(cPairing.role, "pending");
  assert.equal(cPairing.approverDeviceId, registeredDevice.deviceId);
  assert.equal(cPairing.fingerprint, a.runtime.getStatus().onboarding.pairing?.fingerprint);

  await a.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  await b.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  assert.equal(b.runtime.getStatus().onboarding.pairing, undefined);
  const blocked = await b.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: cDevice.deviceId,
    confirmedFingerprint: cPairing.fingerprint,
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "DEVICE_NOT_LOCALLY_TRUSTED");

  await c.runtime.handleMessage(runtimeMessage({
    type: "runtime:confirm-paired-approver",
    approverDeviceId: cPairing.approverDeviceId,
    confirmedFingerprint: cPairing.fingerprint,
  }));
  const aPairingForC = a.runtime.getStatus().onboarding.pairing!;
  await a.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: cDevice.deviceId,
    confirmedFingerprint: aPairingForC.fingerprint,
  }));
  assert.equal(approvalCalls, 2);

  await Promise.all([
    a.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" })),
    b.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" })),
    c.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" })),
  ]);
  for (const store of [aStore, bStore, cStore]) {
    assert.deepEqual(
      [...store.records.values()]
        .filter((device) => device.trustState === "root" || device.trustState === "verified")
        .map((device) => device.deviceId)
        .sort(),
      [registeredDevice.deviceId, pendingDevice.deviceId, cDevice.deviceId].sort(),
    );
  }
});

test("root revocation preserves verified B/C sync while blocking new trust", async () => {
  const bIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const cDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Third Chrome",
    encryptionPublicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw=",
    signingPublicKey: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    trustState: "trusted",
  };
  const cIdentity = {
    ...identity,
    deviceId: cDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(4),
    signingPublicKeyBase64: cDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(3),
    encryptionPublicKeyBase64: cDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: cDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const bServer: RegisteredDeviceResponse = {
    ...pendingDevice,
    trustState: "trusted",
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "a-to-b",
  };
  const cServer: RegisteredDeviceResponse = {
    ...cDevice,
    approvedByDeviceId: registeredDevice.deviceId,
    approvalSignature: "a-to-c",
  };
  const dDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000004",
    name: "Fourth Chrome",
    trustState: "pending",
  };
  const dIdentity = {
    ...identity,
    deviceId: dDevice.deviceId,
    registration: { keyVersion: 1, name: dDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const listDevices = async () => response([bServer, cServer]);
  const listPendingDevices = async () => response<RegisteredDeviceResponse[]>([dDevice]);

  const makeVerifiedSecondary = (
    secondaryIdentity: DeviceIdentity,
    secondaryDevice: RegisteredDeviceResponse,
  ) => {
    const pairing = makePairingTrustStore(identity, registeredDevice, {
      identity: secondaryIdentity,
      device: secondaryDevice,
    });
    putLocalRecord(pairing.records, registeredDevice, "root", { trustOrigin: "initial-tofu" });
    putLocalRecord(pairing.records, bServer, "verified");
    putLocalRecord(pairing.records, cServer, "verified");
    return pairing;
  };
  const bStore = makeVerifiedSecondary(bIdentity, bServer);
  const cStore = makeVerifiedSecondary(cIdentity, cServer);
  const dStore = makePairingTrustStore(identity, registeredDevice, {
    identity: dIdentity,
    device: dDevice,
  });
  const bRecipientIds: string[] = [];
  const cRecipientIds: string[] = [];
  const captureRecipients = (target: string[]) => async (input: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0]) => {
    target.push(...input.recipients.map((recipient) => recipient.deviceId));
    return {
      itemId: "22222222-2222-4222-8222-222222222222",
      sourceDeviceId: input.identity.deviceId,
      sourceKeyVersion: 1,
      sourceSignature: "signature",
      protocolVersion: 1 as const,
      contentType: "text/plain",
      ciphertext: "ciphertext",
      nonce: "nonce",
      recipients: [],
      expiresAt: new Date().toISOString(),
    };
  };
  const b = makeRuntime({
    identity: bIdentity,
    registeredDevice: bServer,
    trustStore: bStore.trustStore,
    listDevices,
    listPendingDevices,
    encrypt: captureRecipients(bRecipientIds),
  });
  const c = makeRuntime({
    identity: cIdentity,
    registeredDevice: cServer,
    trustStore: cStore.trustStore,
    listDevices,
    listPendingDevices,
    encrypt: captureRecipients(cRecipientIds),
  });
  const d = makeRuntime({
    identity: dIdentity,
    registeredDevice: dDevice,
    trustStore: dStore.trustStore,
    listDevices,
    listPendingDevices,
  });

  await Promise.all([b.runtime.start(), c.runtime.start(), d.runtime.start()]);
  b.socket.trigger("auth:ready");
  c.socket.trigger("auth:ready");
  await Promise.all([
    b.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" })),
    c.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" })),
  ]);

  for (const setup of [b, c]) {
    assert.equal(setup.runtime.getStatus().device.trustState, "verified");
    assert.equal(setup.runtime.getStatus().socket.connected, true);
    assert.equal(setup.runtime.getStatus().syncReady, true);
    assert.equal(setup.runtime.getStatus().onboarding.state, "pairing-required");
    assert.match(setup.runtime.getStatus().onboarding.error?.message ?? "", /root device is unavailable/i);
  }
  assert.equal(d.runtime.getStatus().socket.connected, false);
  assert.match(d.runtime.getStatus().onboarding.error?.message ?? "", /root device is unavailable/i);
  for (const setup of [b, c]) {
    const approval = await setup.runtime.handleMessage(runtimeMessage({
      type: "runtime:approve-pending-device",
      pendingDeviceId: dDevice.deviceId,
      confirmedFingerprint: "not-used",
    }));
    assert.equal(approval.ok, false);
    assert.equal(approval.error?.code, "DEVICE_NOT_LOCALLY_TRUSTED");
  }
  for (const approverDeviceId of [bServer.deviceId, cServer.deviceId]) {
    const confirmation = await d.runtime.handleMessage(runtimeMessage({
      type: "runtime:confirm-paired-approver",
      approverDeviceId,
      confirmedFingerprint: "not-used",
    }));
    assert.equal(confirmation.ok, false);
    assert.equal(confirmation.error?.code, "PAIRING_FAILED");
  }
  assert.equal(bStore.records.get(`${user.id}:${bServer.deviceId}`)?.trustState, "verified");
  assert.equal(cStore.records.get(`${user.id}:${cServer.deviceId}`)?.trustState, "verified");
  await Promise.all([
    b.runtime.publishClipboardText("root-revoked-b"),
    c.runtime.publishClipboardText("root-revoked-c"),
  ]);
  assert.deepEqual(bRecipientIds.sort(), [bServer.deviceId, cServer.deviceId].sort());
  assert.deepEqual(cRecipientIds.sort(), [bServer.deviceId, cServer.deviceId].sort());
  assert.equal(bRecipientIds.includes(registeredDevice.deviceId), false);
  assert.equal(cRecipientIds.includes(registeredDevice.deviceId), false);
});

test("ambiguous roots preserve existing sync but block approval and pending-device root choice", async () => {
  const bIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const cDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Third Chrome",
    trustState: "trusted",
  };
  const dDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000004",
    name: "Fourth Chrome",
    encryptionPublicKey: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    signingPublicKey: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
    trustState: "pending",
  };
  const dIdentity = {
    ...identity,
    deviceId: dDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(6),
    signingPublicKeyBase64: dDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(5),
    encryptionPublicKeyBase64: dDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: dDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const bServer: RegisteredDeviceResponse = { ...pendingDevice, trustState: "trusted" };
  const listDevices = async () => response<RegisteredDeviceResponse[]>([bServer, cDevice]);
  const listPendingDevices = async () => response<RegisteredDeviceResponse[]>([dDevice]);
  const bStore = makePairingTrustStore(bIdentity, bServer);
  putLocalRecord(bStore.records, cDevice, "verified");
  const cIdentity = {
    ...identity,
    deviceId: cDevice.deviceId,
    registration: { keyVersion: 1, name: cDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const cStore = makePairingTrustStore(cIdentity, cDevice);
  putLocalRecord(cStore.records, pendingDevice, "verified");
  const b = makeRuntime({
    identity: bIdentity,
    registeredDevice: bServer,
    trustStore: bStore.trustStore,
    listDevices,
    listPendingDevices,
    signApproval: async () => {
      throw new Error("must not sign with an ambiguous root");
    },
  });
  const c = makeRuntime({
    identity: cIdentity,
    registeredDevice: cDevice,
    trustStore: cStore.trustStore,
    listDevices,
    listPendingDevices,
  });
  const dStore = makePairingTrustStore(bIdentity, pendingDevice, {
    identity: dIdentity,
    device: dDevice,
  });
  const d = makeRuntime({
    identity: dIdentity,
    registeredDevice: dDevice,
    trustStore: dStore.trustStore,
    listDevices,
    listPendingDevices,
  });

  await Promise.all([b.runtime.start(), c.runtime.start(), d.runtime.start()]);
  b.socket.trigger("auth:ready");
  c.socket.trigger("auth:ready");
  assert.equal(b.runtime.getStatus().syncReady, true);
  assert.equal(c.runtime.getStatus().syncReady, true);
  assert.match(b.runtime.getStatus().onboarding.error?.message ?? "", /root is ambiguous/i);
  assert.match(c.runtime.getStatus().onboarding.error?.message ?? "", /root is ambiguous/i);
  assert.match(d.runtime.getStatus().onboarding.error?.message ?? "", /root is ambiguous/i);
  assert.equal(d.runtime.getStatus().socket.connected, false);

  const approval = await b.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: dDevice.deviceId,
    confirmedFingerprint: "not-used",
  }));
  assert.equal(approval.ok, false);
  assert.equal(approval.error?.code, "PAIRING_FAILED");
  const confirmation = await d.runtime.handleMessage(runtimeMessage({
    type: "runtime:confirm-paired-approver",
    approverDeviceId: pendingDevice.deviceId,
    confirmedFingerprint: "not-used",
  }));
  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.error?.code, "PAIRING_FAILED");
});

test("publishing intersects local recipients with active server-trusted devices", async () => {
  const bIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: [] },
  } as unknown as DeviceIdentity;
  const cDevice: RegisteredDeviceResponse = {
    ...registeredDevice,
    deviceId: "00000000-0000-4000-8000-000000000003",
    name: "Revoked Chrome",
    trustState: "trusted",
  };
  const bServer: RegisteredDeviceResponse = { ...pendingDevice, trustState: "trusted" };
  const bStore = makePairingTrustStore(bIdentity, bServer);
  putLocalRecord(bStore.records, cDevice, "verified");
  let recipientIds: string[] = [];
  const setup = makeRuntime({
    identity: bIdentity,
    registeredDevice: bServer,
    trustStore: bStore.trustStore,
    localTrustState: "root",
    listDevices: async () => response<RegisteredDeviceResponse[]>([bServer]),
    listPendingDevices: async () => response<RegisteredDeviceResponse[]>([]),
    encrypt: async (input) => {
      recipientIds = input.recipients.map((recipient) => recipient.deviceId);
      return {
        itemId: "22222222-2222-4222-8222-222222222222",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  await setup.runtime.publishClipboardText("server-filtered");
  assert.deepEqual(recipientIds, [pendingDevice.deviceId]);
});

function clipboardObservation(text: string) {
  return {
    source: "offscreen" as const,
    target: "service-worker" as const,
    type: "CLIPBOARD_CHANGED" as const,
    text,
  };
}

test("automatic observations use the same publish path as manual Send", async () => {
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  const encryptedTexts: string[] = [];
  const clipboardAdapter: ClipboardAdapter = {
    readText: async () => "manual text",
    writeText: async () => undefined,
    startWatching: async (options) => {
      watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
    },
    stopWatching: async () => {
      watchCalls.push({ type: "stop" });
    },
  };
  const setup = await startReady({
    localTrustState: "verified",
    clipboardAdapter,
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      return {
        itemId: `${encryptedTexts.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.runtime.getStatus().clipboardWatch, "watching");
  assert.deepEqual(watchCalls, [
    { type: "stop" },
    { type: "start", resetBaseline: true },
  ]);

  const manual = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(manual.ok, true);
  await setup.runtime.handleClipboardObservation(clipboardObservation("automatic text"));
  assert.deepEqual(encryptedTexts, ["manual text", "automatic text"]);
  assert.equal(typeof setup.runtime.getStatus().lastAutoSyncAt, "string");
});

test("an offscreen clipboard change routes to automatic publish without popup involvement", async () => {
  const encryptedTexts: string[] = [];
  const setup = await startReady({
    localTrustState: "verified",
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      return {
        itemId: "offscreen-automatic-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });

  let clipboard = "baseline";
  const callbacks = new Map<number, () => void>();
  let nextTimerId = 1;
  const setIntervalFn: NonNullable<ClipboardWatcherOptions["setIntervalFn"]> =
    (handler) => {
    const id = nextTimerId++;
    callbacks.set(id, handler as () => void);
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  };
  const clearIntervalFn: NonNullable<ClipboardWatcherOptions["clearIntervalFn"]> =
    (handle) => {
    callbacks.delete(handle as unknown as number);
  };
  const runtimeListener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async () => {
        throw new Error("popup runtime path must not be used");
      },
      handleClipboardObservation: (message) =>
        setup.runtime.handleClipboardObservation(message),
    },
    runtimeReady: Promise.resolve(),
    getStartupError: () => null,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });
  const runtime = {
    sendMessage(message: unknown): Promise<unknown> {
      if (this !== runtime) throw new TypeError("Illegal invocation");
      return new Promise((resolve, reject) => {
        const accepted = runtimeListener(
          message,
          {
            id: "extension-id",
            url: "chrome-extension://extension-id/offscreen.html",
            contextType: "OFFSCREEN_DOCUMENT",
          },
          resolve,
        );
        if (!accepted) reject(new Error("offscreen observation was rejected"));
      });
    },
  };
  const watcher = createOffscreenClipboardWatcher({
    readText: () => clipboard,
    runtime,
    setIntervalFn,
    clearIntervalFn,
  });

  watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  clipboard = "automatic text";
  for (const callback of [...callbacks.values()]) callback();
  for (let attempt = 0; attempt < 5 && encryptedTexts.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(encryptedTexts, ["automatic text"]);
  watcher.stop();
});

test("automatic observations are dropped while sync is not ready and are not queued", async () => {
  let encryptions = 0;
  const setup = makeRuntime({
    localTrustState: "unverified",
    encrypt: async (input) => {
      encryptions += 1;
      return {
        itemId: "automatic-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  await setup.runtime.handleClipboardObservation(clipboardObservation("stale"));
  assert.equal(encryptions, 0);
  assert.equal(setup.runtime.getStatus().lastAutoSyncAt, undefined);
});

test("automatic publishing is single-flight and latest-wins", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const encryptedTexts: string[] = [];
  const setup = await startReady({
    localTrustState: "verified",
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      if (encryptedTexts.length === 1) await firstGate;
      return {
        itemId: `${encryptedTexts.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });

  const first = setup.runtime.handleClipboardObservation(clipboardObservation("first"));
  await new Promise((resolve) => setImmediate(resolve));
  const second = setup.runtime.handleClipboardObservation(clipboardObservation("second"));
  const third = setup.runtime.handleClipboardObservation(clipboardObservation("latest"));
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(encryptedTexts, ["first", "latest"]);
});

test("a locally revoked device cannot auto-publish", async () => {
  let encryptions = 0;
  const setup = makeRuntime({
    localTrustState: "revoked",
    encrypt: async (input) => {
      encryptions += 1;
      return {
        itemId: "revoked-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: new Date().toISOString(),
      };
    },
  });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  await setup.runtime.handleClipboardObservation(clipboardObservation("revoked"));
  assert.equal(encryptions, 0);
});

test("trusted and pending collections drive the complete restart-safe pairing ceremony", async () => {
  const pendingIdentity = {
    ...identity,
    deviceId: pendingDevice.deviceId,
    signingPublicKey: new Uint8Array(32).fill(2),
    signingPublicKeyBase64: pendingDevice.signingPublicKey,
    encryptionPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKeyBase64: pendingDevice.encryptionPublicKey,
    registration: { keyVersion: 1, name: pendingDevice.name, platform: "chrome", capabilities: ["clipboard"] },
  } as unknown as DeviceIdentity;
  let serverPending = true;
  let serverApprovalSignature: string | undefined;
  const listTrusted = async () => response<RegisteredDeviceResponse[]>([
    registeredDevice,
    ...(serverPending ? [] : [{
      ...pendingDevice,
      trustState: "trusted",
      approvedByDeviceId: identity.deviceId,
      approvalSignature: serverApprovalSignature,
    }]),
  ]);
  const listPending = async () => response<RegisteredDeviceResponse[]>(serverPending ? [pendingDevice] : []);
  const approve = async (request: unknown) => {
    const keys = Object.keys(request as object).sort();
    assert.deepEqual(keys, ["approvalSignature", "approvingDeviceId", "pendingDeviceId"]);
    const dto = request as { approvingDeviceId: string; pendingDeviceId: string; approvalSignature: string };
    assert.equal(dto.approvingDeviceId, identity.deviceId);
    assert.equal(dto.pendingDeviceId, pendingDevice.deviceId);
    serverApprovalSignature = dto.approvalSignature;
    serverPending = false;
    return response({
      ...pendingDevice,
      trustState: "trusted",
      approvedByDeviceId: dto.approvingDeviceId,
      approvalSignature: dto.approvalSignature,
    });
  };

  const approverStore = makePairingTrustStore();
  const approver = makeRuntime({
    trustStore: approverStore.trustStore,
    localTrustState: "root",
    listDevices: listTrusted,
    listPendingDevices: listPending,
    signApproval: async () => "approval-signature",
    approveDevice: approve,
  });
  const pendingStore = makePairingTrustStore(pendingIdentity, pendingDevice, {
    identity: pendingIdentity,
    device: pendingDevice,
  });
  const pending = makeRuntime({
    identity: pendingIdentity,
    registeredDevice: pendingDevice,
    trustStore: pendingStore.trustStore,
    listDevices: listTrusted,
    listPendingDevices: listPending,
  });

  await approver.runtime.start();
  await pending.runtime.start();
  const approverPairing = approver.runtime.getStatus().onboarding.pairing;
  const pendingPairing = pending.runtime.getStatus().onboarding.pairing;
  assert.equal(approverPairing?.role, "approver");
  assert.equal(pendingPairing?.role, "pending");
  assert.equal(pendingPairing?.fingerprint, approverPairing?.fingerprint);
  assert.equal(pending.runtime.getStatus().signedIn, true);
  assert.equal(pending.runtime.getStatus().socket.connected, false);
  assert.equal(pending.getSocketOptions(), undefined);

  const confirmed = await pending.runtime.handleMessage(runtimeMessage({
    type: "runtime:confirm-paired-approver",
    approverDeviceId: identity.deviceId,
    confirmedFingerprint: pendingPairing!.fingerprint,
  }));
  assert.equal(confirmed.ok, true);
  assert.equal(pendingStore.records.get(`${user.id}:${identity.deviceId}`)?.trustState, "root");
  assert.equal(pendingStore.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "unverified");

  const approved = await approver.runtime.handleMessage(runtimeMessage({
    type: "runtime:approve-pending-device",
    pendingDeviceId: pendingDevice.deviceId,
    confirmedFingerprint: approverPairing!.fingerprint,
  }));
  assert.equal(approved.ok, true);
  assert.equal(approverStore.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "verified");

  const refreshed = await pending.runtime.handleMessage(runtimeMessage({ type: "runtime:refresh-onboarding" }));
  assert.equal(refreshed.ok, true);
  assert.equal(pending.runtime.getStatus().onboarding.state, "complete");
  assert.equal(pending.runtime.getStatus().device.trustState, "verified");
  assert.equal(pendingStore.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "verified");
  assert.equal(pending.runtime.getStatus().socket.connected, true);
});
