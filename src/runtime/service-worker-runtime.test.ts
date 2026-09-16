import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosResponse } from "axios";
import type { DeviceIdentity } from "../crypto/key-store.ts";
import type { RegisteredDeviceResponse } from "../crypto/device-registration.ts";
import type { ClientTrustStore, ClientVerifiedDevice, LocalDeviceRecord } from "../crypto/trust-store.ts";
import type { IUser } from "../interfaces/user.interface.ts";
import type { SignInResponse } from "../interfaces/auth.interface.ts";
import { RuntimeError } from "./errors.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import { InMemoryItemMetadataStore } from "./runtime-db.ts";
import type { RuntimeSession, SessionStore, StatusStore } from "./session-store.ts";
import {
  CopyytServiceWorkerRuntime,
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
  authId: "auth-id",
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
  on(event: string, listener: (...args: unknown[]) => void): void { this.events.set(event, listener); }
  connect(): void { this.connected = true; this.events.get("connect")?.(); }
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
  listDevices: () => Promise<AxiosResponse<unknown>>;
  listPendingDevices: () => Promise<AxiosResponse<unknown>>;
  approveDevice: (request: unknown) => Promise<AxiosResponse<unknown>>;
  signApproval: RuntimeDependencies["signApproval"];
  decrypt: RuntimeDependencies["decrypt"];
  encrypt: RuntimeDependencies["encrypt"];
  identity: DeviceIdentity;
  registeredDevice: typeof registeredDevice;
}> = {}) {
  const runtimeIdentity = overrides.identity ?? identity;
  const runtimeRegisteredDevice = overrides.registeredDevice ?? registeredDevice;
  const session: RuntimeSession = { schemaVersion: 1, accessToken: overrides.accessToken ?? "access-token", user };
  const sessionStore = new MemorySessionStore(session);
  const statusStore = new MemoryStatusStore();
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
      signInPasswordless: async () => response({ message: "ok", data: { isNew: false } }),
      googleSign: async () => { throw new Error("not used"); },
      verifyEmail: async () => { throw new Error("not used"); },
      refreshTokens: overrides.refreshTokens ?? (async () => { throw new Error("not used"); }),
      logout: async () => response(undefined),
      resendEmailOtp: async () => response(undefined),
    },
    devices: {
      registerDevice: async () => response(runtimeRegisteredDevice),
      listDevices: (overrides.listDevices ?? (async () => response([]))) as RuntimeApi["devices"]["listDevices"],
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
    identityLoader: async () => runtimeIdentity,
    identityCreator: async () => runtimeIdentity,
    registerDevice: async () => ({ identity: runtimeIdentity, device: runtimeRegisteredDevice }),
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

function makePairingTrustStore(): {
  trustStore: ClientTrustStore;
  records: Map<string, LocalDeviceRecord>;
  applied: LocalDeviceRecord["approvalCertificate"];
} {
  const records = new Map<string, LocalDeviceRecord>();
  records.set(`${user.id}:${identity.deviceId}`, {
    userId: user.id,
    deviceId: identity.deviceId,
    keyVersion: 1,
    encryptionPublicKey: registeredDevice.encryptionPublicKey,
    signingPublicKey: registeredDevice.signingPublicKey,
    trustState: "root",
    trustOrigin: "initial-tofu",
  });
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
    bootstrapInitialTrustAnchor: async () => records.get(key(identity.deviceId))! as ClientVerifiedDevice,
    pinPairedApprover: async () => { throw new Error("not used"); },
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
  const setup = makeRuntime({
    trustStore: pairing.trustStore,
    localTrustState: "root",
    listDevices: async () => response([registeredDevice, pendingDevice]),
    listPendingDevices: async () => response([pendingDevice]),
    signApproval: async () => "approval-signature",
    approveDevice: async (request) => {
      approvalRequests += 1;
      const certificate = request as { approvingDeviceId: string; approvalSignature: string };
      return response({
        ...pendingDevice,
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
  assert.equal(pairing.records.get(`${user.id}:${pendingDevice.deviceId}`)?.trustState, "verified");
  assert.equal(pairing.applied?.approvalSignature, "approval-signature");
});
