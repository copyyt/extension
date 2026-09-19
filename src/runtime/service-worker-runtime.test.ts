import assert from "node:assert/strict";
import test from "node:test";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  sha256,
} from "../crypto/bytes.ts";
import type { AxiosResponse } from "axios";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  clipboardPayloadFromPlainText,
  clipboardPayloadFromPngBytes,
  decodeClipboardBundleV1,
  encodeClipboardBundleV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import type { DeviceIdentity } from "../crypto/key-store.ts";
import type { RegisteredDeviceResponse } from "../crypto/device-registration.ts";
import type { ClientTrustStore, ClientVerifiedDevice, LocalDeviceRecord } from "../crypto/trust-store.ts";
import type { IUser } from "../interfaces/user.interface.ts";
import type { ILoginResponse, SignInResponse } from "../interfaces/auth.interface.ts";
import { CLIPBOARD_RECEIVE_CAPABILITIES } from "../clipboard/capabilities.ts";
import { RuntimeError } from "./errors.ts";
import type { ClipboardAdapter } from "./clipboard-adapter.ts";
import type { ClipboardWatcherOptions } from "./clipboard-watcher.ts";
import type { DirectTransport } from "./direct-transport.ts";
import { createRuntimeMessageListener } from "./service-worker-bootstrap.ts";
import { createOffscreenClipboardWatcher } from "./offscreen-watcher.ts";
import {
  InMemoryAssistedPngSuppressionStore,
  InMemoryItemMetadataStore,
  InMemoryPendingAssistedImageStore,
  type AssistedPngSuppressionStore,
  type PendingAssistedImageStore,
  type ProcessedItemRecord,
  type ProcessedItemStore,
} from "./runtime-db.ts";
import type { RuntimeSession, SessionStore, StatusStore } from "./session-store.ts";
import {
  CopyytServiceWorkerRuntime,
  findUniqueAccountRootCandidate,
  type RuntimeDependencies,
  type RuntimeApi,
  type SocketLike,
  type SocketOptions,
} from "./service-worker-runtime.ts";
import type {
  PendingAssistedImageCopyResult,
  RuntimeCommand,
  RuntimeStatus,
} from "./messages.ts";
import {
  InMemorySyncPreferencesStore,
  type SyncPreferencesStore,
} from "./sync-preferences.ts";
import {
  clipboardSyncMode,
  syncPreferencesForStatus,
} from "../views/home/sync-preferences.ts";
import type { DirectSignalDelivery } from "../direct/protocol.ts";

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

class RecordingProcessedItemStore implements ProcessedItemStore {
  readonly records = new Map<string, ProcessedItemRecord>();

  async has(userId: string, itemId: string): Promise<boolean> {
    return this.records.has(`${userId}:${itemId}`);
  }

  async mark(record: Omit<ProcessedItemRecord, "key">): Promise<void> {
    this.records.set(`${record.userId}:${record.itemId}`, {
      ...record,
      key: `${record.userId}:${record.itemId}`,
    });
  }
}

class ClockedAssistedPngSuppressionStore implements AssistedPngSuppressionStore {
  readonly records = new Map<
    string,
    Parameters<AssistedPngSuppressionStore["put"]>[0]
  >();
  consumed = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  async put(
    record: Parameters<AssistedPngSuppressionStore["put"]>[0],
  ): Promise<void> {
    this.records.set(`${record.userId}:${record.itemId}`, { ...record });
  }

  async consumeNext(userId: string): Promise<boolean> {
    for (const [key, record] of this.records) {
      if (record.userId !== userId) continue;
      if (Date.parse(record.expiresAt) <= this.now()) {
        this.records.delete(key);
        continue;
      }
      this.records.delete(key);
      this.consumed += 1;
      return true;
    }
    return false;
  }

  async remove(userId: string, itemId: string): Promise<void> {
    this.records.delete(`${userId}:${itemId}`);
  }

  async clearUser(userId: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.userId === userId) this.records.delete(key);
    }
  }
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
  off(event: string, listener: (...args: unknown[]) => void): void {
    if (this.events.get(event) === listener) this.events.delete(event);
  }
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

function gatedSyncPreferencesStore(): {
  store: SyncPreferencesStore;
  setStarted: Promise<void>;
  releaseSet: () => void;
  getStored: () => Promise<{
    schemaVersion: 1;
    sendEnabled: boolean;
    receiveEnabled: boolean;
  }>;
} {
  let stored = {
    schemaVersion: 1 as const,
    sendEnabled: true,
    receiveEnabled: true,
  };
  let markStarted!: () => void;
  const setStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseSet!: () => void;
  const setGate = new Promise<void>((resolve) => {
    releaseSet = resolve;
  });
  return {
    store: {
      get: async () => ({ ...stored }),
      set: async (preferences) => {
        markStarted();
        await setGate;
        stored = { ...preferences };
      },
    },
    setStarted,
    releaseSet,
    getStored: async () => ({ ...stored }),
  };
}

function firstWriteFailsSyncPreferencesStore(): {
  store: SyncPreferencesStore;
  firstSetStarted: Promise<void>;
  releaseFirstSet: () => void;
  secondSetStarted: Promise<void>;
  getStored: () => Promise<{
    schemaVersion: 1;
    sendEnabled: boolean;
    receiveEnabled: boolean;
  }>;
} {
  let stored = {
    schemaVersion: 1 as const,
    sendEnabled: true,
    receiveEnabled: true,
  };
  let setCount = 0;
  let markFirstSetStarted!: () => void;
  const firstSetStarted = new Promise<void>((resolve) => {
    markFirstSetStarted = resolve;
  });
  let releaseFirstSet!: () => void;
  const firstSetGate = new Promise<void>((resolve) => {
    releaseFirstSet = resolve;
  });
  let markSecondSetStarted!: () => void;
  const secondSetStarted = new Promise<void>((resolve) => {
    markSecondSetStarted = resolve;
  });
  return {
    store: {
      get: async () => ({ ...stored }),
      set: async (preferences) => {
        setCount += 1;
        if (setCount === 1) {
          markFirstSetStarted();
          await firstSetGate;
          throw new Error("preference storage unavailable");
        }
        stored = { ...preferences };
        markSecondSetStarted();
      },
    },
    firstSetStarted,
    releaseFirstSet,
    secondSetStarted,
    getStored: async () => ({ ...stored }),
  };
}

function scriptedSyncPreferencesStore(
  outcomes: readonly ("succeed" | "fail")[],
): {
  store: SyncPreferencesStore;
  setStarted: (index: number) => Promise<void>;
  releaseSet: (index: number) => void;
  getStored: () => Promise<{
    schemaVersion: 1;
    sendEnabled: boolean;
    receiveEnabled: boolean;
  }>;
} {
  let stored = {
    schemaVersion: 1 as const,
    sendEnabled: true,
    receiveEnabled: true,
  };
  let setCount = 0;
  const startedResolvers: Array<() => void> = [];
  const started = outcomes.map(
    () =>
      new Promise<void>((resolve) => {
        startedResolvers.push(resolve);
      }),
  );
  const releaseResolvers: Array<() => void> = [];
  const gates = outcomes.map(
    () =>
      new Promise<void>((resolve) => {
        releaseResolvers.push(resolve);
      }),
  );

  return {
    store: {
      get: async () => ({ ...stored }),
      set: async (preferences) => {
        const index = setCount++;
        const outcome = outcomes[index];
        if (!outcome) throw new Error("unexpected preference write");
        startedResolvers[index]();
        await gates[index];
        if (outcome === "fail") {
          throw new Error("preference storage unavailable");
        }
        stored = { ...preferences };
      },
    },
    setStarted: (index) => started[index],
    releaseSet: (index) => releaseResolvers[index](),
    getStored: async () => ({ ...stored }),
  };
}

function makeRuntime(overrides: Partial<{
  trustStore: ClientTrustStore;
  clipboardAdapter: ClipboardAdapter;
  socket: FakeSocket;
  localTrustState: LocalDeviceRecord["trustState"];
  accessToken: string;
  apiFactory: (accessToken: string, api: RuntimeApi) => RuntimeApi;
  refreshTokens: (refreshToken?: string) => Promise<AxiosResponse<SignInResponse>>;
  googleSign: () => Promise<AxiosResponse<SignInResponse>>;
  verifyEmail: () => Promise<AxiosResponse<SignInResponse>>;
  signInPasswordless: () => Promise<AxiosResponse<ILoginResponse>>;
  resendEmailOtp: () => Promise<AxiosResponse<unknown>>;
  logout: (refreshToken?: string) => Promise<AxiosResponse<unknown>>;
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
  socketFactory: RuntimeDependencies["socketFactory"];
  signChallenge: RuntimeDependencies["signChallenge"];
  recoveryAlarm: RuntimeDependencies["recoveryAlarm"];
  syncPreferencesStore: SyncPreferencesStore;
  processedItemStore: RuntimeDependencies["processedItemStore"];
  outboundItemStore: RuntimeDependencies["outboundItemStore"];
  pendingAssistedImageStore: PendingAssistedImageStore;
  assistedPngSuppressionStore: AssistedPngSuppressionStore;
  directTransport: DirectTransport;
  now: () => Date;
}> = {}) {
  const runtimeIdentity = overrides.identity ?? identity;
  const runtimeRegisteredDevice = overrides.registeredDevice ?? registeredDevice;
  const initialSession: RuntimeSession | null = overrides.initialSession === undefined
    ? { schemaVersion: 1, accessToken: overrides.accessToken ?? "access-token", user }
    : overrides.initialSession;
  const sessionStore = overrides.sessionStore ?? new MemorySessionStore(initialSession);
  const statusStore = overrides.statusStore ?? new MemoryStatusStore();
  const syncPreferencesStore = overrides.syncPreferencesStore ?? new InMemorySyncPreferencesStore();
  const processedItemStore = overrides.processedItemStore ?? new InMemoryItemMetadataStore();
  const outboundItemStore = overrides.outboundItemStore ?? new InMemoryItemMetadataStore();
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
      logout: overrides.logout ?? (async () => response(undefined)),
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
    directTransport: overrides.directTransport,
    processedItemStore,
    outboundItemStore,
    pendingAssistedImageStore: overrides.pendingAssistedImageStore,
    assistedPngSuppressionStore: overrides.assistedPngSuppressionStore,
    syncPreferencesStore,
    apiFactory: overrides.apiFactory
      ? (accessToken) => overrides.apiFactory!(accessToken, api)
      : () => api,
    socketFactory: overrides.socketFactory ?? ((url: string, options: SocketOptions) => {
      void url;
      socketOptions = options;
      return socket;
    }),
    identityLoader: overrides.identityLoader ?? (async () => runtimeIdentity),
    identityCreator: overrides.identityCreator ?? (async () => runtimeIdentity),
    registerDevice: overrides.registerDevice ?? (async () => ({ identity: runtimeIdentity, device: runtimeRegisteredDevice })),
    signChallenge: overrides.signChallenge ?? (async () => "signed-challenge"),
    signApproval: overrides.signApproval,
    recoveryAlarm: overrides.recoveryAlarm,
    now: overrides.now,
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
      expiresAt: input.expiresAt,
    })),
    decrypt: overrides.decrypt ?? (async () => ({ plaintext: "decrypted plaintext", plaintextBytes: new TextEncoder().encode("decrypted plaintext") })),
  });
  return {
    runtime,
    socket,
    sessionStore,
    statusStore,
    trustStore,
    clipboardAdapter,
    syncPreferencesStore,
    processedItemStore,
    outboundItemStore,
    getSocketOptions: () => socketOptions,
  };
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

function futureExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function inboundEnvelope(
  itemId: string,
  expiresAt = futureExpiry(),
) {
  return {
    itemId,
    sourceDeviceId: identity.deviceId,
    sourceKeyVersion: 1,
    sourceSignature: "signature",
    protocolVersion: 1 as const,
    contentType: "text/plain",
    ciphertext: "ciphertext",
    nonce: "nonce",
    recipients: [
      {
        deviceId: identity.deviceId,
        deviceKeyVersion: 1,
        wrapNonce: "nonce",
        wrappedContentKey: "wrapped",
      },
    ],
    expiresAt,
  };
}

function richClipboardBundle(plainText = "\uFEFF  fallback café e\u0301 🦊\r\n\t ") {
  const html = '<div onclick="throw new Error(\'must remain data\')">HTML only<script>throw 1</script></div>';
  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: plainText },
      { mime: "text/html", encoding: "utf-8", data: html },
    ],
  };
  return { payload, plainText, html, bytes: encodeClipboardBundleV1(payload) };
}

test("registration advertises assisted PNG receive capability", async () => {
  const registrations: string[][] = [];
  const setup = await startReady({
    registerDevice: async (_api, options) => {
      registrations.push(options.capabilities ?? []);
      return { identity, device: registeredDevice };
    },
  });
  assert.deepEqual(registrations, [[
    "clipboard",
    "clipboard-bundle-v1",
    "clipboard-html-v1",
    "clipboard-image-png-assisted-write-v1",
  ]]);
  assert.equal(setup.runtime.getStatus().device.deviceId, identity.deviceId);
  assert.equal(setup.runtime.getStatus().syncReady, true);
});

test("legacy receive decodes exact UTF-8 bytes rather than a predecoded plaintext field", async () => {
  const exactText = "\uFEFF  café e\u0301 日本語 🦊\r\n\t \u0000";
  const writes: string[] = [];
  let decryptions = 0;
  const setup = await startReady({
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => {
      decryptions += 1;
      return {
        plaintext: "must not use this convenience field",
        plaintextBytes: new TextEncoder().encode(exactText),
      };
    },
  });
  const envelope = inboundEnvelope("legacy-exact-utf8");
  await setup.runtime.receiveClipboardItem(envelope);
  await setup.runtime.receiveClipboardItem(envelope);
  assert.deepEqual(writes, [exactText]);
  assert.equal(decryptions, 1);
});

test("bundle-v1 receive writes only its exact plain text fallback once", async () => {
  const bundle = richClipboardBundle();
  const writes: string[] = [];
  const processedItemStore = new RecordingProcessedItemStore();
  let decryptions = 0;
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => {
      decryptions += 1;
      return { plaintext: bundle.html, plaintextBytes: bundle.bytes };
    },
  });
  const envelope = { ...inboundEnvelope("bundle-fallback"), contentType: CLIPBOARD_BUNDLE_V1_MIME };
  await setup.runtime.receiveClipboardItem(envelope);
  await setup.runtime.receiveClipboardItem(envelope);
  assert.deepEqual(writes, [bundle.plainText]);
  assert.equal(decryptions, 1);
  assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "applied");
  assert.equal(setup.runtime.getStatus().lastSyncError, undefined);
});

test("image-only automatic observation and manual Send never encrypt or publish", async () => {
  const image = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  );
  let encryptCalls = 0;
  const setup = await startReady({
    clipboardAdapter: {
      readText: async () => "",
      readPayload: async () => image,
      writeText: async () => undefined,
    },
    encrypt: async () => {
      encryptCalls += 1;
      return inboundEnvelope("unexpected-image-publish");
    },
  });

  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: image,
  });
  assert.equal(encryptCalls, 0);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    0,
  );

  const response = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "UNSUPPORTED_CLIPBOARD_CONTENT");
  assert.equal(encryptCalls, 0);
});

test("mixed local image payloads project to exact text-only network content", async () => {
  const image = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]),
  );
  const rich = {
    version: 1 as const,
    representations: [
      { mime: "text/plain" as const, encoding: "utf-8" as const, data: "exact fallback" },
      { mime: "text/html" as const, encoding: "utf-8" as const, data: "<b>rich</b>" },
      ...image.representations,
    ],
  } satisfies ClipboardPayloadV1;
  const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
  const setup = await startReady({
    encrypt: async (input) => {
      encryptInputs.push(input);
      return {
        ...inboundEnvelope("mixed-image-publish"),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.publishClipboardPayload(rich);
  assert.equal(encryptInputs.length, 1);
  assert.equal(encryptInputs[0]!.contentType, "text/plain");
  assert.equal(encryptInputs[0]!.plaintext, "exact fallback");
  assert.equal(typeof encryptInputs[0]!.plaintext === "string" && encryptInputs[0]!.plaintext.includes(image.representations[0]!.data), false);
});

test("inbound image bundles stay out of the offscreen writer and create pending assisted state", async () => {
  const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    3,
    4,
  ]);
  const image = clipboardPayloadFromPngBytes(
    pngBytes,
  );
  const bundle = encodeClipboardBundleV1(image);
  const applied: ClipboardPayloadV1[] = [];
  const withImageAdapter = await startReady({
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      writePayload: async (payload) => { applied.push(payload); },
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
  });
  await withImageAdapter.runtime.receiveClipboardItem({
    ...inboundEnvelope("inbound-image-adapter"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  assert.deepEqual(applied, []);
  assert.equal(withImageAdapter.runtime.getStatus().pendingAssistedImages?.length, 1);

  const copyResponse = await withImageAdapter.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "inbound-image-adapter",
    }),
  );
  assert.equal(copyResponse.ok, true);
  const transportedResponse = JSON.parse(JSON.stringify(copyResponse)) as typeof copyResponse;
  const copyResult = transportedResponse.data as PendingAssistedImageCopyResult;
  assert.equal("pngBytes" in copyResult, false);
  assert.equal(typeof copyResult.pngBase64, "string");
  assert.equal(copyResult.pngBase64, bytesToBase64(pngBytes));
  assert.deepEqual(
    base64ToBytes(copyResult.pngBase64),
    pngBytes,
  );
  assert.equal(
    JSON.stringify(withImageAdapter.runtime.getStatus()).includes(
      copyResult.pngBase64,
    ),
    false,
  );
  assert.equal(
    JSON.stringify(await withImageAdapter.statusStore.get()).includes(
      copyResult.pngBase64,
    ),
    false,
  );
  await withImageAdapter.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: image,
  });
  // The assisted write is consumed by the durable suppression record, not
  // republished as a new clipboard event.
  assert.equal(withImageAdapter.runtime.getStatus().pendingAssistedImages?.length, 1);
  await withImageAdapter.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "inbound-image-adapter",
    }),
  );
  assert.equal(withImageAdapter.runtime.getStatus().pendingAssistedImages?.length, 0);

  const textWrites: string[] = [];
  const withoutImageAdapter = await startReady({
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async (text) => { textWrites.push(text); },
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
  });
  await withoutImageAdapter.runtime.receiveClipboardItem({
    ...inboundEnvelope("inbound-image-no-adapter"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  assert.deepEqual(textWrites, []);
  assert.equal(withoutImageAdapter.runtime.getStatus().pendingAssistedImages?.length, 1);
  assert.equal(withoutImageAdapter.runtime.getStatus().lastSyncError, undefined);
});

test("normalized PNG observations use the assisted guard, not source-byte equality", async () => {
  const sourceBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x21,
  ]);
  const normalizedBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x22,
  ]);
  const genuineBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x23,
  ]);
  assert.notEqual(
    bytesToHex(await sha256(sourceBytes)),
    bytesToHex(await sha256(normalizedBytes)),
  );

  const sourceImage = clipboardPayloadFromPngBytes(sourceBytes);
  const normalizedImage = clipboardPayloadFromPngBytes(normalizedBytes);
  const genuineImage = clipboardPayloadFromPngBytes(genuineBytes);
  const bundle = encodeClipboardBundleV1(sourceImage);
  const capableDevice = {
    ...registeredDevice,
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
  };
  const pairing = makePairingTrustStore(identity, capableDevice);
  const suppressionStore = new InMemoryAssistedPngSuppressionStore();
  let encryptCalls = 0;
  let rebaselineCalls = 0;
  const setup = await startReady({
    localTrustState: "root",
    registeredDevice: capableDevice,
    trustStore: pairing.trustStore,
    assistedPngSuppressionStore: suppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      rebaselineFromClipboard: async () => {
        rebaselineCalls += 1;
        throw new Error("simulated actual-clipboard read failure");
      },
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
    encrypt: async (input) => {
      encryptCalls += 1;
      return {
        ...inboundEnvelope(`genuine-normalized-test-${encryptCalls}`),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("normalized-png-item"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  const copied = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "normalized-png-item",
    }),
  );
  assert.equal(copied.ok, true);

  const completed = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "normalized-png-item",
    }),
  );
  assert.equal(completed.ok, true);
  assert.equal(rebaselineCalls, 1);
  assert.deepEqual(setup.runtime.getStatus().pendingAssistedImages, []);

  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: normalizedImage,
  });
  assert.equal(encryptCalls, 0);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    0,
  );
  assert.equal(await suppressionStore.consumeNext(user.id), false);

  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: genuineImage,
  });
  assert.equal(encryptCalls, 1);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    1,
  );
});

test("a PNG observation racing before re-baseline consumes the durable guard", async () => {
  const sourceImage = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x31]),
  );
  const normalizedImage = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x32]),
  );
  const capableDevice = {
    ...registeredDevice,
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
  };
  const pairing = makePairingTrustStore(identity, capableDevice);
  const suppressionStore = new InMemoryAssistedPngSuppressionStore();
  let encryptCalls = 0;
  const setup = await startReady({
    localTrustState: "root",
    registeredDevice: capableDevice,
    trustStore: pairing.trustStore,
    assistedPngSuppressionStore: suppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      rebaselineFromClipboard: async () => undefined,
    },
    decrypt: async () => ({ plaintextBytes: encodeClipboardBundleV1(sourceImage) }),
    encrypt: async () => {
      encryptCalls += 1;
      throw new Error("the racing assisted PNG must be suppressed");
    },
  });
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("racing-normalized-png"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  const copied = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "racing-normalized-png",
    }),
  );
  assert.equal(copied.ok, true);

  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: normalizedImage,
  });
  assert.equal(encryptCalls, 0);
  assert.equal(await suppressionStore.consumeNext(user.id), false);

  const completed = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "racing-normalized-png",
    }),
  );
  assert.equal(completed.ok, true);
});

test("successful re-baseline makes the watcher ignore the normalized PNG", async () => {
  const sourceImage = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]),
  );
  const normalizedImage = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]),
  );
  const suppressionStore = new InMemoryAssistedPngSuppressionStore();
  let clipboard = sourceImage;
  const watcherRef: {
    current?: ReturnType<typeof createOffscreenClipboardWatcher>;
  } = {};
  const callbacks = new Map<number, () => void>();
  let nextTimerId = 1;
  let encryptCalls = 0;
  const setup = await startReady({
    assistedPngSuppressionStore: suppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      rebaselineFromClipboard: async () => {
        watcherRef.current?.noteExternalWrite(clipboard);
      },
    },
    decrypt: async () => ({ plaintextBytes: encodeClipboardBundleV1(sourceImage) }),
    encrypt: async () => {
      encryptCalls += 1;
      throw new Error("the re-baselined PNG must not publish");
    },
  });
  const watcher = createOffscreenClipboardWatcher({
    readPayload: () => clipboard,
    runtime: {
      sendMessage: (message) => setup.runtime.handleClipboardObservation(message),
    },
    setIntervalFn: (handler) => {
      const id = nextTimerId++;
      callbacks.set(id, handler);
      return id as unknown as ReturnType<typeof globalThis.setInterval>;
    },
    clearIntervalFn: (handle) => {
      callbacks.delete(handle as unknown as number);
    },
  });
  watcherRef.current = watcher;
  watcher.start();
  await flushRuntimeWork();

  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("successful-png-rebaseline"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  const copied = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "successful-png-rebaseline",
    }),
  );
  assert.equal(copied.ok, true);

  clipboard = normalizedImage;
  const completed = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "successful-png-rebaseline",
    }),
  );
  assert.equal(completed.ok, true);
  assert.equal(await suppressionStore.consumeNext(user.id), false);

  for (const callback of [...callbacks.values()]) callback();
  await flushRuntimeWork();
  assert.equal(encryptCalls, 0);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    0,
  );
  watcher.stop();
});

test("assisted PNG suppression survives live envelope expiry until the watcher interval", async () => {
  const baseTime = Date.now();
  let nowMs = baseTime;
  const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    7,
  ]);
  const image = clipboardPayloadFromPngBytes(pngBytes);
  const bundle = encodeClipboardBundleV1(image);
  const pendingAssistedImageStore = new InMemoryPendingAssistedImageStore();
  const assistedPngSuppressionStore = new ClockedAssistedPngSuppressionStore(
    () => nowMs,
  );
  let encryptCalls = 0;
  const setup = await startReady({
    now: () => new Date(nowMs),
    pendingAssistedImageStore,
    assistedPngSuppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
    encrypt: async () => {
      encryptCalls += 1;
      throw new Error("the assisted PNG observation must be suppressed");
    },
  });
  const envelopeExpiry = new Date(baseTime + 400).toISOString();
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("assisted-expiry-race", envelopeExpiry),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });

  const copied = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "assisted-expiry-race",
    }),
  );
  assert.equal(copied.ok, true);
  const suppression = assistedPngSuppressionStore.records.get(
    `${user.id}:assisted-expiry-race`,
  );
  assert.ok(suppression);
  assert.equal(Date.parse(suppression.expiresAt), baseTime + 15_000);
  assert.ok(Date.parse(suppression.expiresAt) > Date.parse(envelopeExpiry));

  await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "assisted-expiry-race",
    }),
  );
  assert.deepEqual(setup.runtime.getStatus().pendingAssistedImages, []);

  let clipboard: ClipboardPayloadV1 = clipboardPayloadFromPlainText("baseline");
  const callbacks = new Map<number, () => void>();
  let nextTimerId = 1;
  const watcher = createOffscreenClipboardWatcher({
    readPayload: () => clipboard,
    runtime: {
      sendMessage: (message) => setup.runtime.handleClipboardObservation(message),
    },
    intervalMs: 800,
    setIntervalFn: (handler, intervalMs) => {
      assert.equal(intervalMs, 800);
      const id = nextTimerId++;
      callbacks.set(id, handler);
      return id as unknown as ReturnType<typeof globalThis.setInterval>;
    },
    clearIntervalFn: (handle) => {
      callbacks.delete(handle as unknown as number);
    },
  });
  watcher.start();
  await flushRuntimeWork();

  // The normal watcher interval observes the image after its 400 ms live
  // envelope has expired, but well before the 15-second suppression expiry.
  nowMs = baseTime + 800;
  clipboard = image;
  for (const callback of [...callbacks.values()]) callback();
  await waitForRuntimeCondition(
    () => assistedPngSuppressionStore.consumed === 1,
    "the assisted PNG suppression was not consumed",
  );
  watcher.stop();

  assert.equal(encryptCalls, 0);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    0,
  );
  assert.equal(assistedPngSuppressionStore.records.size, 0);
  assert.deepEqual(setup.runtime.getStatus().pendingAssistedImages, []);
  assert.equal(setup.runtime.getStatus().connectionState, "ready");
  assert.equal(setup.runtime.getStatus().lastSyncError, undefined);
});

test("assisted completion leaves durable suppression for the real clipboard event order", async () => {
  const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    4,
  ]);
  const image = clipboardPayloadFromPngBytes(pngBytes);
  const bundle = encodeClipboardBundleV1(image);
  const pendingAssistedImageStore = new InMemoryPendingAssistedImageStore();
  const assistedPngSuppressionStore = new InMemoryAssistedPngSuppressionStore();
  let encryptCalls = 0;
  const setup = await startReady({
    pendingAssistedImageStore,
    assistedPngSuppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
    encrypt: async () => {
      encryptCalls += 1;
      throw new Error("suppressed observations must not encrypt");
    },
  });
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("assisted-order-item"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });

  const copyResponse = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:copy-pending-image",
      itemId: "assisted-order-item",
    }),
  );
  assert.equal(copyResponse.ok, true);

  // The focused page has now successfully written the decoded PNG, so the
  // popup immediately completes the pending UI action before the next poll.
  const completeResponse = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "assisted-order-item",
    }),
  );
  assert.equal(completeResponse.ok, true);
  assert.deepEqual(setup.runtime.getStatus().pendingAssistedImages, []);

  // Reconstruct the worker before the offscreen event. The suppression record
  // is shared durable metadata, while the pending UI state is already gone.
  const recreatedSocket = new FakeSocket();
  const recreated = await startReady({
    sessionStore: setup.sessionStore,
    pendingAssistedImageStore,
    assistedPngSuppressionStore,
    socket: recreatedSocket,
    trustStore: setup.trustStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
    },
    encrypt: async () => {
      encryptCalls += 1;
      throw new Error("suppressed observations must not encrypt");
    },
  });
  await recreated.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: image,
  });

  assert.equal(encryptCalls, 0);
  assert.equal(
    recreatedSocket.emissions.filter(
      (emission) => emission.event === "clipboard:publish",
    ).length,
    0,
  );
  assert.deepEqual(recreated.runtime.getStatus().pendingAssistedImages, []);
  assert.equal(
    await assistedPngSuppressionStore.consumeNext(user.id),
    false,
  );
});

test("failed focused write release removes suppression and allows a genuine same-PNG copy", async () => {
  const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    5,
  ]);
  const image = clipboardPayloadFromPngBytes(pngBytes);
  const bundle = encodeClipboardBundleV1(image);
  const capableDevice = {
    ...registeredDevice,
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
  };
  const pairing = makePairingTrustStore(identity, capableDevice);
  const pendingAssistedImageStore = new InMemoryPendingAssistedImageStore();
  const assistedPngSuppressionStore = new InMemoryAssistedPngSuppressionStore();
  let encryptCalls = 0;
  const setup = await startReady({
    localTrustState: "root",
    registeredDevice: capableDevice,
    trustStore: pairing.trustStore,
    pendingAssistedImageStore,
    assistedPngSuppressionStore,
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
    },
    decrypt: async () => ({ plaintextBytes: bundle }),
    encrypt: async (input) => {
      encryptCalls += 1;
      return {
        ...inboundEnvelope(`genuine-image-${encryptCalls}`),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("release-item"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  const copied = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:copy-pending-image", itemId: "release-item" }),
  );
  assert.equal(copied.ok, true);

  // This is the popup's failure path after the focused ClipboardItem write
  // rejects: release clears suppression, while the pending item remains.
  const released = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:release-pending-image", itemId: "release-item" }),
  );
  assert.equal(released.ok, true);
  assert.equal(setup.runtime.getStatus().pendingAssistedImages?.length, 1);

  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: image,
  });
  assert.equal(encryptCalls, 1);
  assert.equal(
    setup.socket.emissions.filter(
      (emission) => emission.event === "clipboard:publish",
    ).length,
    1,
  );
});

test("expired assisted PNG suppression does not block a genuine later copy", async () => {
  const baseTime = Date.now();
  let nowMs = baseTime;
  const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    6,
  ]);
  const image = clipboardPayloadFromPngBytes(pngBytes);
  const bundle = encodeClipboardBundleV1(image);
  const capableDevice = {
    ...registeredDevice,
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
  };
  const pairing = makePairingTrustStore(identity, capableDevice);
  const pendingAssistedImageStore = new InMemoryPendingAssistedImageStore();
  const assistedPngSuppressionStore = new ClockedAssistedPngSuppressionStore(
    () => nowMs,
  );
  let encryptCalls = 0;
  const setup = await startReady({
    now: () => new Date(nowMs),
    localTrustState: "root",
    registeredDevice: capableDevice,
    trustStore: pairing.trustStore,
    pendingAssistedImageStore,
    assistedPngSuppressionStore,
    decrypt: async () => ({ plaintextBytes: bundle }),
    encrypt: async (input) => {
      encryptCalls += 1;
      return {
        ...inboundEnvelope(`expired-image-${encryptCalls}`),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.receiveClipboardItem({
    ...inboundEnvelope("expired-item"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  });
  const copied = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:copy-pending-image", itemId: "expired-item" }),
  );
  assert.equal(copied.ok, true);
  const suppression = assistedPngSuppressionStore.records.get(
    `${user.id}:expired-item`,
  );
  assert.ok(suppression);
  await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:complete-pending-image",
      itemId: "expired-item",
    }),
  );
  nowMs = Date.parse(suppression.expiresAt) + 1;
  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: image,
  });
  assert.equal(assistedPngSuppressionStore.consumed, 0);
  assert.equal(assistedPngSuppressionStore.records.size, 0);
  assert.equal(encryptCalls, 1);
  assert.equal(
    setup.socket.emissions.filter(
      (emission) => emission.event === "clipboard:publish",
    ).length,
    1,
  );
});

test("unknown content types are consumed after crypto verification without decoding or retrying", async () => {
  for (const contentType of ["application/x-copyyt-future", "text/html", "text/plain;charset=utf-8"]) {
    const processedItemStore = new RecordingProcessedItemStore();
    const writes: string[] = [];
    let decryptions = 0;
    const setup = await startReady({
      processedItemStore,
      clipboardAdapter: {
        readText: async () => "",
        writeText: async (text) => { writes.push(text); },
      },
      decrypt: async () => {
        decryptions += 1;
        return { plaintextBytes: new Uint8Array([0xff]) };
      },
    });
    const envelope = { ...inboundEnvelope(`unsupported-${contentType}`), contentType };
    await setup.runtime.receiveClipboardItem(envelope);
    await setup.runtime.receiveClipboardItem(envelope);
    assert.deepEqual(writes, []);
    assert.equal(decryptions, 1);
    assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "unsupported-content");
    assert.equal(setup.runtime.getStatus().lastSyncError, undefined);
    assert.equal(setup.runtime.getStatus().syncReady, true);
  }
});

test("invalid UTF-8 and malformed bundles are consumed as invalid content rather than crypto failure", async () => {
  const malformedItems = [
    { contentType: "text/plain", plaintextBytes: new Uint8Array([0xc3, 0x28]) },
    { contentType: CLIPBOARD_BUNDLE_V1_MIME, plaintextBytes: new Uint8Array([0xff]) },
    { contentType: CLIPBOARD_BUNDLE_V1_MIME, plaintextBytes: new TextEncoder().encode("{not JSON") },
    {
      contentType: CLIPBOARD_BUNDLE_V1_MIME,
      plaintextBytes: new TextEncoder().encode(JSON.stringify({
        version: 1,
        representations: [{ mime: "text/html", encoding: "utf-8", data: "<b>no fallback</b>" }],
      })),
    },
  ];
  for (const [index, item] of malformedItems.entries()) {
    const processedItemStore = new RecordingProcessedItemStore();
    const writes: string[] = [];
    let decryptions = 0;
    const setup = await startReady({
      processedItemStore,
      clipboardAdapter: {
        readText: async () => "",
        writeText: async (text) => { writes.push(text); },
      },
      decrypt: async () => {
        decryptions += 1;
        return { plaintext: "never write this", plaintextBytes: item.plaintextBytes };
      },
    });
    const envelope = { ...inboundEnvelope(`invalid-content-${index}`), contentType: item.contentType };
    await setup.runtime.receiveClipboardItem(envelope);
    await setup.runtime.receiveClipboardItem(envelope);
    assert.deepEqual(writes, []);
    assert.equal(decryptions, 1);
    assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "invalid-content");
    assert.equal(setup.runtime.getStatus().lastSyncError?.code, "INVALID_CLIPBOARD_CONTENT");
    assert.equal(setup.runtime.getStatus().syncReady, true);
    assert.equal(JSON.stringify(setup.runtime.getStatus()).includes("never write this"), false);
  }
});

test("stale bundles are consumed before decrypt and without content diagnostics", async () => {
  const processedItemStore = new RecordingProcessedItemStore();
  let decryptions = 0;
  const writes: string[] = [];
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => {
      decryptions += 1;
      throw new Error("stale bundles must not decrypt");
    },
  });
  const envelope = {
    ...inboundEnvelope("stale-bundle", new Date(Date.now() - 1).toISOString()),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  };
  await setup.runtime.receiveClipboardItem(envelope);
  assert.equal(decryptions, 0);
  assert.deepEqual(writes, []);
  assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "stale");
  assert.equal(setup.runtime.getStatus().lastSyncError, undefined);
});

test("bundle self-echo is verified and consumed without clipboard write", async () => {
  const bundle = richClipboardBundle();
  const processedItemStore = new RecordingProcessedItemStore();
  const writes: string[] = [];
  let decryptions = 0;
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => {
      decryptions += 1;
      return { plaintextBytes: bundle.bytes };
    },
  });
  const envelope = { ...inboundEnvelope("bundle-self-echo"), contentType: CLIPBOARD_BUNDLE_V1_MIME };
  await setup.outboundItemStore.mark({
    userId: user.id,
    itemId: envelope.itemId,
    publishedAt: new Date().toISOString(),
    sourceDeviceId: identity.deviceId,
  });
  await setup.runtime.receiveClipboardItem(envelope);
  assert.equal(decryptions, 1);
  assert.deepEqual(writes, []);
  assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "self-echo");
});

test("Receive Off consumes a bundle before decrypt and blocks replay after re-enable", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  await syncPreferencesStore.set({ schemaVersion: 1, sendEnabled: true, receiveEnabled: false });
  const processedItemStore = new RecordingProcessedItemStore();
  const writes: string[] = [];
  let decryptions = 0;
  const setup = await startReady({
    syncPreferencesStore,
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => {
      decryptions += 1;
      return { plaintextBytes: richClipboardBundle().bytes };
    },
  });
  const envelope = { ...inboundEnvelope("disabled-bundle"), contentType: CLIPBOARD_BUNDLE_V1_MIME };
  await setup.runtime.receiveClipboardItem(envelope);
  await setup.runtime.handleMessage(runtimeMessage({
    type: "runtime:set-sync-preferences", sendEnabled: true, receiveEnabled: true,
  }));
  await setup.runtime.receiveClipboardItem(envelope);
  assert.equal(decryptions, 0);
  assert.deepEqual(writes, []);
  assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "receive-disabled");
});

test("Receive Off during bundle decryption blocks writes even after immediate re-enable", async () => {
  for (const reenableBeforeDecrypt of [false, true]) {
    let beginDecryption!: () => void;
    const decryptionStarted = new Promise<void>((resolve) => { beginDecryption = resolve; });
    let releaseDecryption!: () => void;
    const decryptionGate = new Promise<void>((resolve) => { releaseDecryption = resolve; });
    const processedItemStore = new RecordingProcessedItemStore();
    const writes: string[] = [];
    let decryptions = 0;
    const setup = await startReady({
      processedItemStore,
      clipboardAdapter: {
        readText: async () => "",
        writeText: async (text) => { writes.push(text); },
      },
      decrypt: async () => {
        decryptions += 1;
        beginDecryption();
        await decryptionGate;
        return { plaintextBytes: richClipboardBundle().bytes };
      },
    });
    const envelope = { ...inboundEnvelope(`in-flight-bundle-${reenableBeforeDecrypt}`), contentType: CLIPBOARD_BUNDLE_V1_MIME };
    const receive = setup.runtime.receiveClipboardItem(envelope);
    await decryptionStarted;
    assert.equal((await setup.runtime.handleMessage(runtimeMessage({
      type: "runtime:set-sync-preferences", sendEnabled: true, receiveEnabled: false,
    }))).ok, true);
    if (reenableBeforeDecrypt) {
      await setup.runtime.handleMessage(runtimeMessage({
        type: "runtime:set-sync-preferences", sendEnabled: true, receiveEnabled: true,
      }));
    }
    releaseDecryption();
    await receive;
    await setup.runtime.handleMessage(runtimeMessage({
      type: "runtime:set-sync-preferences", sendEnabled: true, receiveEnabled: true,
    }));
    await setup.runtime.receiveClipboardItem(envelope);
    assert.deepEqual(writes, []);
    assert.equal(decryptions, 1);
    assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "receive-disabled");
  }
});

test("Receive policy is rechecked after bundle decoding immediately before OS write", async () => {
  const bytes = richClipboardBundle().bytes;
  const processedItemStore = new RecordingProcessedItemStore();
  const writes: string[] = [];
  let disableResult: ReturnType<CopyytServiceWorkerRuntime["handleMessage"]> | undefined;
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async (text) => { writes.push(text); },
    },
    decrypt: async () => ({
      // Force a policy change as decoding reads the decrypted bytes, after the
      // post-decrypt guard, to exercise the final guard independently.
      get plaintextBytes() {
        disableReceive();
        return bytes;
      },
    }),
  });
  const disableReceive = () => {
    disableResult = setup.runtime.handleMessage(runtimeMessage({
      type: "runtime:set-sync-preferences", sendEnabled: true, receiveEnabled: false,
    }));
  };
  const envelope = { ...inboundEnvelope("bundle-decode-policy-boundary"), contentType: CLIPBOARD_BUNDLE_V1_MIME };
  await setup.runtime.receiveClipboardItem(envelope);
  assert.ok(disableResult);
  assert.equal((await disableResult).ok, true);
  assert.deepEqual(writes, []);
  assert.equal(processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition, "receive-disabled");
});

const flushRuntimeWork = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

async function waitForRuntimeCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await flushRuntimeWork();
  }
  throw new Error(message);
}

test("sync preferences default to Both and survive worker recreation", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  const first = makeRuntime({
    localTrustState: "verified",
    syncPreferencesStore,
  });
  await first.runtime.start();
  assert.deepEqual(first.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });

  const update = await first.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: false,
    }),
  );
  assert.equal(update.ok, true);
  assert.deepEqual(await syncPreferencesStore.get(), {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: false,
  });

  const recreated = makeRuntime({
    localTrustState: "verified",
    syncPreferencesStore,
    sessionStore: first.sessionStore,
    trustStore: first.trustStore,
  });
  await recreated.runtime.start();
  assert.deepEqual(recreated.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: false,
  });
});

test("all four sync preference modes persist exact send and receive behavior", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  const setup = makeRuntime({ syncPreferencesStore });
  await setup.runtime.start();
  const modes = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const;
  for (const [sendEnabled, receiveEnabled] of modes) {
    const result = await setup.runtime.handleMessage(
      runtimeMessage({
        type: "runtime:set-sync-preferences",
        sendEnabled,
        receiveEnabled,
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
      schemaVersion: 1,
      sendEnabled,
      receiveEnabled,
    });
    assert.deepEqual(await syncPreferencesStore.get(), {
      schemaVersion: 1,
      sendEnabled,
      receiveEnabled,
    });
  }
});

test("malformed preference commands fail closed", async () => {
  const setup = makeRuntime();
  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: "yes",
      receiveEnabled: true,
    } as unknown as RuntimeCommand),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SYNC_PREFERENCES_INVALID");
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });
});

test("Send disable becomes a barrier before its storage write completes", async () => {
  const preferences = gatedSyncPreferencesStore();
  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  const setup = await startReady({
    syncPreferencesStore: preferences.store,
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "pending-storage-send-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  const publish = setup.runtime.publishClipboardText("old clipboard value");
  await encryptionStarted;
  const disabling = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  await preferences.setStarted;
  assert.equal(setup.runtime.getStatus().syncPreferences.sendEnabled, false);

  releaseEncryption();
  await assert.rejects(
    publish,
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CLIPBOARD_SEND_DISABLED",
  );
  assert.equal(
    setup.socket.emissions.some((item) => item.event === "clipboard:publish"),
    false,
  );
  preferences.releaseSet();
  assert.equal((await disabling).ok, true);
  assert.equal((await preferences.getStored()).sendEnabled, false);
});

test("failed Off transition restores Both, rebaselines the watcher, and drops old observations", async () => {
  const preferences = firstWriteFailsSyncPreferencesStore();
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore: preferences.store,
    clipboardAdapter: {
      readText: async () => "old clipboard value",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "failed-off-observation",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  await flushRuntimeWork();
  const startsBeforeTransition = watchCalls.filter((call) => call.type === "start").length;

  const oldObservation = setup.runtime.handleClipboardObservation(
    clipboardObservation("old clipboard value"),
  );
  await encryptionStarted;
  const queuedOldObservation = setup.runtime.handleClipboardObservation(
    clipboardObservation("queued old clipboard value"),
  );
  await flushRuntimeWork();

  const disabling = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: false,
    }),
  );
  await preferences.firstSetStarted;
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: false,
  });

  preferences.releaseFirstSet();
  const result = await disabling;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SYNC_PREFERENCES_INVALID");
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });

  releaseEncryption();
  await Promise.all([oldObservation, queuedOldObservation]);
  await flushRuntimeWork();
  assert.equal(
    setup.socket.emissions.some((item) => item.event === "clipboard:publish"),
    false,
  );
  assert.ok(watchCalls.filter((call) => call.type === "start").length > startsBeforeTransition);
  assert.deepEqual(watchCalls[watchCalls.length - 1], {
    type: "start",
    resetBaseline: true,
  });
});

test("a failed older preference write cannot roll back a newer Receive-only transition", async () => {
  const preferences = firstWriteFailsSyncPreferencesStore();
  const setup = await startReady({
    syncPreferencesStore: preferences.store,
  });

  const first = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: false,
    }),
  );
  await preferences.firstSetStarted;

  const second = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });

  preferences.releaseFirstSet();
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.error?.code, "SYNC_PREFERENCES_INVALID");
  await preferences.secondSetStarted;
  const secondResult = await second;
  assert.equal(secondResult.ok, true);
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
  assert.deepEqual(await preferences.getStored(), {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
});

test("failed preference writes roll back to durable Both after superseded writes fail", async () => {
  const preferences = scriptedSyncPreferencesStore(["fail", "fail"]);
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore: preferences.store,
    clipboardAdapter: {
      readText: async () => "old clipboard value",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "durable-rollback-observation",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  await flushRuntimeWork();
  const startsBeforeTransition = watchCalls.filter((call) => call.type === "start").length;

  const oldObservation = setup.runtime.handleClipboardObservation(
    clipboardObservation("old clipboard value"),
  );
  await encryptionStarted;

  const off = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: false,
    }),
  );
  await preferences.setStarted(0);
  const receiveOnly = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });

  preferences.releaseSet(0);
  const offResult = await off;
  assert.equal(offResult.ok, false);
  await preferences.setStarted(1);
  preferences.releaseSet(1);
  const receiveOnlyResult = await receiveOnly;
  assert.equal(receiveOnlyResult.ok, false);

  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });
  assert.deepEqual(await preferences.getStored(), {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });

  releaseEncryption();
  await oldObservation;
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(
    setup.socket.emissions.some((item) => item.event === "clipboard:publish"),
    false,
  );
  assert.ok(watchCalls.filter((call) => call.type === "start").length > startsBeforeTransition);
  assert.deepEqual(watchCalls[watchCalls.length - 1], {
    type: "start",
    resetBaseline: true,
  });
});

test("newest preference write failure rolls back to the last durable Off mode", async () => {
  const preferences = scriptedSyncPreferencesStore(["succeed", "fail"]);
  const setup = await startReady({ syncPreferencesStore: preferences.store });

  const off = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: false,
    }),
  );
  await preferences.setStarted(0);
  preferences.releaseSet(0);
  assert.equal((await off).ok, true);
  assert.deepEqual(await preferences.getStored(), {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: false,
  });

  const receiveOnly = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  await preferences.setStarted(1);
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
  preferences.releaseSet(1);

  const result = await receiveOnly;
  assert.equal(result.ok, false);
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: false,
  });
  assert.deepEqual(await preferences.getStored(), {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: false,
  });
});

test("failed Off rollback keeps Send and Receive operations invalidated", async () => {
  const preferences = firstWriteFailsSyncPreferencesStore();
  const processedItemStore = new RecordingProcessedItemStore();
  let markProcessedHasStarted!: () => void;
  const processedHasStarted = new Promise<void>((resolve) => {
    markProcessedHasStarted = resolve;
  });
  let releaseProcessedHas!: () => void;
  const processedHasGate = new Promise<void>((resolve) => {
    releaseProcessedHas = resolve;
  });
  const originalHas = processedItemStore.has.bind(processedItemStore);
  processedItemStore.has = async (userId, itemId) => {
    markProcessedHasStarted();
    await processedHasGate;
    return originalHas(userId, itemId);
  };

  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  let writes = 0;
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore: preferences.store,
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "failed-off-send",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  const send = setup.runtime.publishClipboardText("pre-Off send");
  await encryptionStarted;
  const disabling = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: false,
    }),
  );
  await preferences.firstSetStarted;

  const envelope = inboundEnvelope("failed-off-receive");
  const receive = setup.runtime.receiveClipboardItem(envelope);
  await processedHasStarted;

  preferences.releaseFirstSet();
  const disablingResult = await disabling;
  assert.equal(disablingResult.ok, false);
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });

  releaseEncryption();
  releaseProcessedHas();
  await assert.rejects(
    send,
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CLIPBOARD_SEND_DISABLED",
  );
  await receive;
  assert.equal(writes, 0);
  assert.equal(
    processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition,
    "receive-disabled",
  );
  assert.equal(
    setup.socket.emissions.some((item) => item.event === "clipboard:publish"),
    false,
  );
});

test("popup status fallback treats a legacy status without syncPreferences as Both", () => {
  const legacyStatus = {} as { syncPreferences?: RuntimeStatus["syncPreferences"] };
  const preferences = syncPreferencesForStatus(legacyStatus);

  assert.deepEqual(preferences, {
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: true,
  });
  assert.equal(clipboardSyncMode(preferences), "both");
});

test("an in-flight publish is canceled after Send is disabled before emission", async () => {
  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  const setup = await startReady({
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "send-boundary-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  const publish = setup.runtime.publishClipboardText("old clipboard value");
  await encryptionStarted;
  const disabled = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  assert.equal(disabled.ok, true);
  releaseEncryption();

  await assert.rejects(
    publish,
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CLIPBOARD_SEND_DISABLED",
  );
  assert.equal(
    setup.socket.emissions.filter((item) => item.event === "clipboard:publish").length,
    0,
  );
  assert.equal(
    await setup.outboundItemStore.has(user.id, "send-boundary-item"),
    false,
  );
});

test("an in-flight publish is not revived by Both after Send briefly turns Off", async () => {
  let releaseEncryption!: () => void;
  let markEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => {
    markEncryptionStarted = resolve;
  });
  const encryptionGate = new Promise<void>((resolve) => {
    releaseEncryption = resolve;
  });
  const setup = await startReady({
    encrypt: async (input) => {
      markEncryptionStarted();
      await encryptionGate;
      return {
        itemId: "send-revision-boundary-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  const publish = setup.runtime.publishClipboardText("pre-Off clipboard value");
  await encryptionStarted;
  for (const preferences of [
    { sendEnabled: false, receiveEnabled: false },
    { sendEnabled: true, receiveEnabled: true },
  ] as const) {
    const result = await setup.runtime.handleMessage(
      runtimeMessage({ type: "runtime:set-sync-preferences", ...preferences }),
    );
    assert.equal(result.ok, true);
  }
  releaseEncryption();

  await assert.rejects(
    publish,
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CLIPBOARD_SEND_DISABLED",
  );
  assert.equal(
    setup.socket.emissions.filter((item) => item.event === "clipboard:publish").length,
    0,
  );
  assert.equal(
    await setup.outboundItemStore.has(user.id, "send-revision-boundary-item"),
    false,
  );
});

test("send disabled stops the watcher, drops pending auto work, and rejects manual Send", async () => {
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let releasePublish!: () => void;
  const publishGate = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  const encryptedTexts: string[] = [];
  const setup = await startReady({
    localTrustState: "verified",
    clipboardAdapter: {
      readText: async () => "manual",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      if (encryptedTexts.length === 1) await publishGate;
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
        expiresAt: input.expiresAt,
      };
    },
  });
  await flushRuntimeWork();

  const first = setup.runtime.handleClipboardObservation(
    clipboardObservation("first"),
  );
  await flushRuntimeWork();
  const pending = setup.runtime.handleClipboardObservation(
    clipboardObservation("pending"),
  );
  await flushRuntimeWork();
  const disabled = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  assert.equal(disabled.ok, true);
  releasePublish();
  await Promise.all([first, pending]);
  await flushRuntimeWork();
  assert.deepEqual(encryptedTexts, ["first"]);
  assert.ok(watchCalls.some((call) => call.type === "stop"));

  let reads = 0;
  const manualSetup = makeRuntime({
    localTrustState: "verified",
    syncPreferencesStore: setup.syncPreferencesStore,
    clipboardAdapter: {
      readText: async () => {
        reads += 1;
        return "should not be read";
      },
      writeText: async () => undefined,
    },
  });
  await manualSetup.runtime.start();
  const result = await manualSetup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "CLIPBOARD_SEND_DISABLED");
  assert.equal(reads, 0);
});

test("enabling send always rebaselines without publishing the existing clipboard", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  await syncPreferencesStore.set({
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let encryptions = 0;
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore,
    clipboardAdapter: {
      readText: async () => "already on clipboard",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      encryptions += 1;
      return {
        itemId: `${encryptions}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  await flushRuntimeWork();
  assert.equal(watchCalls.some((call) => call.type === "start"), false);

  const enabled = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: true,
    }),
  );
  assert.equal(enabled.ok, true);
  await flushRuntimeWork();
  assert.deepEqual(watchCalls[watchCalls.length - 1], {
    type: "start",
    resetBaseline: true,
  });
  assert.equal(encryptions, 0);
});

test("receive disabled consumes an item without decrypting and never replays it", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  await syncPreferencesStore.set({
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: false,
  });
  let writes = 0;
  let decryptions = 0;
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    decrypt: async () => {
      decryptions += 1;
      return { plaintext: "secret", plaintextBytes: new TextEncoder().encode("secret") };
    },
  });
  const envelope = inboundEnvelope("receive-disabled-item");
  await setup.runtime.receiveClipboardItem(envelope);
  assert.equal(writes, 0);
  assert.equal(decryptions, 0);
  assert.equal(
    await setup.processedItemStore.has(user.id, envelope.itemId),
    true,
  );

  await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: true,
    }),
  );
  await setup.runtime.receiveClipboardItem(envelope);
  assert.equal(writes, 0);
  assert.equal(decryptions, 0);
});

test("an in-flight receive is consumed when receive is disabled before clipboard write", async () => {
  let releaseDecryption!: () => void;
  let markDecryptionStarted!: () => void;
  const decryptionStarted = new Promise<void>((resolve) => {
    markDecryptionStarted = resolve;
  });
  const decryptionGate = new Promise<void>((resolve) => {
    releaseDecryption = resolve;
  });
  let writes = 0;
  const processedItemStore = new RecordingProcessedItemStore();
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    decrypt: async () => {
      markDecryptionStarted();
      await decryptionGate;
      return { plaintext: "old inbound value", plaintextBytes: new TextEncoder().encode("old inbound value") };
    },
  });

  const envelope = inboundEnvelope("receive-boundary-item");
  const receive = setup.runtime.receiveClipboardItem(envelope);
  await decryptionStarted;
  const disabled = await setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: false,
    }),
  );
  assert.equal(disabled.ok, true);
  releaseDecryption();
  await receive;

  assert.equal(writes, 0);
  assert.equal(
    processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition,
    "receive-disabled",
  );
});

test("Receive disable becomes a barrier before its storage write completes", async () => {
  const preferences = gatedSyncPreferencesStore();
  let releaseDecryption!: () => void;
  let markDecryptionStarted!: () => void;
  const decryptionStarted = new Promise<void>((resolve) => {
    markDecryptionStarted = resolve;
  });
  const decryptionGate = new Promise<void>((resolve) => {
    releaseDecryption = resolve;
  });
  let writes = 0;
  const setup = await startReady({
    syncPreferencesStore: preferences.store,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    decrypt: async () => {
      markDecryptionStarted();
      await decryptionGate;
      return { plaintext: "old inbound value", plaintextBytes: new TextEncoder().encode("old inbound value") };
    },
  });

  const receive = setup.runtime.receiveClipboardItem(
    inboundEnvelope("pending-storage-receive-item"),
  );
  await decryptionStarted;
  const disabling = setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: false,
    }),
  );
  await preferences.setStarted;
  assert.equal(setup.runtime.getStatus().syncPreferences.receiveEnabled, false);

  releaseDecryption();
  await receive;
  assert.equal(writes, 0);
  preferences.releaseSet();
  assert.equal((await disabling).ok, true);
});

test("an in-flight receive is not revived by Both after receive briefly turns Off", async () => {
  let releaseDecryption!: () => void;
  let markDecryptionStarted!: () => void;
  const decryptionStarted = new Promise<void>((resolve) => {
    markDecryptionStarted = resolve;
  });
  const decryptionGate = new Promise<void>((resolve) => {
    releaseDecryption = resolve;
  });
  let writes = 0;
  const processedItemStore = new RecordingProcessedItemStore();
  const setup = await startReady({
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    decrypt: async () => {
      markDecryptionStarted();
      await decryptionGate;
      return { plaintext: "pre-Off inbound value", plaintextBytes: new TextEncoder().encode("pre-Off inbound value") };
    },
  });

  const envelope = inboundEnvelope("receive-revision-boundary-item");
  const receive = setup.runtime.receiveClipboardItem(envelope);
  await decryptionStarted;
  for (const preferences of [
    { sendEnabled: false, receiveEnabled: false },
    { sendEnabled: true, receiveEnabled: true },
  ] as const) {
    const result = await setup.runtime.handleMessage(
      runtimeMessage({ type: "runtime:set-sync-preferences", ...preferences }),
    );
    assert.equal(result.ok, true);
  }
  releaseDecryption();
  await receive;

  assert.equal(writes, 0);
  assert.equal(
    processedItemStore.records.get(`${user.id}:${envelope.itemId}`)?.disposition,
    "receive-disabled",
  );
});

test("Receive only never starts the watcher and Off keeps the socket ready", async () => {
  const receiveOnlyStore = new InMemorySyncPreferencesStore();
  await receiveOnlyStore.set({
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
  const receiveOnlyStarts: unknown[] = [];
  const receiveOnly = await startReady({
    localTrustState: "verified",
    syncPreferencesStore: receiveOnlyStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => undefined,
      startWatching: async (options) => {
        receiveOnlyStarts.push(options);
      },
      stopWatching: async () => undefined,
    },
  });
  await flushRuntimeWork();
  assert.equal(receiveOnly.runtime.getStatus().syncReady, true);
  assert.deepEqual(receiveOnlyStarts, []);

  const offStore = new InMemorySyncPreferencesStore();
  await offStore.set({
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: false,
  });
  let writes = 0;
  const off = await startReady({
    localTrustState: "verified",
    syncPreferencesStore: offStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
  });
  assert.equal(off.runtime.getStatus().socket.connected, true);
  assert.equal(off.runtime.getStatus().syncReady, true);
  await off.runtime.receiveClipboardItem(inboundEnvelope("off-item"));
  assert.equal(writes, 0);
  assert.equal(
    await off.processedItemStore.has(user.id, "off-item"),
    true,
  );
  const manual = await off.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(manual.ok, false);
  assert.equal(manual.error?.code, "CLIPBOARD_SEND_DISABLED");
  assert.equal(off.runtime.getStatus().socket.connected, true);
});

test("Send only keeps automatic publishing enabled while receive writes stay disabled", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  await syncPreferencesStore.set({
    schemaVersion: 1,
    sendEnabled: true,
    receiveEnabled: false,
  });
  const encryptedTexts: string[] = [];
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore,
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      return {
        itemId: "send-only-item",
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.handleClipboardObservation(
    clipboardObservation("send-only text"),
  );
  assert.deepEqual(encryptedTexts, ["send-only text"]);
  assert.equal(setup.runtime.getStatus().syncPreferences.receiveEnabled, false);
});

test("Receive only preference survives reconnect without starting the watcher", async () => {
  const syncPreferencesStore = new InMemorySyncPreferencesStore();
  await syncPreferencesStore.set({
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
  const starts: unknown[] = [];
  const setup = await startReady({
    localTrustState: "verified",
    syncPreferencesStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => undefined,
      startWatching: async (options) => {
        starts.push(options);
      },
      stopWatching: async () => undefined,
    },
  });
  await flushRuntimeWork();
  setup.socket.trigger("disconnect", "sleep-wake");
  await setup.runtime.reconcileConnectivity("sleep-wake", {
    forceSocketRecycle: true,
  });
  setup.socket.trigger("auth:ready");
  await flushRuntimeWork();
  assert.deepEqual(starts, []);
  assert.deepEqual(setup.runtime.getStatus().syncPreferences, {
    schemaVersion: 1,
    sendEnabled: false,
    receiveEnabled: true,
  });
});

test("expired inbound items are consumed before decryption and do not report crypto failure", async () => {
  const processedItemStore = new InMemoryItemMetadataStore();
  let decryptions = 0;
  let writes = 0;
  const setup = await startReady({
    localTrustState: "verified",
    processedItemStore,
    clipboardAdapter: {
      readText: async () => "",
      writeText: async () => {
        writes += 1;
      },
    },
    decrypt: async () => {
      decryptions += 1;
      throw new Error("must not decrypt stale data");
    },
  });
  await setup.runtime.receiveClipboardItem(
    inboundEnvelope("expired-item", new Date(Date.now() - 1).toISOString()),
  );
  assert.equal(decryptions, 0);
  assert.equal(writes, 0);
  assert.equal(await processedItemStore.has(user.id, "expired-item"), true);
  assert.equal(setup.runtime.getStatus().lastSyncError, undefined);
});

test("manual and automatic publish paths use the shared 60 second live TTL", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const expiries: Array<Date | string> = [];
  const setup = await startReady({
    localTrustState: "verified",
    now: () => now,
    encrypt: async (input) => {
      expiries.push(input.expiresAt);
      return {
        itemId: `${expiries.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  await setup.runtime.handleClipboardObservation(
    clipboardObservation("automatic"),
  );
  assert.equal(expiries.length, 2);
  assert.deepEqual(
    expiries.map((expiry) => new Date(expiry).getTime()),
    [now.getTime() + 60_000, now.getTime() + 60_000],
  );
});

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
    schemaVersion: 2,
    accessToken: "google-access-token",
    refreshToken: "google-refresh-token",
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
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: "otp-access-token",
    refreshToken: "otp-refresh-token",
    user,
  });
  assert.equal(setup.runtime.getStatus().signedIn, true);
});

test("refresh rotates and durably replaces the v2 refresh credential", async () => {
  const refreshArguments: Array<string | undefined> = [];
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      user,
    },
    refreshTokens: async (refreshToken) => {
      refreshArguments.push(refreshToken);
      return response(refreshedSession("new-access-token", "new-refresh-token"));
    },
  });

  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-refresh" }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(refreshArguments, ["old-refresh-token"]);
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    user,
  });
});

test("concurrent refresh demand uses one old token and shares the persisted replacement", async () => {
  const refreshArguments: Array<string | undefined> = [];
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      user,
    },
    refreshTokens: async (refreshToken) => {
      refreshArguments.push(refreshToken);
      await refreshGate;
      return response(refreshedSession("shared-access-token", "shared-refresh-token"));
    },
  });

  await setup.runtime.start();
  const first = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-refresh" }),
  );
  const second = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-refresh" }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshArguments, ["old-refresh-token"]);

  releaseRefresh();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: "shared-access-token",
    refreshToken: "shared-refresh-token",
    user,
  });
});

test("runtime logout sends the v2 refresh token and always clears local session", async () => {
  let logoutRefreshToken: string | undefined;
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user,
    },
    logout: async (refreshToken) => {
      logoutRefreshToken = refreshToken;
      throw new Error("backend unavailable");
    },
  });

  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:logout" }),
  );

  assert.equal(result.ok, true);
  assert.equal(logoutRefreshToken, "refresh-token");
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);
});

test("runtime logout waits for backend revocation after clearing local session", async () => {
  let markLogoutStarted!: () => void;
  const logoutStarted = new Promise<void>((resolve) => {
    markLogoutStarted = resolve;
  });
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user,
    },
    logout: async () => {
      markLogoutStarted();
      await logoutGate;
      return response(undefined);
    },
  });

  await setup.runtime.start();
  const pendingLogout = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:logout" }),
  );
  await logoutStarted;
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);
  assert.equal(setup.runtime.getStatus().connectionState, "signed-out");

  let responseSettled = false;
  const logoutResponse = pendingLogout.then((result) => {
    responseSettled = true;
    return result;
  });
  await flushRuntimeWork();
  assert.equal(responseSettled, false);

  releaseLogout();
  assert.equal((await logoutResponse).ok, true);
});

test("runtime logout succeeds locally when backend revocation times out", async (t) => {
  let markLogoutStarted!: () => void;
  const logoutStarted = new Promise<void>((resolve) => {
    markLogoutStarted = resolve;
  });
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user,
    },
    logout: async () => {
      markLogoutStarted();
      await logoutGate;
      return response(undefined);
    },
  });

  await setup.runtime.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pendingLogout = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:logout" }),
  );
  await logoutStarted;
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);

  let responseSettled = false;
  const responsePromise = pendingLogout.then((result) => {
    responseSettled = true;
    return result;
  });
  await flushRuntimeWork();
  assert.equal(responseSettled, false);

  t.mock.timers.runAll();
  assert.equal((await responsePromise).ok, true);
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);
  releaseLogout();
});

test("runtime logout cannot resurrect a session during an in-flight refresh", async () => {
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user,
    },
    refreshTokens: async () => {
      markRefreshStarted();
      await refreshGate;
      return response(refreshedSession("refreshed-access-token"));
    },
  });

  await setup.runtime.start();
  const refresh = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-refresh" }),
  );
  await refreshStarted;

  const logout = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:logout" }),
  );
  assert.equal(logout.ok, true);
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);

  releaseRefresh();
  const refreshResult = await refresh;
  assert.equal(refreshResult.ok, false);
  assert.equal(refreshResult.error?.code, "AUTH_REQUIRED");
  assert.equal(await setup.sessionStore.get(), null);
  assert.equal(setup.runtime.getStatus().signedIn, false);
});

async function startReady(overrides: Parameters<typeof makeRuntime>[0] = {}) {
  const setup = makeRuntime({ localTrustState: "verified", ...overrides });
  await setup.runtime.start();
  setup.socket.trigger("auth:ready");
  return setup;
}

const directSourceDevice: RegisteredDeviceResponse = {
  ...registeredDevice,
  deviceId: "00000000-0000-4000-8000-000000000002",
  name: "Direct Source",
  encryptionPublicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  signingPublicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
};

function directSignal(
  overrides: Partial<DirectSignalDelivery> = {},
): DirectSignalDelivery {
  return {
    transferId: "44444444-4444-4444-8444-444444444444",
    sourceDeviceId: directSourceDevice.deviceId,
    sourceKeyVersion: directSourceDevice.keyVersion,
    kind: "cancel",
    reason: "test signal",
    ...overrides,
  };
}

async function startDirectSignalRuntime(): Promise<{
  setup: Awaited<ReturnType<typeof startReady>>;
  handled: DirectSignalDelivery[];
  pairing: ReturnType<typeof makePairingTrustStore>;
  setServerSource: (device: RegisteredDeviceResponse | null) => void;
}> {
  const pairing = makePairingTrustStore();
  const handled: DirectSignalDelivery[] = [];
  const directTransport: DirectTransport = {
    startTestTransfer: async () => undefined,
    handleSignal: async (signal) => {
      handled.push(signal);
    },
    cancelTransfer: async () => undefined,
    cancelAll: async () => undefined,
  };
  let serverSource: RegisteredDeviceResponse | null = directSourceDevice;
  const setup = await startReady({
    trustStore: pairing.trustStore,
    directTransport,
    listDevices: async () =>
      response([registeredDevice, ...(serverSource ? [serverSource] : [])]),
    listPendingDevices: async () => response([]),
  });
  await waitForRuntimeCondition(
    () => setup.runtime.getStatus().socket.deviceAuthenticated,
    "direct signal test socket did not become authenticated",
  );
  return {
    setup,
    handled,
    pairing,
    setServerSource: (device) => {
      serverSource = device;
    },
  };
}

test("a valid locally pinned direct signal is forwarded to offscreen", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "verified");
  const signal = directSignal();

  direct.setup.socket.trigger("direct:signal", signal);
  await waitForRuntimeCondition(
    () => direct.handled.length === 1,
    "valid direct signal was not forwarded",
  );
  assert.deepEqual(direct.handled, [signal]);
});

test("a direct signal from a locally unverified source is not forwarded", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "unverified");

  direct.setup.socket.trigger("direct:signal", directSignal());
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(direct.handled.length, 0);
});

test("a direct signal with a different source key version is not forwarded", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "verified");

  direct.setup.socket.trigger(
    "direct:signal",
    directSignal({ sourceKeyVersion: directSourceDevice.keyVersion + 1 }),
  );
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(direct.handled.length, 0);
});

test("a direct signal with a different pinned signing key is not forwarded", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "verified");
  direct.setServerSource({
    ...directSourceDevice,
    signingPublicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw=",
  });

  direct.setup.socket.trigger("direct:signal", directSignal());
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(direct.handled.length, 0);
});

test("a direct signal with a different pinned encryption key is not forwarded", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "verified");
  direct.setServerSource({
    ...directSourceDevice,
    encryptionPublicKey: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  });

  direct.setup.socket.trigger("direct:signal", directSignal());
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(direct.handled.length, 0);
});

test("a direct signal from a source no longer trusted by the server is not forwarded", async () => {
  const direct = await startDirectSignalRuntime();
  putLocalRecord(direct.pairing.records, directSourceDevice, "verified");
  direct.setServerSource({
    ...directSourceDevice,
    trustState: "revoked",
    revokedAt: new Date().toISOString(),
  });

  direct.setup.socket.trigger("direct:signal", directSignal());
  await flushRuntimeWork();
  await flushRuntimeWork();
  assert.equal(direct.handled.length, 0);
});

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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

function refreshedSession(token: string, refreshToken = "refresh"): SignInResponse {
  return { message: "refreshed", accessToken: token, refreshToken, user };
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
  let refreshArgument: string | undefined;
  let refreshCalls = 0;
  const setup = makeRuntime({
    accessToken: jwtWithExpiry(Math.floor(Date.now() / 1000) - 10),
    refreshTokens: async (refreshToken) => {
      refreshCalls += 1;
      refreshArgument = refreshToken;
      return response(refreshedSession(newToken));
    },
  });
  await setup.runtime.start();
  assert.equal(refreshCalls, 1);
  assert.equal(refreshArgument, undefined);
  assert.deepEqual(setup.getSocketOptions()?.auth, { token: newToken });
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: newToken,
    refreshToken: "refresh",
    user,
  });
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

test("arbitrary refresh 4xx responses retain the durable session", async () => {
  for (const status of [400, 404, 408, 409, 425, 429, 500]) {
    const setup = makeRuntime({
      refreshTokens: async () => {
        throw { response: { status } };
      },
    });
    await setup.runtime.start();
    setup.socket.trigger("auth:failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(await setup.sessionStore.get(), `session retained for HTTP ${status}`);
  }
});

test("refresh_token_not_found reports recovery without erasing the v2 session", async () => {
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user,
    },
    refreshTokens: async () => {
      throw {
        response: {
          status: 400,
          data: { message: "refresh_token_not_found" },
        },
      };
    },
  });

  await setup.runtime.start();
  const result = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:auth-refresh" }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "AUTH_REQUIRED");
  assert.match(result.error?.message ?? "", /durable refresh credential/i);
  assert.ok(await setup.sessionStore.get());
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
    capabilities: Array.isArray(rootDevice.capabilities)
      ? [...rootDevice.capabilities]
      : undefined,
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
      if (current?.trustState === "revoked") return current;
      if (current?.trustState === "root" || current?.trustState === "verified") {
        if (
          current.userId !== device.userId ||
          current.deviceId !== device.deviceId ||
          current.keyVersion !== device.keyVersion ||
          current.encryptionPublicKey !== device.encryptionPublicKey ||
          current.signingPublicKey !== device.signingPublicKey
        ) {
          throw new Error("trusted device identity changed");
        }
        const refreshed = {
          ...current,
          name: device.name,
          platform: device.platform,
          capabilities: Array.isArray(device.capabilities)
            ? [...device.capabilities]
            : undefined,
          appVersion: device.appVersion,
        };
        records.set(key(device.deviceId), refreshed);
        return refreshed;
      }
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

test("recipient bundle capabilities never select outgoing bundles or establish local trust", async () => {
  for (const capabilities of [[], ["clipboard"], ["clipboard", "clipboard-bundle-v1"]]) {
    const currentDevice = { ...registeredDevice, capabilities };
    const recipient = {
      ...pendingDevice,
      trustState: "trusted",
      approvedByDeviceId: identity.deviceId,
      capabilities,
    };
    const unverifiedDevice = {
      ...recipient,
      deviceId: "00000000-0000-4000-8000-000000000003",
      capabilities: ["clipboard", "clipboard-bundle-v1"],
    };
    const pairing = makePairingTrustStore(identity, currentDevice);
    putLocalRecord(pairing.records, recipient, "verified");
    putLocalRecord(pairing.records, unverifiedDevice, "unverified");
    const plaintext = "  raw recipient-independent e\u0301 🦊\n";
    const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
    const setup = await startReady({
      registeredDevice: currentDevice,
      trustStore: pairing.trustStore,
      listDevices: async () => response([currentDevice, recipient, unverifiedDevice]),
      encrypt: async (input) => {
        encryptInputs.push(input);
        return {
          ...inboundEnvelope("capability-independent-publish"),
          contentType: input.contentType,
          expiresAt: input.expiresAt,
        };
      },
    });
    await setup.runtime.publishClipboardText(plaintext);
    assert.equal(encryptInputs.length, 1);
    assert.equal(encryptInputs[0].contentType, "text/plain");
    assert.equal(encryptInputs[0].plaintext, plaintext);
    assert.deepEqual(
      encryptInputs[0].recipients.map((device) => device.deviceId).sort(),
      [identity.deviceId, recipient.deviceId].sort(),
    );
    assert.equal(pairing.records.get(`${user.id}:${unverifiedDevice.deviceId}`)?.trustState, "unverified");
  }
});

function clipboardObservation(text: string) {
  return {
    source: "offscreen" as const,
    target: "service-worker" as const,
    type: "CLIPBOARD_CHANGED" as const,
    text,
  };
}

test("automatic observations and manual Send use typed payloads but encrypt exact legacy raw text", async () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const manualText = "\uFEFF  manual café e\u0301 🦊\r\n\t ";
  const automaticText = "\n automatic 日本語 🚀\t  ";
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
  const typedPayloads: ClipboardPayloadV1[] = [];
  const clipboardAdapter: ClipboardAdapter = {
    readText: async () => manualText,
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
    now: () => now,
    encrypt: async (input) => {
      encryptInputs.push(input);
      return {
        itemId: `${encryptInputs.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: input.contentType,
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });
  const publishPayload = setup.runtime.publishClipboardPayload.bind(setup.runtime);
  setup.runtime.publishClipboardPayload = async (payload) => {
    typedPayloads.push(payload);
    return publishPayload(payload);
  };
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
  await setup.runtime.handleClipboardObservation(clipboardObservation(automaticText));
  assert.deepEqual(typedPayloads, [manualText, automaticText].map((text) => ({
    version: 1,
    representations: [{ mime: "text/plain", encoding: "utf-8", data: text }],
  })));
  assert.deepEqual(encryptInputs.map((input) => input.plaintext), [manualText, automaticText]);
  assert.deepEqual(encryptInputs.map((input) => input.contentType), ["text/plain", "text/plain"]);
  assert.deepEqual(
    encryptInputs.map((input) => new Date(input.expiresAt).getTime()),
    [now.getTime() + 60_000, now.getTime() + 60_000],
  );
  const publishedEnvelopes = setup.socket.emissions
    .filter((emission) => emission.event === "clipboard:publish")
    .map((emission) => emission.args[0] as { contentType: string });
  assert.deepEqual(publishedEnvelopes.map((envelope) => envelope.contentType), ["text/plain", "text/plain"]);
  assert.equal(typeof setup.runtime.getStatus().lastAutoSyncAt, "string");
});

test("rich automatic and manual observations stay legacy on the network", async () => {
  const rich = richClipboardBundle("  exact plain fallback\r\n");
  const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
  const applied: ClipboardPayloadV1[] = [];
  const setup = await startReady({
    clipboardAdapter: {
      readText: async () => rich.plainText,
      readPayload: async () => rich.payload,
      writeText: async () => undefined,
      writePayload: async (payload) => { applied.push(payload); },
    },
    encrypt: async (input) => {
      encryptInputs.push(input);
      return {
        ...inboundEnvelope(`rich-${encryptInputs.length}`),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });

  const manual = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(manual.ok, true);
  await setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: rich.payload,
  });
  assert.deepEqual(encryptInputs.map((input) => input.plaintext), [
    rich.plainText,
    rich.plainText,
  ]);
  assert.deepEqual(encryptInputs.map((input) => input.contentType), [
    "text/plain",
    "text/plain",
  ]);
  assert.equal(
    setup.socket.emissions
      .filter((emission) => emission.event === "clipboard:publish")
      .every((emission) =>
        (emission.args[0] as { contentType: string }).contentType ===
        "text/plain",
      ),
    true,
  );

  const inbound = {
    ...inboundEnvelope("rich-inbound"),
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
  };
  const receive = await startReady({
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      writePayload: async (payload) => { applied.push(payload); },
    },
    decrypt: async () => ({ plaintextBytes: rich.bytes }),
  });
  await receive.runtime.receiveClipboardItem(inbound);
  assert.deepEqual(applied[applied.length - 1], rich.payload);
});

test("rich publish encrypts one exact bundle for the full rich-capable recipient set", async () => {
  const rich = richClipboardBundle("rich network fallback");
  const richCurrent = {
    ...registeredDevice,
    capabilities: ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
  };
  const staleCurrent = { ...richCurrent, capabilities: ["clipboard"] };
  const richRecipient = {
    ...pendingDevice,
    trustState: "trusted",
    capabilities: ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
  };
  const pairing = makePairingTrustStore(identity, staleCurrent);
  putLocalRecord(pairing.records, richRecipient, "verified", {
    capabilities: ["clipboard"],
  });
  const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
  const setup = await startReady({
    registeredDevice: richCurrent,
    trustStore: pairing.trustStore,
    listDevices: async () => response([richCurrent, richRecipient]),
    encrypt: async (input) => {
      encryptInputs.push(input);
      return {
        ...inboundEnvelope("rich-network-publish"),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });

  assert.deepEqual(
    pairing.records.get(`${user.id}:${identity.deviceId}`)?.capabilities,
    ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
  );
  assert.deepEqual(
    pairing.records.get(`${user.id}:${richRecipient.deviceId}`)?.capabilities,
    ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
  );

  await setup.runtime.publishClipboardPayload(rich.payload);

  assert.equal(encryptInputs.length, 1);
  assert.equal(encryptInputs[0]?.contentType, CLIPBOARD_BUNDLE_V1_MIME);
  assert.ok(encryptInputs[0]?.plaintext instanceof Uint8Array);
  assert.deepEqual(encryptInputs[0]?.plaintext, rich.bytes);
  assert.deepEqual(
    decodeClipboardBundleV1(encryptInputs[0]!.plaintext as Uint8Array),
    rich.payload,
  );
  assert.deepEqual(
    encryptInputs[0]?.recipients.map((recipient) => recipient.deviceId).sort(),
    [identity.deviceId, richRecipient.deviceId].sort(),
  );
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    1,
  );
});

test("mixed recipients receive capability-specific encrypted projections", async () => {
  const rich = richClipboardBundle("Copyyt");
  const richCurrent = {
    ...registeredDevice,
    capabilities: ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
  };
  const legacyRecipient = {
    ...pendingDevice,
    trustState: "trusted",
    capabilities: ["clipboard"],
  };
  const pairing = makePairingTrustStore(identity, richCurrent);
  putLocalRecord(pairing.records, legacyRecipient, "verified", {
    capabilities: ["clipboard"],
  });
  const encryptInputs: Parameters<NonNullable<RuntimeDependencies["encrypt"]>>[0][] = [];
  const setup = await startReady({
    registeredDevice: richCurrent,
    trustStore: pairing.trustStore,
    listDevices: async () => response([richCurrent, legacyRecipient]),
    encrypt: async (input) => {
      encryptInputs.push(input);
      return {
        ...inboundEnvelope("mixed-legacy-publish"),
        contentType: input.contentType,
        expiresAt: input.expiresAt,
      };
    },
  });

  await setup.runtime.publishClipboardPayload(rich.payload);

  assert.equal(encryptInputs.length, 2);
  const bundleInput = encryptInputs.find((input) => input.contentType === CLIPBOARD_BUNDLE_V1_MIME)!;
  const plainInput = encryptInputs.find((input) => input.contentType === "text/plain")!;
  assert.deepEqual(decodeClipboardBundleV1(bundleInput.plaintext as Uint8Array), rich.payload);
  assert.equal(plainInput.plaintext, "Copyyt");
  assert.deepEqual(bundleInput.recipients.map((recipient) => recipient.deviceId), [identity.deviceId]);
  assert.deepEqual(plainInput.recipients.map((recipient) => recipient.deviceId), [legacyRecipient.deviceId]);
  assert.equal(
    setup.socket.emissions.filter((emission) => emission.event === "clipboard:publish").length,
    2,
  );
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

test("transient startup connectivity failure leaves a responsive runtime for later recovery", async () => {
  let available = false;
  const setup = makeRuntime({
    localTrustState: "verified",
    listDevices: async () => {
      if (!available) throw new Error("network unavailable after wake");
      return response([registeredDevice]);
    },
    listPendingDevices: async () => {
      if (!available) throw new Error("network unavailable after wake");
      return response([]);
    },
  });

  await setup.runtime.start();
  const status = await setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:get-status" }),
  );
  assert.equal(status.ok, true);
  assert.equal(setup.runtime.getStatus().signedIn, true);
  assert.notEqual(setup.runtime.getStatus().connectionState, "signed-out");

  available = true;
  await setup.runtime.reconcileConnectivity("network-restored");
  assert.equal(setup.runtime.getStatus().socket.connected, true);
  setup.socket.trigger("auth:challenge", {
    socketId: "socket-1",
    challenge: "recovery-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  setup.socket.trigger("auth:ready");
  assert.equal(setup.runtime.getStatus().syncReady, true);
});

test("disconnect clears live auth state, stops watching, and re-authenticates a replacement socket", async () => {
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let signatures = 0;
  const setup = await startReady({
    localTrustState: "verified",
    clipboardAdapter: {
      readText: async () => "baseline",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    signChallenge: async () => {
      signatures += 1;
      return `signature-${signatures}`;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.runtime.getStatus().syncReady, true);

  setup.socket.trigger("disconnect", "transport close");
  assert.equal(setup.runtime.getStatus().socket.connected, false);
  assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, false);
  assert.equal(setup.runtime.getStatus().syncReady, false);
  assert.equal(setup.runtime.getStatus().clipboardWatch, "stopped");

  await setup.runtime.reconcileConnectivity("test-reconnect", {
    forceSocketRecycle: true,
  });
  setup.socket.trigger("auth:challenge", {
    socketId: "socket-1",
    challenge: "reconnect-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  setup.socket.trigger("auth:ready");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signatures, 1);
  assert.equal(setup.runtime.getStatus().syncReady, true);
  assert.deepEqual(watchCalls.filter((call) => call.type === "start"), [
    { type: "start", resetBaseline: true },
    { type: "start", resetBaseline: true },
  ]);
  assert.ok(watchCalls.some((call) => call.type === "stop"));
});

test("automatic observations received during a disconnect are not replayed after rebaseline", async () => {
  const encryptedTexts: string[] = [];
  const setup = await startReady({
    localTrustState: "verified",
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

  setup.socket.trigger("disconnect", "transport close");
  await setup.runtime.handleClipboardObservation(clipboardObservation("stale"));
  await setup.runtime.reconcileConnectivity("test-wake", {
    forceSocketRecycle: true,
  });
  setup.socket.trigger("auth:challenge", {
    socketId: "socket-1",
    challenge: "wake-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  setup.socket.trigger("auth:ready");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(encryptedTexts, []);
  await setup.runtime.handleClipboardObservation(clipboardObservation("fresh"));
  assert.deepEqual(encryptedTexts, ["fresh"]);
});

test("manual Send performs one bounded recovery before reading and publishing", async () => {
  let available = false;
  const setup = makeRuntime({
    localTrustState: "verified",
    listDevices: async () => {
      if (!available) throw new Error("network unavailable");
      return response([registeredDevice]);
    },
    listPendingDevices: async () => {
      if (!available) throw new Error("network unavailable");
      return response([]);
    },
  });
  await setup.runtime.start();
  available = true;

  const send = setup.runtime.handleMessage(
    runtimeMessage({ type: "runtime:send-current-clipboard" }),
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (setup.runtime.getStatus().socket.connected) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  setup.socket.trigger("auth:challenge", {
    socketId: "socket-1",
    challenge: "manual-recovery-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  setup.socket.trigger("auth:ready");

  const result = await send;
  assert.equal(result.ok, true);
});

test("repeated recovery calls use one socket and one listener set per live socket", async () => {
  const sockets: FakeSocket[] = [];
  const setup = makeRuntime({
    localTrustState: "verified",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await setup.runtime.start();
  assert.equal(sockets.length, 1);

  const firstRecovery = setup.runtime.reconcileConnectivity("first", {
    forceSocketRecycle: true,
  });
  const secondRecovery = setup.runtime.reconcileConnectivity("second", {
    forceSocketRecycle: true,
  });
  await Promise.all([firstRecovery, secondRecovery]);

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].events.size, 8);
  await setup.runtime.reconcileConnectivity("third", {
    forceSocketRecycle: true,
  });
  assert.equal(sockets.length, 3);
  assert.equal(sockets[2].events.size, 8);
});

test("a concurrent forced socket recycle is escalated into one follow-up", async () => {
  const sockets: FakeSocket[] = [];
  let listDevicesCalls = 0;
  let releaseFirstReconciliation!: () => void;
  let markFirstReconciliationStarted!: () => void;
  const firstReconciliationStarted = new Promise<void>((resolve) => {
    markFirstReconciliationStarted = resolve;
  });
  const firstReconciliationGate = new Promise<void>((resolve) => {
    releaseFirstReconciliation = resolve;
  });
  let signatures = 0;
  const setup = makeRuntime({
    localTrustState: "verified",
    listDevices: async () => {
      listDevicesCalls += 1;
      if (listDevicesCalls === 2) {
        markFirstReconciliationStarted();
        await firstReconciliationGate;
      }
      return response([registeredDevice]);
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    signChallenge: async () => {
      signatures += 1;
      return `signature-${signatures}`;
    },
  });
  await setup.runtime.start();
  const first = setup.runtime.reconcileConnectivity("ordinary");
  await firstReconciliationStarted;
  const second = setup.runtime.reconcileConnectivity("sleep-wake", {
    forceSocketRecycle: true,
  });
  releaseFirstReconciliation();
  await Promise.all([first, second]);

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].events.size, 0);
  assert.equal(sockets[1].events.size, 8);

  sockets[1].trigger("auth:challenge", {
    socketId: "replacement-socket",
    challenge: "replacement-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1].trigger("auth:ready");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signatures, 1);
  assert.deepEqual(
    sockets[1].emissions.find((emission) => emission.event === "auth:device")
      ?.args[0],
    {
      deviceId: identity.deviceId,
      keyVersion: 1,
      signature: "signature-1",
    },
  );
});

test("a concurrent forced token refresh is escalated into one follow-up", async () => {
  const sockets: FakeSocket[] = [];
  let listDevicesCalls = 0;
  let releaseFirstReconciliation!: () => void;
  let markFirstReconciliationStarted!: () => void;
  const firstReconciliationStarted = new Promise<void>((resolve) => {
    markFirstReconciliationStarted = resolve;
  });
  const firstReconciliationGate = new Promise<void>((resolve) => {
    releaseFirstReconciliation = resolve;
  });
  let refreshCalls = 0;
  let signatures = 0;
  const setup = makeRuntime({
    localTrustState: "verified",
    listDevices: async () => {
      listDevicesCalls += 1;
      if (listDevicesCalls === 2) {
        markFirstReconciliationStarted();
        await firstReconciliationGate;
      }
      return response([registeredDevice]);
    },
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession("refreshed-access-token"));
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    signChallenge: async () => {
      signatures += 1;
      return `signature-${signatures}`;
    },
  });
  await setup.runtime.start();

  const first = setup.runtime.reconcileConnectivity("ordinary");
  await firstReconciliationStarted;
  const second = setup.runtime.reconcileConnectivity("auth-failure", {
    forceTokenRefresh: true,
  });
  releaseFirstReconciliation();
  await Promise.all([first, second]);

  assert.equal(refreshCalls, 1);
  assert.equal(sockets.length, 3);
  assert.equal(sockets[0].events.size, 0);
  assert.equal(sockets[1].events.size, 0);
  assert.equal(sockets[2].events.size, 8);

  sockets[2].trigger("auth:challenge", {
    socketId: "refreshed-socket",
    challenge: "refreshed-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[2].trigger("auth:ready");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signatures, 1);
  assert.equal(
    sockets[2].emissions.some((emission) => emission.event === "auth:device"),
    true,
  );
});

test("a connected but not-ready socket is replaced exactly once", async () => {
  const sockets: FakeSocket[] = [];
  const setup = makeRuntime({
    localTrustState: "verified",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  await setup.runtime.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].connected, true);
  assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, false);

  await setup.runtime.reconcileConnectivity("connected-not-ready");

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].connected, false);
  assert.equal(sockets[0].events.size, 0);
  assert.equal(sockets[1].connected, true);
  assert.equal(sockets[1].events.size, 8);

  sockets[1].trigger("auth:challenge", {
    socketId: "replacement-socket",
    challenge: "replacement-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1].trigger("auth:ready");
  await new Promise((resolve) => setImmediate(resolve));
  await setup.runtime.reconcileConnectivity("healthy-after-replacement");

  assert.equal(sockets.length, 2);
  assert.equal(setup.runtime.getStatus().syncReady, true);
});

test("an on-time recovery probe performs no control-plane or watcher work when healthy", async () => {
  let listDevicesCalls = 0;
  let listPendingDevicesCalls = 0;
  let socketCreations = 0;
  let challengeSignatures = 0;
  let liveSocket!: FakeSocket;
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  const setup = makeRuntime({
    localTrustState: "verified",
    listDevices: async () => {
      listDevicesCalls += 1;
      return response([registeredDevice]);
    },
    listPendingDevices: async () => {
      listPendingDevicesCalls += 1;
      return response([]);
    },
    socketFactory: () => {
      socketCreations += 1;
      liveSocket = new FakeSocket();
      return liveSocket;
    },
    signChallenge: async () => {
      challengeSignatures += 1;
      return "healthy-signature";
    },
    clipboardAdapter: {
      readText: async () => "baseline",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
  });
  await setup.runtime.start();
  liveSocket.trigger("auth:challenge", {
    socketId: "healthy-socket",
    challenge: "healthy-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  liveSocket.trigger("auth:ready");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (
      listDevicesCalls >= 2 &&
      listPendingDevicesCalls >= 2 &&
      watchCalls.some((call) => call.type === "start")
    ) {
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const before = setup.runtime.getStatus();
  const beforeCounts = {
    listDevicesCalls,
    listPendingDevicesCalls,
    socketCreations,
    challengeSignatures,
    watchCalls: [...watchCalls],
  };
  await setup.runtime.reconcileConnectivity("recovery-alarm");
  const after = setup.runtime.getStatus();

  assert.equal(listDevicesCalls, beforeCounts.listDevicesCalls);
  assert.equal(listPendingDevicesCalls, beforeCounts.listPendingDevicesCalls);
  assert.equal(socketCreations, beforeCounts.socketCreations);
  assert.equal(challengeSignatures, beforeCounts.challengeSignatures);
  assert.deepEqual(watchCalls, beforeCounts.watchCalls);
  assert.equal(after.socket.connected, true);
  assert.equal(after.socket.deviceAuthenticated, true);
  assert.equal(after.syncReady, true);
  assert.equal(after.connectionState, before.connectionState);
});

test("near-expiry recovery refreshes auth before automatic clipboard sync", async () => {
  let currentTime = new Date("2026-09-18T17:00:00.000Z");
  const initialExpiry = Math.floor(currentTime.getTime() / 1000) + 300;
  const initialToken = jwtWithExpiry(initialExpiry);
  const freshToken = jwtWithExpiry(initialExpiry + 3600);
  const sockets: FakeSocket[] = [];
  const membershipAccessTokens: string[] = [];
  const encryptedTexts: string[] = [];
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  let refreshCalls = 0;
  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: initialToken,
      refreshToken: "old-refresh-token",
      user,
    },
    localTrustState: "verified",
    now: () => currentTime,
    refreshTokens: async (refreshToken) => {
      refreshCalls += 1;
      assert.equal(refreshToken, "old-refresh-token");
      return response(refreshedSession(freshToken, "rotated-refresh-token"));
    },
    apiFactory: (accessToken, api) => ({
      ...api,
      devices: {
        ...api.devices,
        listDevices: async () => {
          membershipAccessTokens.push(accessToken);
          return api.devices.listDevices();
        },
        listPendingDevices: async () => {
          membershipAccessTokens.push(accessToken);
          return api.devices.listPendingDevices();
        },
      },
    }),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clipboardAdapter: {
      readText: async () => "unused",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchCalls.push({ type: "start", resetBaseline: options?.resetBaseline });
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      return {
        itemId: `automatic-${encryptedTexts.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  await setup.runtime.start();
  sockets[0].trigger("auth:challenge", {
    socketId: "initial-socket",
    challenge: "initial-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].trigger("auth:ready");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (setup.runtime.getStatus().clipboardWatch === "watching") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const membershipCallsBeforeRecovery = membershipAccessTokens.length;
  currentTime = new Date(initialExpiry * 1000 - 30_000);

  await setup.runtime.reconcileConnectivity("recovery-alarm");

  assert.equal(refreshCalls, 1);
  assert.equal(sockets.length, 2);
  assert.deepEqual(await setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: freshToken,
    refreshToken: "rotated-refresh-token",
    user,
  });
  assert.deepEqual(encryptedTexts, []);

  sockets[1].trigger("auth:challenge", {
    socketId: "refreshed-socket",
    challenge: "refreshed-challenge",
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1].trigger("auth:ready");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (setup.runtime.getStatus().clipboardWatch === "watching") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(setup.runtime.getStatus().syncReady, true);
  assert.deepEqual(watchCalls.filter((call) => call.type === "start"), [
    { type: "start", resetBaseline: true },
    { type: "start", resetBaseline: true },
  ]);
  assert.ok(
    membershipAccessTokens
      .slice(membershipCallsBeforeRecovery)
      .every((accessToken) => accessToken === freshToken),
  );

  await setup.runtime.handleClipboardObservation(
    clipboardObservation("copied after recovery"),
  );

  assert.deepEqual(encryptedTexts, ["copied after recovery"]);
  assert.ok(
    membershipAccessTokens.slice(membershipCallsBeforeRecovery).length > 0,
  );
  assert.ok(
    membershipAccessTokens
      .slice(membershipCallsBeforeRecovery)
      .every((accessToken) => accessToken === freshToken),
  );
  assert.equal(
    sockets[1].emissions.some((emission) => emission.event === "clipboard:publish"),
    true,
  );
});

function automaticAuthRecoveryFixture(
  blockRefresh = false,
  blockWatcherRestart = false,
) {
  const initialToken = "rejected-access-token";
  const freshToken = "recovered-access-token";
  const sockets: FakeSocket[] = [];
  const socketOptions: SocketOptions[] = [];
  const watchCalls: Array<{ type: "start" | "stop"; resetBaseline?: boolean }> = [];
  const membershipAccessTokens: string[] = [];
  const membershipAccessTokensAfterRefresh: string[] = [];
  const encryptedTexts: string[] = [];
  let rejectNextMembership = false;
  let refreshCalls = 0;
  let watchStartCount = 0;
  let markWatcherRestartStarted!: () => void;
  const watcherRestartStarted = new Promise<void>((resolve) => {
    markWatcherRestartStarted = resolve;
  });
  let releaseWatcherRestart = (): void => undefined;
  const watcherRestartGate = new Promise<void>((resolve) => {
    releaseWatcherRestart = resolve;
  });
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let releaseRefresh = (): void => undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const setup = makeRuntime({
    initialSession: {
      schemaVersion: 2,
      accessToken: initialToken,
      refreshToken: "old-refresh-token",
      user,
    },
    localTrustState: "verified",
    refreshTokens: async (refreshToken) => {
      refreshCalls += 1;
      assert.equal(refreshToken, "old-refresh-token");
      markRefreshStarted();
      if (blockRefresh) await refreshGate;
      return response(refreshedSession(freshToken, "rotated-refresh-token"));
    },
    apiFactory: (accessToken, api) => ({
      ...api,
      devices: {
        ...api.devices,
        listDevices: async () => {
          membershipAccessTokens.push(accessToken);
          if (refreshCalls > 0) {
            membershipAccessTokensAfterRefresh.push(accessToken);
          }
          if (rejectNextMembership) {
            rejectNextMembership = false;
            throw { response: { status: 401 } };
          }
          return response([registeredDevice]);
        },
        listPendingDevices: async () => {
          membershipAccessTokens.push(accessToken);
          if (refreshCalls > 0) {
            membershipAccessTokensAfterRefresh.push(accessToken);
          }
          return response([]);
        },
      },
    }),
    socketFactory: (_url, options) => {
      socketOptions.push(options);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clipboardAdapter: {
      readText: async () => "pre-recovery clipboard baseline",
      writeText: async () => undefined,
      startWatching: async (options) => {
        watchStartCount += 1;
        watchCalls.push({
          type: "start",
          resetBaseline: options?.resetBaseline,
        });
        if (blockWatcherRestart && watchStartCount === 2) {
          markWatcherRestartStarted();
          await watcherRestartGate;
        }
      },
      stopWatching: async () => {
        watchCalls.push({ type: "stop" });
      },
    },
    encrypt: async (input) => {
      encryptedTexts.push(input.plaintext as string);
      return {
        itemId: `automatic-${encryptedTexts.length}`,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion: 1,
        sourceSignature: "signature",
        protocolVersion: 1 as const,
        contentType: "text/plain",
        ciphertext: "ciphertext",
        nonce: "nonce",
        recipients: [],
        expiresAt: input.expiresAt,
      };
    },
  });

  return {
    setup,
    sockets,
    socketOptions,
    watchCalls,
    membershipAccessTokens,
    membershipAccessTokensAfterRefresh,
    encryptedTexts,
    refreshStarted,
    releaseRefresh,
    watcherRestartStarted,
    releaseWatcherRestart,
    getRefreshCalls: () => refreshCalls,
    rejectNextMembership: () => {
      rejectNextMembership = true;
    },
    freshToken,
  };
}

async function startAutomaticAuthRecoveryFixture(
  fixture: ReturnType<typeof automaticAuthRecoveryFixture>,
): Promise<void> {
  await fixture.setup.runtime.start();
  fixture.sockets[0].trigger("auth:ready");
  await waitForRuntimeCondition(
    () =>
      fixture.setup.runtime.getStatus().syncReady &&
      fixture.setup.runtime.getStatus().clipboardWatch === "watching",
    "initial socket and clipboard watcher did not become ready",
  );
  await flushRuntimeWork();
}

async function readyReplacementSocket(
  fixture: ReturnType<typeof automaticAuthRecoveryFixture>,
): Promise<void> {
  await waitForRuntimeCondition(
    () => fixture.sockets.length === 2,
    "auth recovery did not create a replacement socket",
  );
  fixture.sockets[1].trigger("auth:ready");
}

test("automatic publish recovers once from a membership HTTP 401", async () => {
  const fixture = automaticAuthRecoveryFixture(false, true);
  await startAutomaticAuthRecoveryFixture(fixture);
  const membershipCallsBeforeFailure = fixture.membershipAccessTokens.length;
  fixture.rejectNextMembership();

  const observation = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("auth-recovered clipboard"),
  );
  await readyReplacementSocket(fixture);
  await fixture.watcherRestartStarted;
  await observation;

  assert.deepEqual(fixture.encryptedTexts, ["auth-recovered clipboard"]);
  assert.equal(fixture.setup.runtime.getStatus().clipboardWatch, "starting");
  fixture.releaseWatcherRestart();
  await waitForRuntimeCondition(
    () => fixture.setup.runtime.getStatus().clipboardWatch === "watching",
    "replacement clipboard watcher did not become ready",
  );

  assert.equal(fixture.getRefreshCalls(), 1);
  assert.deepEqual(await fixture.setup.sessionStore.get(), {
    schemaVersion: 2,
    accessToken: fixture.freshToken,
    refreshToken: "rotated-refresh-token",
    user,
  });
  assert.equal(fixture.setup.runtime.getStatus().syncReady, true);
  assert.deepEqual(
    fixture.watchCalls.filter((call) => call.type === "start"),
    [
      { type: "start", resetBaseline: true },
      { type: "start", resetBaseline: true },
    ],
  );
  assert.deepEqual(fixture.socketOptions[1].auth, { token: fixture.freshToken });
  assert.ok(
    fixture.membershipAccessTokens.length > membershipCallsBeforeFailure,
  );
  assert.ok(
    fixture.membershipAccessTokensAfterRefresh.length > 0 &&
      fixture.membershipAccessTokensAfterRefresh.every(
        (accessToken) => accessToken === fixture.freshToken,
      ),
  );
  assert.equal(
    fixture.sockets[1].emissions.some(
      (emission) => emission.event === "clipboard:publish",
    ),
    true,
  );
});

test("automatic auth recovery keeps only the latest rapid observation", async () => {
  const fixture = automaticAuthRecoveryFixture(true, true);
  await startAutomaticAuthRecoveryFixture(fixture);
  fixture.rejectNextMembership();

  const first = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("A"),
  );
  await fixture.refreshStarted;
  const second = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("B"),
  );
  await flushRuntimeWork();

  fixture.releaseRefresh();
  await readyReplacementSocket(fixture);
  await fixture.watcherRestartStarted;
  await Promise.all([first, second]);

  assert.deepEqual(fixture.encryptedTexts, ["B"]);
  fixture.releaseWatcherRestart();
  await waitForRuntimeCondition(
    () => fixture.setup.runtime.getStatus().clipboardWatch === "watching",
    "replacement clipboard watcher did not become ready",
  );

  assert.equal(
    fixture.sockets[1].emissions.filter(
      (emission) => emission.event === "clipboard:publish",
    ).length,
    1,
  );
  assert.equal(fixture.getRefreshCalls(), 1);
});

test("image-only observation cancels an automatic auth-recovery retry", async () => {
  const fixture = automaticAuthRecoveryFixture(true, false);
  await startAutomaticAuthRecoveryFixture(fixture);
  fixture.rejectNextMembership();

  const observation = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("A"),
  );
  await fixture.refreshStarted;

  const imageOnly = clipboardPayloadFromPngBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]),
  );
  await fixture.setup.runtime.handleClipboardObservation({
    source: "offscreen",
    target: "service-worker",
    type: "CLIPBOARD_CHANGED",
    payload: imageOnly,
  });
  assert.deepEqual(fixture.encryptedTexts, []);

  fixture.releaseRefresh();
  await readyReplacementSocket(fixture);
  await observation;

  assert.deepEqual(fixture.encryptedTexts, []);
  assert.equal(
    fixture.sockets.every(
      (socket) =>
        socket.emissions.filter(
          (emission) => emission.event === "clipboard:publish",
        ).length === 0,
    ),
    true,
  );
  assert.equal(fixture.getRefreshCalls(), 1);
});

test("automatic publish does not refresh for HTTP 500 or network failure", async () => {
  for (const failure of [500, "network"] as const) {
    let activeFailure: number | "network" | null = null;
    let refreshCalls = 0;
    const setup = await startReady({
      localTrustState: "verified",
      listDevices: async () => {
        if (activeFailure === "network") {
          throw new Error("network unavailable");
        }
        if (typeof activeFailure === "number") {
          throw { response: { status: activeFailure } };
        }
        return response([registeredDevice]);
      },
      refreshTokens: async () => {
        refreshCalls += 1;
        return response(refreshedSession("unexpected-refresh"));
      },
    });

    activeFailure = failure;
    await setup.runtime.handleClipboardObservation(
      clipboardObservation(`failure-${failure}`),
    );

    assert.equal(refreshCalls, 0);
    assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, true);
    assert.equal(setup.runtime.getStatus().lastAutoSyncError?.code, "SOCKET_PUBLISH_FAILED");
  }
});

test("automatic publish does not refresh for non-auth HTTP 403", async () => {
  let refreshCalls = 0;
  let rejectMembership = false;
  const setup = await startReady({
    localTrustState: "verified",
    listDevices: async () => {
      if (rejectMembership) throw { response: { status: 403 } };
      return response([registeredDevice]);
    },
    refreshTokens: async () => {
      refreshCalls += 1;
      return response(refreshedSession("unexpected-refresh"));
    },
  });

  rejectMembership = true;
  await setup.runtime.handleClipboardObservation(
    clipboardObservation("forbidden"),
  );

  assert.equal(refreshCalls, 0);
  assert.equal(setup.runtime.getStatus().socket.deviceAuthenticated, true);
  assert.equal(setup.runtime.getStatus().lastAutoSyncError?.code, "SOCKET_PUBLISH_FAILED");
});

test("Send Off during automatic auth recovery prevents publish and replay after re-enable", async () => {
  const fixture = automaticAuthRecoveryFixture(true, true);
  await startAutomaticAuthRecoveryFixture(fixture);
  fixture.rejectNextMembership();

  const observation = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("A"),
  );
  await fixture.refreshStarted;
  const latestObservation = fixture.setup.runtime.handleClipboardObservation(
    clipboardObservation("B"),
  );
  const disabled = await fixture.setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: false,
      receiveEnabled: true,
    }),
  );
  assert.equal(disabled.ok, true);

  fixture.releaseRefresh();
  await readyReplacementSocket(fixture);
  await Promise.all([observation, latestObservation]);
  fixture.releaseWatcherRestart();

  assert.deepEqual(fixture.encryptedTexts, []);
  assert.equal(
    fixture.setup.runtime.getStatus().lastAutoSyncError?.code,
    "CLIPBOARD_SEND_DISABLED",
  );

  const reenabled = await fixture.setup.runtime.handleMessage(
    runtimeMessage({
      type: "runtime:set-sync-preferences",
      sendEnabled: true,
      receiveEnabled: true,
    }),
  );
  assert.equal(reenabled.ok, true);
  await waitForRuntimeCondition(
    () => fixture.setup.runtime.getStatus().clipboardWatch === "watching",
    "clipboard watcher did not restart after re-enable",
  );
  assert.deepEqual(fixture.encryptedTexts, []);
  assert.deepEqual(
    fixture.watchCalls.filter((call) => call.type === "start"),
    [
      { type: "start", resetBaseline: true },
      { type: "start", resetBaseline: true },
    ],
  );
});
