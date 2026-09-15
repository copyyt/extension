import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import test from "node:test";
import {
  asBufferSource,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  utf8Encode,
} from "./bytes.ts";
import {
  createDeviceIdentityForTesting,
  type DeviceIdentity,
} from "./key-store.ts";
import {
  decryptClipboardItem,
  encryptClipboardItem,
  pairingFingerprint,
  signDeviceApproval,
  signSocketChallenge,
  unwrapContentKeyForRecipient,
  verifyClipboardEnvelopeSignature,
  verifyDeviceApproval,
  wrapContentKeyForRecipient,
} from "./crypto-core.ts";
import {
  buildClipboardEnvelopeSignatureMessage,
  buildDeviceApprovalMessage,
  buildKeyWrapContext,
  buildPayloadAad,
  buildSocketAuthMessage,
} from "./protocol.ts";
import type { ClientVerifiedDevice } from "./trust-store.ts";
import { InMemoryTrustStore } from "./trust-store.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceAId = "00000000-0000-4000-8000-000000000001";
const deviceBId = "00000000-0000-4000-8000-000000000002";
const itemId = "22222222-2222-4222-8222-222222222222";
const expiresAt = "2030-01-01T00:00:00.000Z";
const ed25519Seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const x25519Scalar = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");

test("golden canonical protocol vectors have exact UTF-8 bytes", async () => {
  const signingPublicKey = bytesToBase64(new Uint8Array(32).fill(2));
  const encryptionPublicKey = bytesToBase64(new Uint8Array(32).fill(3));
  assert.equal(
    new TextDecoder().decode(
      buildDeviceApprovalMessage({
        userId,
        approvingDeviceId: deviceAId,
        approvingKeyVersion: 4,
        pendingDeviceId: deviceBId,
        pendingKeyVersion: 9,
        pendingEncryptionPublicKey: encryptionPublicKey,
        pendingSigningPublicKey: signingPublicKey,
      }),
    ),
    "copyyt-device-approval-v1\n" +
      `userId=${userId}\n` +
      `approvingDeviceId=${deviceAId}\n` +
      "approvingKeyVersion=4\n" +
      `pendingDeviceId=${deviceBId}\n` +
      "pendingKeyVersion=9\n" +
      `pendingEncryptionPublicKey=${encryptionPublicKey}\n` +
      `pendingSigningPublicKey=${signingPublicKey}\n`,
  );

  assert.equal(
    new TextDecoder().decode(
      buildSocketAuthMessage({
        userId,
        deviceId: deviceAId,
        keyVersion: 4,
        socketId: "socket-123",
        challenge: "AQIDBA==",
      }),
    ),
    "copyyt-socket-auth-v1\n" +
      `userId=${userId}\n` +
      `deviceId=${deviceAId}\n` +
      "keyVersion=4\n" +
      "socketId=socket-123\n" +
      "challenge=AQIDBA==\n",
  );

  assert.equal(
    new TextDecoder().decode(
      buildKeyWrapContext({
        userId,
        protocolVersion: 1,
        itemId,
        sourceDeviceId: deviceAId,
        sourceKeyVersion: 4,
        recipientDeviceId: deviceBId,
        recipientKeyVersion: 9,
      }),
    ),
    "copyyt-key-wrap-v1\n" +
      `userId=${userId}\n` +
      "protocolVersion=1\n" +
      `itemId=${itemId}\n` +
      `sourceDeviceId=${deviceAId}\n` +
      "sourceKeyVersion=4\n" +
      `recipientDeviceId=${deviceBId}\n` +
      "recipientKeyVersion=9\n",
  );

  assert.equal(
    new TextDecoder().decode(
      buildPayloadAad({
        userId,
        protocolVersion: 1,
        itemId,
        sourceDeviceId: deviceAId,
        sourceKeyVersion: 4,
        contentType: "text/plain",
        expiresAt,
      }),
    ),
    "copyyt-payload-v1\n" +
      `userId=${userId}\n` +
      "protocolVersion=1\n" +
      `itemId=${itemId}\n` +
      `sourceDeviceId=${deviceAId}\n` +
      "sourceKeyVersion=4\n" +
      "contentType=text/plain\n" +
      `expiresAt=${expiresAt}\n`,
  );

  const envelope = await buildClipboardEnvelopeSignatureMessage({
    userId,
    protocolVersion: 1,
    itemId,
    sourceDeviceId: deviceAId,
    sourceKeyVersion: 4,
    contentType: "text/plain",
    nonce: new Uint8Array(12).fill(7),
    ciphertext: utf8Encode("ciphertext bytes"),
    expiresAt,
  });
  assert.equal(
    new TextDecoder().decode(envelope),
    "copyyt-clipboard-envelope-v1\n" +
      `userId=${userId}\n` +
      "protocolVersion=1\n" +
      `itemId=${itemId}\n` +
      `sourceDeviceId=${deviceAId}\n` +
      "sourceKeyVersion=4\n" +
      "contentType=text/plain\n" +
      "nonce=BwcHBwcHBwcHBwcH\n" +
      "ciphertextSha256=S1Zw8jssnwWFLRm1b1jfOf86iofvgbHx+P2O0+/cYnA=\n" +
      `expiresAt=${expiresAt}\n`,
  );
});

test("fixed identities encrypt, wrap, sign, verify, unwrap, and decrypt", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const recipientB = verifiedDevice(identityB);
  const randomValues = [
    new Uint8Array(32).fill(0x11),
    new Uint8Array(12).fill(0x22),
    new Uint8Array(12).fill(0x33),
  ];
  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext: "hello from Copyyt",
    contentType: "text/plain",
    expiresAt,
    itemId,
    recipients: [recipientB],
    randomBytes: (length) => {
      const next = randomValues.shift();
      assert.ok(next);
      assert.equal(next.length, length);
      return next;
    },
  });

  assert.equal(envelope.nonce, bytesToBase64(new Uint8Array(12).fill(0x22)));
  assert.equal(envelope.recipients[0]?.wrapNonce, bytesToBase64(new Uint8Array(12).fill(0x33)));
  assert.equal(
    await verifyClipboardEnvelopeSignature({
      userId,
      envelope,
      sourceSigningPublicKey: identityA.signingPublicKey,
    }),
    true,
  );
  const decrypted = await decryptClipboardItem({
    userId,
    identity: identityB,
    sourceDevice: verifiedDevice(identityA),
    envelope,
  });
  assert.equal(decrypted.plaintext, "hello from Copyyt");
  assert.equal(bytesToHex(decrypted.plaintextBytes), bytesToHex(utf8Encode("hello from Copyyt")));
});

test("negative cases reject before plaintext is returned", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext: "secret",
    contentType: "text/plain",
    expiresAt,
    itemId,
    recipients: [verifiedDevice(identityB)],
    randomBytes: (length) => new Uint8Array(length).fill(0x44),
  });

  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityA,
      sourceDevice: verifiedDevice(identityA),
      envelope,
    }),
  );
  await assert.rejects(
    unwrapContentKeyForRecipient({
      userId,
      itemId: "33333333-3333-4333-8333-333333333333",
      sourceDeviceId: deviceAId,
      sourceKeyVersion: 1,
      recipientIdentity: identityB,
      recipientDeviceId: deviceBId,
      recipientKeyVersion: 1,
      sourceEncryptionPublicKey: identityA.encryptionPublicKey,
      wrapNonce: envelope.recipients[0]!.wrapNonce,
      wrappedContentKey: envelope.recipients[0]!.wrappedContentKey,
    }),
  );
  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityB,
      sourceDevice: verifiedDevice(identityA),
      envelope: { ...envelope, contentType: "text/html" },
    }),
  );
  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityB,
      sourceDevice: verifiedDevice(identityA),
      envelope: { ...envelope, ciphertext: bytesToBase64(new Uint8Array(32).fill(9)) },
    }),
  );
  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityB,
      sourceDevice: { ...verifiedDevice(identityA), signingPublicKey: identityB.signingPublicKeyBase64 },
      envelope,
    }),
  );
  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityB,
      sourceDevice: { ...verifiedDevice(identityA), keyVersion: 2 },
      envelope,
    }),
  );
  await assert.rejects(
    encryptClipboardItem({
      userId,
      identity: identityA,
      plaintext: "secret",
      contentType: "text/plain",
      expiresAt,
      itemId,
      recipients: [{ ...verifiedDevice(identityB), trustState: "unverified" } as never],
    }),
  );
});

test("approval, socket signatures, pairing fingerprint, and key wrapping are protocol-bound", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 4);
  const identityB = await makeFixedIdentity(deviceBId, 9, true);
  const pending = {
    pendingDeviceId: deviceBId,
    pendingKeyVersion: 9,
    pendingEncryptionPublicKey: identityB.encryptionPublicKeyBase64,
    pendingSigningPublicKey: identityB.signingPublicKeyBase64,
  };
  const approvalSignature = await signDeviceApproval({
    userId,
    approvingIdentity: identityA,
    pendingDevice: pending,
  });
  const certificate = {
    approvingDeviceId: deviceAId,
    approvingKeyVersion: 4,
    ...pending,
    approvalSignature,
  };
  assert.equal(
    await verifyDeviceApproval({
      userId,
      certificate,
      approverDevice: verifiedDevice(identityA),
    }),
    true,
  );
  assert.equal(
    await verifyDeviceApproval({
      userId,
      certificate: { ...certificate, pendingKeyVersion: 10 },
      approverDevice: verifiedDevice(identityA),
    }),
    false,
  );
  const socketSignature = await signSocketChallenge({
    userId,
    identity: identityA,
    socketId: "socket-123",
    challenge: "AQIDBA==",
  });
  assert.equal(base64ToBytes(socketSignature).length, 64);
  const fingerprint = await pairingFingerprint({
    userId,
    approvingDeviceId: deviceAId,
    approvingSigningPublicKey: identityA.signingPublicKeyBase64,
    pendingDeviceId: deviceBId,
    pendingSigningPublicKey: identityB.signingPublicKeyBase64,
    pendingEncryptionPublicKey: identityB.encryptionPublicKeyBase64,
  });
  assert.match(fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/);

  const wrapped = await wrapContentKeyForRecipient({
    userId,
    itemId,
    sourceDeviceId: deviceAId,
    sourceKeyVersion: 4,
    senderIdentity: identityA,
    recipient: verifiedDevice(identityB),
    contentKey: new Uint8Array(32).fill(0x55),
    wrapNonce: new Uint8Array(12).fill(0x66),
  });
  assert.equal(base64ToBytes(wrapped.wrapNonce).length, 12);
  assert.equal(base64ToBytes(wrapped.wrappedContentKey).length, 48);
  assert.deepEqual(
    await unwrapContentKeyForRecipient({
      userId,
      itemId,
      sourceDeviceId: deviceAId,
      sourceKeyVersion: 4,
      recipientIdentity: identityB,
      recipientDeviceId: deviceBId,
      recipientKeyVersion: 9,
      sourceEncryptionPublicKey: identityA.encryptionPublicKey,
      ...wrapped,
    }),
    new Uint8Array(32).fill(0x55),
  );
});

test("the local trust store does not promote server trust state", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const trustStore = new InMemoryTrustStore();
  trustStore.pinInitialDevice(userId, identityA);
  const reported = trustStore.upsertServerReportedDevice({
    ...verifiedDevice(identityB),
    trustState: "trusted",
  });
  assert.equal(reported.trustState, "unverified");
  assert.deepEqual(
    trustStore.listEncryptionRecipients(userId).map((device) => device.deviceId),
    [deviceAId],
  );
  await assert.rejects(
    encryptClipboardItem({
      userId,
      identity: identityA,
      plaintext: "secret",
      contentType: "text/plain",
      expiresAt,
      itemId,
      recipients: [reported as never],
    }),
  );

  const pending = {
    pendingDeviceId: deviceBId,
    pendingKeyVersion: 1,
    pendingEncryptionPublicKey: identityB.encryptionPublicKeyBase64,
    pendingSigningPublicKey: identityB.signingPublicKeyBase64,
  };
  const certificate = {
    approvingDeviceId: deviceAId,
    approvingKeyVersion: 1,
    ...pending,
    approvalSignature: await signDeviceApproval({
      userId,
      approvingIdentity: identityA,
      pendingDevice: pending,
    }),
  };
  await trustStore.applyApproval(userId, certificate);
  assert.equal(trustStore.getDevice(userId, deviceBId)?.trustState, "verified");
  assert.equal(
    trustStore.upsertServerReportedDevice({
      ...verifiedDevice(identityB),
      trustState: "revoked",
    }).trustState,
    "revoked",
  );
  assert.deepEqual(
    trustStore.listEncryptionRecipients(userId).map((device) => device.deviceId),
    [deviceAId],
  );
});

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16));
}

function pkcs8(prefix: string, raw: Uint8Array): Uint8Array {
  return new Uint8Array([...hex(prefix), ...raw]);
}

async function makeFixedIdentity(deviceId: string, keyVersion: number, variant = false): Promise<DeviceIdentity> {
  const signingSeed = new Uint8Array(ed25519Seed);
  const encryptionScalar = new Uint8Array(x25519Scalar);
  if (variant) {
    signingSeed[0] ^= 1;
    encryptionScalar[0] ^= 1;
  }
  const edPrivateDer = pkcs8("302e020100300506032b657004220420", signingSeed);
  const xPrivateDer = pkcs8("302e020100300506032b656e04220420", encryptionScalar);
  const edPrivateNode = createPrivateKey({ key: Buffer.from(edPrivateDer), format: "der", type: "pkcs8" });
  const xPrivateNode = createPrivateKey({ key: Buffer.from(xPrivateDer), format: "der", type: "pkcs8" });
  const edPublicRaw = new Uint8Array(
    createPublicKey(edPrivateNode).export({ format: "der", type: "spki" }).subarray(-32),
  );
  const xPublicRaw = new Uint8Array(
    createPublicKey(xPrivateNode).export({ format: "der", type: "spki" }).subarray(-32),
  );
  const signingPrivateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    asBufferSource(edPrivateDer),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signingPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(edPublicRaw),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  const encryptionPrivateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    asBufferSource(xPrivateDer),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const encryptionPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(xPublicRaw),
    { name: "X25519" },
    true,
    [],
  );
  return createDeviceIdentityForTesting({
    deviceId,
    keyVersion,
    signingPrivateKey,
    signingPublicKey,
    encryptionPrivateKey,
    encryptionPublicKey,
  });
}

function verifiedDevice(identity: DeviceIdentity): ClientVerifiedDevice {
  return {
    userId,
    deviceId: identity.deviceId,
    keyVersion: identity.keyVersion!,
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    trustState: "verified",
  };
}
