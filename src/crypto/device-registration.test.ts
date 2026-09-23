import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AxiosResponse } from "axios";
import { CLIPBOARD_RECEIVE_CAPABILITIES } from "../clipboard/capabilities.ts";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import {
  pairingFingerprint,
  signDeviceApproval,
  signSocketChallenge,
} from "./crypto-core.ts";
import { buildDeviceManagementMessage, buildDeviceRecoveryMessage } from "./protocol.ts";
import {
  registerCurrentDevice,
  recoverCurrentDevice,
  parseRecoveryCredential,
  type DeviceRegistrationApi,
  type DeviceRegistrationRequest,
  type RegisteredDeviceResponse,
} from "./device-registration.ts";
import {
  createDeviceIdentityForTesting,
  exportRecoveryPrivateKey,
  getDeviceIdentity,
  getPrivateKeyHandles,
  RecoveryCredentialSealedError,
  sealRecoveryCredential,
  type StoredIdentityRecord,
} from "./key-store.ts";
import { IDENTITY_STORE, TRUST_DEVICE_STORE } from "./storage.ts";
import { InMemoryTrustStore, IndexedDBTrustStore } from "./trust-store.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const localDeviceId = "00000000-0000-4000-8000-000000000001";
const approverDeviceId = "00000000-0000-4000-8000-000000000002";

test("a recovery credential survives CRLF line endings and surrounding whitespace", async () => {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const saved = `\r\n  copyyt-recovery-v1 \r\nrootDeviceId=${localDeviceId}\r\nprivateKeyPkcs8Base64=${pkcs8}  \r\n\r\n`;
  const parsed = await parseRecoveryCredential(saved);
  assert.equal(parsed.rootDeviceId, localDeviceId);
  await assert.rejects(parseRecoveryCredential("copyyt-recovery-v1\nrootDeviceId=x"), /format is invalid/);
});

test("device-management message matches the backend canonical vector", () => {
  assert.equal(
    new TextDecoder().decode(
      buildDeviceManagementMessage({
        action: "update",
        userId,
        requestingDeviceId: localDeviceId,
        requestingKeyVersion: 9,
        targetDeviceId: localDeviceId,
        targetKeyVersion: 9,
        timestamp: 1700000000000,
        nonce: "00000000-0000-4000-8000-000000000009",
        name: "Copyyt Chrome",
        platform: "chrome",
        capabilities: ["clipboard", "clipboard-html-v1"],
        appVersion: "2.0.1",
        recoveryPublicKey: "",
      }),
    ),
    "27:copyyt-device-management-v113:action=update43:userId=11111111-1111-4111-8111-11111111111155:requestingDeviceId=00000000-0000-4000-8000-00000000000122:requestingKeyVersion=951:targetDeviceId=00000000-0000-4000-8000-00000000000118:targetKeyVersion=923:timestamp=170000000000042:nonce=00000000-0000-4000-8000-00000000000918:name=Copyyt Chrome15:platform=chrome46:capabilities=[\"clipboard\",\"clipboard-html-v1\"]16:appVersion=2.0.118:recoveryPublicKey=",
  );
});

test("recovery canonical fields are length-prefixed and delimiters cannot alias", () => {
  const base = {
    userId,
    rootDeviceId: localDeviceId,
    deviceId: approverDeviceId,
    name: "name=with\nseparator",
    platform: "chrome",
    encryptionPublicKey: bytesToBase64(new Uint8Array(32).fill(1)),
    signingPublicKey: bytesToBase64(new Uint8Array(32).fill(2)),
    capabilities: ["clipboard"],
    timestamp: 1700000000000,
    nonce: "00000000-0000-4000-8000-000000000009",
    newRecoveryPublicKey: bytesToBase64(new Uint8Array(32).fill(3)),
  } as const;
  const first = new TextDecoder().decode(buildDeviceRecoveryMessage({
    userId,
    rootDeviceId: localDeviceId,
    deviceId: approverDeviceId,
    name: base.name,
    platform: base.platform,
    encryptionPublicKey: base.encryptionPublicKey,
    signingPublicKey: base.signingPublicKey,
    capabilities: [...base.capabilities],
    appVersion: "1=2",
    timestamp: base.timestamp,
    nonce: base.nonce,
    newRecoveryPublicKey: base.newRecoveryPublicKey,
  }));
  const second = new TextDecoder().decode(buildDeviceRecoveryMessage({
    userId,
    rootDeviceId: localDeviceId,
    deviceId: approverDeviceId,
    name: "name=with",
    platform: "\nseparator",
    encryptionPublicKey: base.encryptionPublicKey,
    signingPublicKey: base.signingPublicKey,
    capabilities: [...base.capabilities],
    appVersion: "1=2",
    timestamp: base.timestamp,
    nonce: base.nonce,
    newRecoveryPublicKey: base.newRecoveryPublicKey,
  }));
  assert.notEqual(first, second);
  assert.match(first, /24:name=name=with\nseparator/);
});

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
  assert.equal(requests[0]!.recoveryPublicKey, originalIdentity.recoveryPublicKeyBase64);
  assert.equal(requests[0]!.requestingDeviceId, originalIdentity.deviceId);
  assert.equal(requests[0]!.requestingKeyVersion, originalIdentity.keyVersion);
  assert.ok(requests[0]!.managementTimestamp);
  assert.ok(requests[0]!.managementNonce);
  assert.ok(requests[0]!.managementSignature);
  const managementPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    base64ToBytes(originalIdentity.signingPublicKeyBase64),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  assert.equal(
    await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      managementPublicKey,
      base64ToBytes(requests[0]!.managementSignature!),
      buildDeviceManagementMessage({
        action: "update",
        userId,
        requestingDeviceId: originalIdentity.deviceId,
        requestingKeyVersion: originalIdentity.keyVersion!,
        targetDeviceId: originalIdentity.deviceId,
        targetKeyVersion: originalIdentity.keyVersion!,
        timestamp: requests[0]!.managementTimestamp!,
        nonce: requests[0]!.managementNonce!,
        name: requests[0]!.name,
        platform: requests[0]!.platform,
        capabilities: requests[0]!.capabilities,
        appVersion: requests[0]!.appVersion,
        recoveryPublicKey: requests[0]!.recoveryPublicKey,
      }),
    ),
    true,
  );
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
    assert.equal(getPrivateKeyHandles(refreshed).recoveryPrivateKey?.extractable, true);
    assert.equal(refreshed.recoveryPublicKeyBase64.length > 0, true);
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

test("sealing an exported recovery credential deletes the private key but keeps the public key", async (context) => {
  installIdentityDatabase(context, await storedIdentity(localDeviceId, 3));
  const identity = await getDeviceIdentity(userId);
  assert.ok(identity);
  const recoveryPublicKey = identity.recoveryPublicKeyBase64;
  assert.ok((await exportRecoveryPrivateKey(identity)).length > 0);
  // Exporting alone does not seal: a popup closed before copying can retry.
  assert.equal(identity.recoveryExportedAt, null);

  const sealed = await sealRecoveryCredential(identity);
  assert.equal(typeof sealed.recoveryExportedAt, "string");
  assert.equal(getPrivateKeyHandles(sealed).recoveryPrivateKey, undefined);
  await assert.rejects(exportRecoveryPrivateKey(sealed), RecoveryCredentialSealedError);

  const reloaded = await getDeviceIdentity(userId);
  assert.ok(reloaded);
  assert.equal(
    reloaded.recoveryPublicKeyBase64,
    recoveryPublicKey,
    "a sealed record must not regenerate a recovery pair the server does not know",
  );
  assert.equal(reloaded.recoveryExportedAt, sealed.recoveryExportedAt);
  assert.equal(getPrivateKeyHandles(reloaded).recoveryPrivateKey, undefined);
  await assert.rejects(exportRecoveryPrivateKey(reloaded), RecoveryCredentialSealedError);
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

test("offline recovery rotates the credential and replaces stale local roots", async (context) => {
  const record = await storedIdentity(localDeviceId, 9);
  installIdentityDatabase(context, record);
  const identity = await getDeviceIdentity(userId);
  assert.ok(identity);
  const oldPrivateKey = await exportRecoveryPrivateKey(identity);
  const oldRecoveryPublicKey = identity.recoveryPublicKeyBase64;
  const trustStore = new InMemoryTrustStore();
  const staleDeviceId = "00000000-0000-4000-8000-000000000003";
  const staleIdentity = await createDeviceIdentityForTesting({
    userId,
    deviceId: staleDeviceId,
    keyVersion: 2,
    signingPrivateKey: (await globalThis.crypto.subtle.generateKey(
      { name: "Ed25519" }, false, ["sign", "verify"],
    ) as CryptoKeyPair).privateKey,
    signingPublicKey: (await globalThis.crypto.subtle.generateKey(
      { name: "Ed25519" }, false, ["sign", "verify"],
    ) as CryptoKeyPair).publicKey,
    encryptionPrivateKey: (await globalThis.crypto.subtle.generateKey(
      { name: "X25519" }, false, ["deriveBits"],
    ) as CryptoKeyPair).privateKey,
    encryptionPublicKey: (await globalThis.crypto.subtle.generateKey(
      { name: "X25519" }, false, ["deriveBits"],
    ) as CryptoKeyPair).publicKey,
  });
  await trustStore.bootstrapInitialTrustAnchor(userId, staleIdentity);
  await trustStore.upsertServerReportedDevice({
    userId,
    deviceId: identity.deviceId,
    keyVersion: identity.keyVersion!,
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    trustState: "pending",
  });

  let request: Parameters<DeviceRegistrationApi["recoverDevice"]>[0] | undefined;
  const api: DeviceRegistrationApi = {
    async registerDevice() { throw new Error("not used"); },
    async listPendingDevices() { throw new Error("not used"); },
    async approveDevice() { throw new Error("not used"); },
    async recoverDevice(input) {
      request = input;
      return {
        data: {
          deviceId: identity.deviceId,
          name: "Recovered Chrome",
          platform: "chrome",
          encryptionPublicKey: identity.encryptionPublicKeyBase64,
          signingPublicKey: identity.signingPublicKeyBase64,
          trustState: "trusted",
          keyVersion: 10,
          capabilities: ["clipboard"],
          appVersion: "2.0.1",
        },
      } as unknown as AxiosResponse<RegisteredDeviceResponse>;
    },
  };
  const credential = [
    "copyyt-recovery-v1",
    `rootDeviceId=${identity.deviceId}`,
    `privateKeyPkcs8Base64=${oldPrivateKey}`,
  ].join("\n");
  const result = await recoverCurrentDevice(api, {
    userId,
    name: "Recovered Chrome",
    appVersion: "2.0.1",
    capabilities: ["clipboard"],
    credential,
    trustStore,
  });
  assert.ok(request);
  const recoveryRequest = request;
  // Exactly the backend RecoverDeviceDto fields; it rejects anything else (HTTP 400).
  assert.deepEqual(Object.keys(recoveryRequest).sort(), [
    "appVersion", "capabilities", "deviceId", "encryptionPublicKey", "name", "newRecoveryPublicKey",
    "nonce", "platform", "rootDeviceId", "signature", "signingPublicKey", "timestamp",
  ]);
  const oldPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    base64ToBytes(oldRecoveryPublicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  assert.equal(
    await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      oldPublicKey,
      base64ToBytes(recoveryRequest.signature),
      buildDeviceRecoveryMessage({ ...recoveryRequest, userId }),
    ),
    true,
  );
  assert.notEqual(recoveryRequest.newRecoveryPublicKey, oldRecoveryPublicKey);
  assert.equal(result.identity.recoveryPublicKeyBase64, recoveryRequest.newRecoveryPublicKey);
  assert.equal((await trustStore.getDevice(userId, identity.deviceId))?.trustOrigin, "recovery");
  assert.equal((await trustStore.getDevice(userId, staleDeviceId))?.trustState, "revoked");
  assert.deepEqual(
    (await trustStore.listEncryptionRecipients(userId)).map((device) => device.deviceId),
    [identity.deviceId],
  );
  assert.notEqual(await exportRecoveryPrivateKey(result.identity), oldPrivateKey);
});

test("recovery rejects malformed credentials and does not rotate on backend failure", async (context) => {
  const record = await storedIdentity(localDeviceId, 9);
  installIdentityDatabase(context, record);
  const identity = await getDeviceIdentity(userId);
  assert.ok(identity);
  await assert.rejects(() => parseRecoveryCredential("copyyt-recovery-v1\nrootDeviceId=x\nprivateKeyPkcs8Base64=x\nextra"));
  const oldPublicKey = identity.recoveryPublicKeyBase64;
  const credential = [
    "copyyt-recovery-v1",
    `rootDeviceId=${identity.deviceId}`,
    `privateKeyPkcs8Base64=${await exportRecoveryPrivateKey(identity)}`,
  ].join("\n");
  const api: DeviceRegistrationApi = {
    async registerDevice() { throw new Error("not used"); },
    async listPendingDevices() { throw new Error("not used"); },
    async approveDevice() { throw new Error("not used"); },
    async recoverDevice() { throw new Error("recovery rejected"); },
  };
  await assert.rejects(() => recoverCurrentDevice(api, {
    userId,
    name: "Chrome",
    appVersion: "2.0.1",
    credential,
  }), /recovery rejected/);
  assert.equal((await getDeviceIdentity(userId))?.recoveryPublicKeyBase64, oldPublicKey);
});

test("recovery keeps the imported credential when the backend reports rotation pending", async (context) => {
  const record = await storedIdentity(localDeviceId, 9);
  installIdentityDatabase(context, record);
  const identity = await getDeviceIdentity(userId);
  assert.ok(identity);
  const oldPrivateKey = await exportRecoveryPrivateKey(identity);
  const api: DeviceRegistrationApi = {
    async registerDevice() { throw new Error("not used"); },
    async listPendingDevices() { throw new Error("not used"); },
    async approveDevice() { throw new Error("not used"); },
    async recoverDevice() {
      return {
        data: {
          deviceId: identity.deviceId,
          name: "Recovered Chrome",
          platform: "chrome",
          encryptionPublicKey: identity.encryptionPublicKeyBase64,
          signingPublicKey: identity.signingPublicKeyBase64,
          trustState: "trusted",
          keyVersion: 10,
          capabilities: ["clipboard"],
          recoveryKeyRotated: false,
        },
      } as unknown as AxiosResponse<RegisteredDeviceResponse>;
    },
  };
  const result = await recoverCurrentDevice(api, {
    userId,
    name: "Recovered Chrome",
    appVersion: "2.0.1",
    credential: [
      "copyyt-recovery-v1",
      `rootDeviceId=${identity.deviceId}`,
      `privateKeyPkcs8Base64=${oldPrivateKey}`,
    ].join("\n"),
  });
  assert.equal(result.recoveryKeyRotated, false);
  assert.equal(await exportRecoveryPrivateKey(result.identity), oldPrivateKey);
});

test("durable recovery trust transition survives a store reload", async (context) => {
  const record = await storedIdentity(localDeviceId, 9);
  installIdentityDatabase(context, record);
  const identity = await getDeviceIdentity(userId);
  assert.ok(identity);
  const trustStore = new IndexedDBTrustStore();
  await trustStore.upsertServerReportedDevice({
    userId,
    deviceId: identity.deviceId,
    keyVersion: identity.keyVersion!,
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    trustState: "pending",
  });
  const recovered = await trustStore.recoverTrustAnchor(userId, identity, {
    name: "Recovered Chrome",
    platform: "chrome",
  });
  assert.equal(recovered.trustOrigin, "recovery");
  const reloaded = await new IndexedDBTrustStore().getDevice(userId, identity.deviceId);
  assert.equal(reloaded?.trustState, "root");
  assert.equal(reloaded?.trustOrigin, "recovery");
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
      } as unknown as AxiosResponse<RegisteredDeviceResponse>;
    },
    async listPendingDevices() {
      throw new Error("Metadata refresh must not start pairing");
    },
    async approveDevice() {
      throw new Error("Metadata refresh must not request a new approval");
    },
    async recoverDevice() {
      throw new Error("Metadata refresh must not request recovery");
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
