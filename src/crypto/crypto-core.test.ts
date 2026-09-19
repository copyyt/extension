import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import test from "node:test";
import {
  asBufferSource,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  sha256,
  utf8Encode,
} from "./bytes.ts";
import {
  createDeviceIdentityForTesting,
  type DeviceIdentity,
} from "./key-store.ts";
import {
  decryptClipboardItem,
  decryptClipboardItemBytes,
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
  buildPairingFingerprintContext,
  buildSocketAuthMessage,
} from "./protocol.ts";
import type { ClientVerifiedDevice } from "./trust-store.ts";
import { InMemoryTrustStore } from "./trust-store.ts";
import {
  AES_GCM_TAG_BYTES,
  MAX_CLIPBOARD_CIPHERTEXT_BYTES,
  MAX_CLIPBOARD_PLAINTEXT_BYTES,
} from "../clipboard/limits.ts";
import {
  CLIPBOARD_BUNDLE_V1_MIME,
  decodeClipboardBundleV1,
  encodeClipboardBundleV1,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";

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

test("cross-repository golden fixture has mirrored bytes and digests", async () => {
  const goldenUserId = "507f1f77bcf86cd799439011";
  const goldenKey = bytesToBase64(new Uint8Array(32).fill(3));
  const goldenExpiry = "2030-01-01T00:00:00.000Z";
  const vectors = [
    {
      name: "copyyt-device-approval-v1",
      bytes: buildDeviceApprovalMessage({
        userId: goldenUserId,
        approvingDeviceId: deviceAId,
        approvingKeyVersion: 4,
        pendingDeviceId: deviceBId,
        pendingKeyVersion: 9,
        pendingEncryptionPublicKey: goldenKey,
        pendingSigningPublicKey: goldenKey,
      }),
      expected:
        "copyyt-device-approval-v1\n" +
        `userId=${goldenUserId}\n` +
        `approvingDeviceId=${deviceAId}\n` +
        "approvingKeyVersion=4\n" +
        `pendingDeviceId=${deviceBId}\n` +
        "pendingKeyVersion=9\n" +
        `pendingEncryptionPublicKey=${goldenKey}\n` +
        `pendingSigningPublicKey=${goldenKey}\n`,
      digest: "8pJ+tRlC30Qac2qY32Zigt4h3mqJhT/VuoctQpDuQH0=",
    },
    {
      name: "copyyt-socket-auth-v1",
      bytes: buildSocketAuthMessage({
        userId: goldenUserId,
        deviceId: deviceAId,
        keyVersion: 4,
        socketId: "socket-123",
        challenge: "AQIDBA==",
      }),
      expected:
        "copyyt-socket-auth-v1\n" +
        `userId=${goldenUserId}\n` +
        `deviceId=${deviceAId}\n` +
        "keyVersion=4\n" +
        "socketId=socket-123\n" +
        "challenge=AQIDBA==\n",
      digest: "n1MJZv3tC/9RCZeF+V30+95ihd7OgBUWkCTYnNtrttE=",
    },
    {
      name: "copyyt-key-wrap-v1",
      bytes: buildKeyWrapContext({
        userId: goldenUserId,
        protocolVersion: 1,
        itemId,
        sourceDeviceId: deviceAId,
        sourceKeyVersion: 4,
        recipientDeviceId: deviceBId,
        recipientKeyVersion: 9,
      }),
      expected:
        "copyyt-key-wrap-v1\n" +
        `userId=${goldenUserId}\n` +
        "protocolVersion=1\n" +
        `itemId=${itemId}\n` +
        `sourceDeviceId=${deviceAId}\n` +
        "sourceKeyVersion=4\n" +
        `recipientDeviceId=${deviceBId}\n` +
        "recipientKeyVersion=9\n",
      digest: "OD2uqdBgZy9v7OeyYPKlVJh4Y9g2/mOlongyfNIQtnw=",
    },
    {
      name: "copyyt-payload-v1",
      bytes: buildPayloadAad({
        userId: goldenUserId,
        protocolVersion: 1,
        itemId,
        sourceDeviceId: deviceAId,
        sourceKeyVersion: 4,
        contentType: "text/plain",
        expiresAt: goldenExpiry,
      }),
      expected:
        "copyyt-payload-v1\n" +
        `userId=${goldenUserId}\n` +
        "protocolVersion=1\n" +
        `itemId=${itemId}\n` +
        `sourceDeviceId=${deviceAId}\n` +
        "sourceKeyVersion=4\n" +
        "contentType=text/plain\n" +
        `expiresAt=${goldenExpiry}\n`,
      digest: "q9w8Hf7Y5+Q0P2qBm7bsq3ZKY5ry8Sew/TRB4BpGveM=",
    },
    {
      name: "copyyt-pairing-fingerprint-v1",
      bytes: buildPairingFingerprintContext({
        userId: goldenUserId,
        approvingDeviceId: deviceAId,
        approvingKeyVersion: 4,
        approvingSigningPublicKey: goldenKey,
        approvingEncryptionPublicKey: goldenKey,
        pendingDeviceId: deviceBId,
        pendingKeyVersion: 9,
        pendingSigningPublicKey: goldenKey,
        pendingEncryptionPublicKey: goldenKey,
      }),
      expected:
        "copyyt-pairing-fingerprint-v1\n" +
        `userId=${goldenUserId}\n` +
        `approvingDeviceId=${deviceAId}\n` +
        "approvingKeyVersion=4\n" +
        `approvingSigningPublicKey=${goldenKey}\n` +
        `approvingEncryptionPublicKey=${goldenKey}\n` +
        `pendingDeviceId=${deviceBId}\n` +
        "pendingKeyVersion=9\n" +
        `pendingSigningPublicKey=${goldenKey}\n` +
        `pendingEncryptionPublicKey=${goldenKey}\n`,
      digest: "PlSuEnpwvWJhGecRDdJ0DDFr+kFB1AuItga7ccKzq2s=",
    },
    {
      name: "copyyt-clipboard-envelope-v1",
      bytes: await buildClipboardEnvelopeSignatureMessage({
        userId: goldenUserId,
        protocolVersion: 1,
        itemId,
        sourceDeviceId: deviceAId,
        sourceKeyVersion: 4,
        contentType: "text/plain",
        nonce: new Uint8Array(12).fill(7),
        ciphertext: utf8Encode("ciphertext bytes"),
        expiresAt: goldenExpiry,
      }),
      expected:
        "copyyt-clipboard-envelope-v1\n" +
        `userId=${goldenUserId}\n` +
        "protocolVersion=1\n" +
        `itemId=${itemId}\n` +
        `sourceDeviceId=${deviceAId}\n` +
        "sourceKeyVersion=4\n" +
        "contentType=text/plain\n" +
        "nonce=BwcHBwcHBwcHBwcH\n" +
        "ciphertextSha256=S1Zw8jssnwWFLRm1b1jfOf86iofvgbHx+P2O0+/cYnA=\n" +
        `expiresAt=${goldenExpiry}\n`,
      digest: "Ze6JBo7rbpvg3LMFIf1dPm91HW4mJdAtzLB6bvR8ccU=",
    },
  ];

  for (const vector of vectors) {
    assert.deepEqual(vector.bytes, utf8Encode(vector.expected), vector.name);
    assert.equal(bytesToBase64(await sha256(vector.bytes)), vector.digest, `${vector.name} digest`);
  }
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

test("rich clipboard bundles complete a real authenticated crypto round trip", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const richPayload: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "Copyyt" },
      { mime: "text/html", encoding: "utf-8", data: "<strong>Copyyt</strong>" },
    ],
  };
  const plaintext = encodeClipboardBundleV1(richPayload);
  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext,
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
    expiresAt,
    itemId,
    recipients: [verifiedDevice(identityB)],
  });

  assert.equal(envelope.contentType, CLIPBOARD_BUNDLE_V1_MIME);
  assert.equal(
    await verifyClipboardEnvelopeSignature({
      userId,
      envelope,
      sourceSigningPublicKey: identityA.signingPublicKey,
    }),
    true,
  );
  const decrypted = await decryptClipboardItemBytes({
    userId,
    identity: identityB,
    sourceDevice: verifiedDevice(identityA),
    envelope,
  });
  assert.ok(decrypted.plaintextBytes instanceof Uint8Array);
  assert.deepEqual(decodeClipboardBundleV1(decrypted.plaintextBytes), richPayload);
});

test("safe plaintext maximum encrypts to exactly the backend ciphertext maximum", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const plaintext = "a".repeat(MAX_CLIPBOARD_PLAINTEXT_BYTES);
  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext,
    contentType: "text/plain",
    expiresAt,
    recipients: [verifiedDevice(identityB)],
  });
  const ciphertextBytes = base64ToBytes(envelope.ciphertext).byteLength;
  assert.equal(ciphertextBytes, MAX_CLIPBOARD_CIPHERTEXT_BYTES);
  assert.equal(ciphertextBytes - utf8Encode(plaintext).byteLength, AES_GCM_TAG_BYTES);
  assert.equal(AES_GCM_TAG_BYTES, 16);
  assert.equal(base64ToBytes(envelope.nonce).byteLength, 12);
  const decrypted = await decryptClipboardItem({
    userId,
    identity: identityB,
    sourceDevice: verifiedDevice(identityA),
    envelope,
  });
  assert.equal(decrypted.plaintext, plaintext);
});

test("authenticated byte decryption leaves malformed UTF-8 to content dispatch", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const plaintextBytes = new Uint8Array([0xc3, 0x28]);
  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext: plaintextBytes,
    contentType: CLIPBOARD_BUNDLE_V1_MIME,
    expiresAt,
    recipients: [verifiedDevice(identityB)],
  });
  const input = {
    userId,
    identity: identityB,
    sourceDevice: verifiedDevice(identityA),
    envelope,
  };
  assert.deepEqual(await decryptClipboardItemBytes(input), { plaintextBytes });
  await assert.rejects(decryptClipboardItem(input), TypeError);
  await assert.rejects(decryptClipboardItemBytes({
    ...input,
    envelope: { ...envelope, contentType: "text/plain" },
  }), /signature is invalid/);
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
    approvingKeyVersion: 4,
    approvingSigningPublicKey: identityA.signingPublicKeyBase64,
    approvingEncryptionPublicKey: identityA.encryptionPublicKeyBase64,
    pendingDeviceId: deviceBId,
    pendingKeyVersion: 9,
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

test("crypto inputs reject cross-account recipients, sources, and approvers", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const otherUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherAccountRecipient = {
    ...verifiedDevice(identityB),
    userId: otherUserId,
  };

  await assert.rejects(
    encryptClipboardItem({
      userId,
      identity: identityA,
      plaintext: "secret",
      contentType: "text/plain",
      expiresAt,
      itemId,
      recipients: [otherAccountRecipient],
    }),
  );

  const envelope = await encryptClipboardItem({
    userId,
    identity: identityA,
    plaintext: "secret",
    contentType: "text/plain",
    expiresAt,
    itemId,
    recipients: [verifiedDevice(identityB)],
    randomBytes: (length) => new Uint8Array(length).fill(0x45),
  });
  await assert.rejects(
    decryptClipboardItem({
      userId,
      identity: identityB,
      sourceDevice: { ...verifiedDevice(identityA), userId: otherUserId },
      envelope,
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
  assert.equal(
    await verifyDeviceApproval({
      userId,
      certificate,
      approverDevice: { ...verifiedDevice(identityA), userId: otherUserId },
    }),
    false,
  );
});

test("local bootstrap is explicit and never inferred from a server label", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const store = new InMemoryTrustStore();
  const reported = store.upsertServerReportedDevice({
    ...verifiedDevice(identityA),
    trustState: "trusted",
  });
  assert.equal(reported.trustState, "unverified");
  assert.equal(store.listEncryptionRecipients(userId).length, 0);
  assert.equal(store.bootstrapInitialTrustAnchor(userId, identityA).trustState, "root");
});

test("pairing pins the full-key approver and leaves the pending device unverified", async () => {
  const approverIdentity = await makeFixedIdentity(deviceAId, 4);
  const pendingIdentity = await makeFixedIdentity(deviceBId, 9, true);
  const store = new InMemoryTrustStore();
  const approver = store.upsertServerReportedDevice({
    ...verifiedDevice(approverIdentity),
    trustState: "trusted",
  });
  const pending = store.upsertServerReportedDevice({
    ...verifiedDevice(pendingIdentity),
    trustState: "trusted",
  });
  const fingerprint = await pairingFingerprint({
    userId,
    approvingDeviceId: approver.deviceId,
    approvingKeyVersion: approver.keyVersion,
    approvingSigningPublicKey: approver.signingPublicKey,
    approvingEncryptionPublicKey: approver.encryptionPublicKey,
    pendingDeviceId: pending.deviceId,
    pendingKeyVersion: pending.keyVersion,
    pendingSigningPublicKey: pending.signingPublicKey,
    pendingEncryptionPublicKey: pending.encryptionPublicKey,
  });
  const root = await store.pinPairedApprover(
    userId,
    pendingIdentity,
    approverIdentity.deviceId,
    fingerprint,
  );
  assert.equal(root.trustState, "root");
  assert.equal(root.trustOrigin, "pairing");
  assert.equal(root.pairedForDeviceId, pendingIdentity.deviceId);
  assert.equal(root.pairingFingerprint, fingerprint);
  assert.equal(store.getDevice(userId, pendingIdentity.deviceId)?.trustState, "unverified");

  const pendingFields = {
    pendingDeviceId: pendingIdentity.deviceId,
    pendingKeyVersion: pendingIdentity.keyVersion!,
    pendingEncryptionPublicKey: pendingIdentity.encryptionPublicKeyBase64,
    pendingSigningPublicKey: pendingIdentity.signingPublicKeyBase64,
  };
  await store.applyApproval(userId, {
    approvingDeviceId: approverIdentity.deviceId,
    approvingKeyVersion: approverIdentity.keyVersion!,
    ...pendingFields,
    approvalSignature: await signDeviceApproval({
      userId,
      approvingIdentity: approverIdentity,
      pendingDevice: pendingFields,
    }),
  });
  assert.equal(store.getDevice(userId, pendingIdentity.deviceId)?.trustState, "verified");
});

test("revocation is monotonic across later server observations", async () => {
  const identity = await makeFixedIdentity(deviceAId, 1);
  const store = new InMemoryTrustStore();
  store.upsertServerReportedDevice({ ...verifiedDevice(identity), trustState: "trusted" });
  store.revokeDevice(userId, deviceAId);
  assert.equal(
    store.upsertServerReportedDevice({ ...verifiedDevice(identity), trustState: "trusted" }).trustState,
    "revoked",
  );
  assert.equal(
    store.upsertServerReportedDevice({ ...verifiedDevice(identity), trustState: "revoked" }).trustState,
    "revoked",
  );
});

test("verified device metadata refresh preserves trust and rejects identity changes", async () => {
  const identityA = await makeFixedIdentity(deviceAId, 1);
  const identityB = await makeFixedIdentity(deviceBId, 1, true);
  const store = new InMemoryTrustStore();
  const richCapabilities = ["clipboard", "clipboard-bundle-v1", "clipboard-html-v1"];
  const root = store.pinInitialDevice(userId, identityA, {
    name: "Old root",
    platform: "chrome",
    capabilities: ["clipboard"],
    appVersion: "2.0.1",
  });
  const refreshedRoot = store.upsertServerReportedDevice({
    ...root,
    name: "New root",
    platform: "chrome",
    capabilities: richCapabilities,
    appVersion: "2.0.2",
    trustState: "trusted",
  });
  assert.equal(refreshedRoot.trustState, "root");
  assert.equal(refreshedRoot.trustOrigin, "initial-tofu");
  assert.deepEqual(refreshedRoot.capabilities, richCapabilities);
  assert.equal(refreshedRoot.name, "New root");
  const conservative = store.upsertServerReportedDevice({
    ...refreshedRoot,
    capabilities: { malformed: true } as never,
    trustState: "trusted",
  });
  assert.equal(conservative.capabilities, undefined);

  store.upsertServerReportedDevice({
    ...verifiedDevice(identityB),
    capabilities: ["clipboard"],
    trustState: "trusted",
  });
  const pendingFields = {
    pendingDeviceId: deviceBId,
    pendingKeyVersion: 1,
    pendingEncryptionPublicKey: identityB.encryptionPublicKeyBase64,
    pendingSigningPublicKey: identityB.signingPublicKeyBase64,
  };
  const certificate = {
    approvingDeviceId: deviceAId,
    approvingKeyVersion: 1,
    ...pendingFields,
    approvalSignature: await signDeviceApproval({
      userId,
      approvingIdentity: identityA,
      pendingDevice: pendingFields,
    }),
  };
  const verified = await store.applyApproval(userId, certificate);
  const refreshedVerified = store.upsertServerReportedDevice({
    ...verified,
    name: "Verified upgraded",
    capabilities: richCapabilities,
    trustState: "trusted",
  });
  assert.equal(refreshedVerified.trustState, "verified");
  assert.deepEqual(refreshedVerified.approvalCertificate, verified.approvalCertificate);
  assert.equal(refreshedVerified.capabilities?.includes("clipboard-html-v1"), true);

  for (const changed of [
    { signingPublicKey: bytesToBase64(new Uint8Array(32).fill(9)) },
    { encryptionPublicKey: bytesToBase64(new Uint8Array(32).fill(9)) },
    { keyVersion: 2 },
  ]) {
    assert.throws(() =>
      store.upsertServerReportedDevice({
        ...refreshedRoot,
        ...changed,
        capabilities: richCapabilities,
        trustState: "trusted",
      }),
    );
  }

  const identityC = await makeFixedIdentity("00000000-0000-4000-8000-000000000003", 1);
  const unverified = store.upsertServerReportedDevice({
    ...verifiedDevice(identityC),
    capabilities: ["clipboard"],
    trustState: "trusted",
  });
  assert.equal(unverified.trustState, "unverified");

  await store.revokeDevice(userId, identityC.deviceId);
  const revoked = store.upsertServerReportedDevice({
    ...verifiedDevice(identityC),
    capabilities: richCapabilities,
    trustState: "trusted",
  });
  assert.equal(revoked.trustState, "revoked");
  assert.deepEqual(revoked.capabilities, ["clipboard"]);
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
    userId,
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
