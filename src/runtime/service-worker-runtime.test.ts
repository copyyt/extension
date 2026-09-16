import assert from "node:assert/strict";
import test from "node:test";
import type { AxiosResponse } from "axios";
import type { DeviceIdentity } from "../crypto/key-store.ts";
import type { ClientTrustStore, LocalDeviceRecord } from "../crypto/trust-store.ts";
import type { IUser } from "../interfaces/user.interface.ts";
import { RuntimeError } from "./errors.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import { InMemoryItemMetadataStore } from "./runtime-db.ts";
import type { RuntimeSession, SessionStore, StatusStore } from "./session-store.ts";
import {
  CopyytServiceWorkerRuntime,
  type RuntimeApi,
  type SocketLike,
  type SocketOptions,
} from "./service-worker-runtime.ts";
import type { RuntimeStatus } from "./messages.ts";

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
  registration: { keyVersion: 1, name: "Test", platform: "chrome", capabilities: [] },
} as unknown as DeviceIdentity;
const registeredDevice = {
  deviceId: identity.deviceId,
  name: "Test",
  platform: "chrome",
  encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  signingPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  trustState: "trusted",
  keyVersion: 1,
  capabilities: [],
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
}> = {}) {
  const session: RuntimeSession = { schemaVersion: 1, accessToken: "access-token", user };
  const sessionStore = new MemorySessionStore(session);
  const statusStore = new MemoryStatusStore();
  const socket = overrides.socket ?? new FakeSocket();
  const clipboardAdapter = overrides.clipboardAdapter ?? {
    readText: async () => "secret plaintext",
    writeText: async () => undefined,
  };
  const localDevice: LocalDeviceRecord = {
    userId: user.id,
    deviceId: identity.deviceId,
    keyVersion: 1,
    encryptionPublicKey: registeredDevice.encryptionPublicKey,
    signingPublicKey: registeredDevice.signingPublicKey,
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
      refreshTokens: async () => { throw new Error("not used"); },
      logout: async () => response(undefined),
      resendEmailOtp: async () => response(undefined),
    },
    devices: {
      registerDevice: async () => response(registeredDevice),
      listDevices: async () => response([]),
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
    identityLoader: async () => identity,
    identityCreator: async () => identity,
    registerDevice: async () => ({ identity, device: registeredDevice }),
    signChallenge: async () => "signed-challenge",
    encrypt: async (input) => ({
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
    }),
    decrypt: async () => ({ plaintext: "decrypted plaintext", plaintextBytes: new Uint8Array() }),
  });
  return { runtime, socket, statusStore, trustStore, clipboardAdapter, getSocketOptions: () => socketOptions };
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
