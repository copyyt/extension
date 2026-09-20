import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AxiosResponse } from "axios";
import { CLIPBOARD_RECEIVE_CAPABILITIES } from "../clipboard/capabilities.ts";
import { bytesToBase64 } from "./bytes.ts";
import {
  pairingFingerprint,
  signDeviceApproval,
  signSocketChallenge,
} from "./crypto-core.ts";
import {
  registerCurrentDevice,
  type DeviceRegistrationApi,
  type DeviceRegistrationRequest,
  type RegisteredDeviceResponse,
} from "./device-registration.ts";
import {
  createDeviceIdentityForTesting,
  getDeviceIdentity,
  getPrivateKeyHandles,
  type StoredIdentityRecord,
} from "./key-store.ts";
import { IDENTITY_STORE, TRUST_DEVICE_STORE } from "./storage.ts";
import { IndexedDBTrustStore } from "./trust-store.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const localDeviceId = "00000000-0000-4000-8000-000000000001";
const approverDeviceId = "00000000-0000-4000-8000-000000000002";

test("registration refresh advertises assisted PNG receive support and preserves identity, keys, and pairing", async (context) => {
  const record = await storedIdentity(localDeviceId, 9);
  const approverRecord = await storedIdentity(approverDeviceId, 4);
  installIdentityDatabase(context, record);
  const originalIdentity = await getDeviceIdentity(userId);
  assert.ok(originalIdentity);
  const approverIdentity = await createDeviceIdentityForTesting({
    ...approverRecord,
    keyVersion: approverRecord.registration!.keyVersion,
  });
  const trustStore = new IndexedDBTrustStore();
  for (const identity of [originalIdentity, approverIdentity]) {
    await trustStore.upsertServerReportedDevice({
      userId,
      deviceId: identity.deviceId,
      keyVersion: identity.keyVersion!,
      encryptionPublicKey: identity.encryptionPublicKeyBase64,
      signingPublicKey: identity.signingPublicKeyBase64,
      capabilities: ["clipboard"],
      trustState: "trusted",
    });
  }
  const pendingDevice = {
    pendingDeviceId: originalIdentity.deviceId,
    pendingKeyVersion: originalIdentity.keyVersion!,
    pendingEncryptionPublicKey: originalIdentity.encryptionPublicKeyBase64,
    pendingSigningPublicKey: originalIdentity.signingPublicKeyBase64,
  };
  const fingerprint = await pairingFingerprint({
    userId,
    approvingDeviceId: approverIdentity.deviceId,
    approvingKeyVersion: approverIdentity.keyVersion!,
    approvingEncryptionPublicKey: approverIdentity.encryptionPublicKeyBase64,
    approvingSigningPublicKey: approverIdentity.signingPublicKeyBase64,
    ...pendingDevice,
  });
  await trustStore.pinPairedApprover(userId, originalIdentity, approverDeviceId, fingerprint);
  await trustStore.applyApproval(userId, {
    approvingDeviceId: approverIdentity.deviceId,
    approvingKeyVersion: approverIdentity.keyVersion!,
    ...pendingDevice,
    approvalSignature: await signDeviceApproval({
      userId,
      approvingIdentity: approverIdentity,
      pendingDevice,
    }),
  });
  const trustedBefore = await trustStore.getDevice(userId, localDeviceId);
  const pairingBefore = await trustStore.getDevice(userId, approverDeviceId);
  assert.equal(trustedBefore?.trustState, "verified");
  assert.equal(pairingBefore?.trustOrigin, "pairing");

  const socketChallenge = { userId, socketId: "registration-refresh", challenge: "AQIDBA==" };
  const signatureBefore = await signSocketChallenge({ ...socketChallenge, identity: originalIdentity });
  const sharedSecretBefore = await globalThis.crypto.subtle.deriveBits(
    { name: "X25519", public: approverRecord.encryptionPublicKey },
    getPrivateKeyHandles(originalIdentity).encryptionPrivateKey,
    256,
  );
  const requests: DeviceRegistrationRequest[] = [];
  const { identity, device } = await registerCurrentDevice(registrationApi(requests, 9), {
    userId,
    name: "Chrome after capability update",
    appVersion: "2.0.1",
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
    trustStore,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
  assert.deepEqual(device.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
  assert.notEqual(requests[0]!.capabilities, CLIPBOARD_RECEIVE_CAPABILITIES);
  assert.equal(requests[0]!.deviceId, originalIdentity.deviceId);
  assert.equal(requests[0]!.encryptionPublicKey, originalIdentity.encryptionPublicKeyBase64);
  assert.equal(requests[0]!.signingPublicKey, originalIdentity.signingPublicKeyBase64);
  const refreshedApprover = await trustStore.upsertServerReportedDevice({
    userId,
    deviceId: approverIdentity.deviceId,
    keyVersion: approverIdentity.keyVersion!,
    encryptionPublicKey: approverIdentity.encryptionPublicKeyBase64,
    signingPublicKey: approverIdentity.signingPublicKeyBase64,
    name: "Approver after capability update",
    platform: "chrome",
    capabilities: ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
    appVersion: "2.0.2",
    trustState: "trusted",
  });
  assert.equal(refreshedApprover.trustOrigin, pairingBefore?.trustOrigin);
  assert.equal(refreshedApprover.pairedForDeviceId, pairingBefore?.pairedForDeviceId);
  assert.equal(refreshedApprover.pairingFingerprint, pairingBefore?.pairingFingerprint);
  assert.equal(refreshedApprover.pinnedAt, pairingBefore?.pinnedAt);
  assert.deepEqual(refreshedApprover.capabilities, ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"]);
  for (const changed of [
    { signingPublicKey: bytesToBase64(new Uint8Array(32).fill(9)) },
    { encryptionPublicKey: bytesToBase64(new Uint8Array(32).fill(9)) },
    { keyVersion: originalIdentity.keyVersion! + 1 },
  ]) {
    await assert.rejects(
      trustStore.upsertServerReportedDevice({
        userId,
        deviceId: originalIdentity.deviceId,
        keyVersion: originalIdentity.keyVersion!,
        encryptionPublicKey: originalIdentity.encryptionPublicKeyBase64,
        signingPublicKey: originalIdentity.signingPublicKeyBase64,
        ...changed,
        capabilities: ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"],
        trustState: "trusted",
      }),
    );
  }

  // Reload from persistence, so this also covers metadata surviving a new runtime.
  const persistedIdentity = await getDeviceIdentity(userId);
  assert.ok(persistedIdentity);
  for (const refreshed of [identity, persistedIdentity]) {
    assert.equal(refreshed.deviceId, originalIdentity.deviceId);
    assert.equal(refreshed.keyVersion, originalIdentity.keyVersion);
    assert.deepEqual(refreshed.encryptionPublicKey, originalIdentity.encryptionPublicKey);
    assert.deepEqual(refreshed.signingPublicKey, originalIdentity.signingPublicKey);
    assert.equal(refreshed.registration?.name, "Chrome after capability update");
    assert.deepEqual(refreshed.registration?.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
    assert.equal(
      await signSocketChallenge({ ...socketChallenge, identity: refreshed }),
      signatureBefore,
      "the signing private key must remain unchanged",
    );
    assert.deepEqual(
      await globalThis.crypto.subtle.deriveBits(
        { name: "X25519", public: approverRecord.encryptionPublicKey },
        getPrivateKeyHandles(refreshed).encryptionPrivateKey,
        256,
      ),
      sharedSecretBefore,
      "the encryption private key must remain unchanged",
    );
    assert.equal(getPrivateKeyHandles(refreshed).signingPrivateKey.extractable, false);
    assert.equal(getPrivateKeyHandles(refreshed).encryptionPrivateKey.extractable, false);
  }
  const reloadedTrustStore = new IndexedDBTrustStore();
  const refreshedLocal = await reloadedTrustStore.getDevice(userId, localDeviceId);
  assert.equal(refreshedLocal?.trustState, trustedBefore?.trustState);
  assert.equal(refreshedLocal?.trustOrigin, trustedBefore?.trustOrigin);
  assert.deepEqual(refreshedLocal?.approvalCertificate, trustedBefore?.approvalCertificate);
  assert.equal(refreshedLocal?.pairedForDeviceId, trustedBefore?.pairedForDeviceId);
  assert.equal(refreshedLocal?.pairingFingerprint, trustedBefore?.pairingFingerprint);
  assert.equal(refreshedLocal?.pinnedAt, trustedBefore?.pinnedAt);
  assert.deepEqual(refreshedLocal?.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
  const reloadedApprover = await reloadedTrustStore.getDevice(userId, approverDeviceId);
  assert.equal(reloadedApprover?.trustState, pairingBefore?.trustState);
  assert.equal(reloadedApprover?.trustOrigin, pairingBefore?.trustOrigin);
  assert.equal(reloadedApprover?.pairedForDeviceId, pairingBefore?.pairedForDeviceId);
  assert.equal(reloadedApprover?.pairingFingerprint, pairingBefore?.pairingFingerprint);
  assert.equal(reloadedApprover?.pinnedAt, pairingBefore?.pinnedAt);
  assert.deepEqual(reloadedApprover?.capabilities, ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"]);
  assert.equal((await reloadedTrustStore.listEncryptionRecipients(userId)).length, 2);
});

test("registration capabilities and server trust labels do not establish local trust", async (context) => {
  installIdentityDatabase(context, await storedIdentity(localDeviceId, 9));
  const trustStore = new IndexedDBTrustStore();
  const requests: DeviceRegistrationRequest[] = [];
  await registerCurrentDevice(registrationApi(requests, 9), {
    userId,
    name: "Unpaired Chrome",
    appVersion: "2.0.1",
    capabilities: [...CLIPBOARD_RECEIVE_CAPABILITIES],
    trustStore,
  });

  assert.deepEqual(requests[0]!.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
  const local = await trustStore.getDevice(userId, localDeviceId);
  assert.deepEqual(local?.capabilities, [...CLIPBOARD_RECEIVE_CAPABILITIES]);
  assert.equal(local?.trustState, "unverified");
  assert.equal(local?.trustOrigin, undefined);
  assert.equal(local?.approvalCertificate, undefined);
  assert.equal(local?.pairingFingerprint, undefined);
  assert.deepEqual(await trustStore.listEncryptionRecipients(userId), []);
});

function registrationApi(
  requests: DeviceRegistrationRequest[],
  keyVersion: number,
): DeviceRegistrationApi {
  return {
    async registerDevice(request) {
      requests.push(request);
      return {
        data: { ...request, keyVersion, trustState: "trusted" },
      } as AxiosResponse<RegisteredDeviceResponse>;
    },
    async listPendingDevices() {
      throw new Error("Metadata refresh must not start pairing");
    },
    async approveDevice() {
      throw new Error("Metadata refresh must not request a new approval");
    },
  };
}

async function storedIdentity(deviceId: string, keyVersion: number): Promise<StoredIdentityRecord> {
  const signing = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" }, false, ["sign", "verify"],
  ) as CryptoKeyPair;
  const encryption = await globalThis.crypto.subtle.generateKey(
    { name: "X25519" }, false, ["deriveBits"],
  ) as CryptoKeyPair;
  return {
    schemaVersion: 1,
    userId,
    deviceId,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKeyBase64: bytesToBase64(new Uint8Array(
      await globalThis.crypto.subtle.exportKey("raw", signing.publicKey),
    )),
    encryptionPublicKeyBase64: bytesToBase64(new Uint8Array(
      await globalThis.crypto.subtle.exportKey("raw", encryption.publicKey),
    )),
    registration: {
      keyVersion,
      name: "Existing Chrome",
      platform: "chrome",
      capabilities: ["clipboard"],
      appVersion: "2.0.1",
    },
  };
}

/** Narrow asynchronous IndexedDB fixture for the real identity and trust stores. */
function installIdentityDatabase(context: TestContext, record: StoredIdentityRecord): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const stores = new Map<string, Map<IDBValidKey, unknown>>([
    [IDENTITY_STORE, new Map([[record.userId, structuredClone(record)]])],
    [TRUST_DEVICE_STORE, new Map()],
  ]);
  const database = {
    close() {},
    transaction(storeNames: string | string[]) {
      let pending = 0;
      let settled = false;
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort() {
          settled = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore(name: string) {
          assert.ok([storeNames].flat().includes(name));
          const values = stores.get(name);
          assert.ok(values);
          const request = <T>(operation: () => T) => {
            pending += 1;
            const result = { result: undefined as T | undefined, onsuccess: null as (() => void) | null };
            queueMicrotask(() => {
              if (settled) return;
              result.result = operation();
              result.onsuccess?.();
              pending -= 1;
              queueMicrotask(() => {
                if (!settled && pending === 0) {
                  settled = true;
                  transaction.oncomplete?.();
                }
              });
            });
            return result;
          };
          return {
            get: (key: IDBValidKey) => request(() => structuredClone(values.get(key))),
            getAll: () => request(() => structuredClone([...values.values()])),
            put: (value: unknown, key: IDBValidKey) => request(() => {
              values.set(key, structuredClone(value));
              return key;
            }),
            add() {
              assert.fail("Registration metadata refresh must reuse the existing identity");
            },
          };
        },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
}
