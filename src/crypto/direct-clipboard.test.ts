import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64,
  base64ToBytes,
} from "./bytes.ts";
import { createDeviceIdentityForTesting, type DeviceIdentity } from "./key-store.ts";
import {
  decodeDirectClipboardChunkFrame,
  decryptDirectClipboardTransfer,
  directClipboardChunkNonce,
  prepareDirectClipboardTransfer,
  type DirectClipboardStartV1,
} from "./direct-clipboard.ts";
import {
  DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
  DIRECT_CLIPBOARD_CONTENT_TYPE,
} from "../direct/protocol.ts";
import { clipboardPayloadFromPngBytes } from "../clipboard/payload.ts";
import type { ClientVerifiedDevice } from "./trust-store.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const sourceDeviceId = "00000000-0000-4000-8000-000000000001";
const recipientDeviceId = "00000000-0000-4000-8000-000000000002";
const transferId = "33333333-3333-4333-8333-333333333333";

async function identity(deviceId: string, variant: number): Promise<DeviceIdentity> {
  const signing = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const encryption = (await crypto.subtle.generateKey(
    { name: "X25519" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  void variant;
  return createDeviceIdentityForTesting({
    userId,
    deviceId,
    keyVersion: 1,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: await crypto.subtle.importKey(
      "raw",
      new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)),
      { name: "Ed25519" },
      true,
      ["verify"],
    ),
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: await crypto.subtle.importKey(
      "raw",
      new Uint8Array(await crypto.subtle.exportKey("raw", encryption.publicKey)),
      { name: "X25519" },
      true,
      [],
    ),
  });
}

function trustedDevice(device: DeviceIdentity): ClientVerifiedDevice {
  return {
    userId,
    deviceId: device.deviceId,
    keyVersion: device.keyVersion!,
    signingPublicKey: device.signingPublicKeyBase64,
    encryptionPublicKey: device.encryptionPublicKeyBase64,
    trustState: "verified",
  };
}

function oversizedPngPayload() {
  const bytes = new Uint8Array(800_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return clipboardPayloadFromPngBytes(bytes);
}

test("direct clipboard chunks round trip with fresh wrapped CEK and unique nonces", async () => {
  const source = await identity(sourceDeviceId, 0);
  const recipient = await identity(recipientDeviceId, 0);
  const prepared = await prepareDirectClipboardTransfer({
    userId,
    identity: source,
    recipient: trustedDevice(recipient),
    payload: oversizedPngPayload(),
    transferId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(prepared.manifest.contentType, DIRECT_CLIPBOARD_CONTENT_TYPE);
  assert.ok(prepared.manifest.chunkCount > 1);
  assert.equal(prepared.manifest.chunkPlaintextSize, DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE);
  assert.equal(base64ToBytes(prepared.manifest.noncePrefix).byteLength, 8);
  assert.equal(base64ToBytes(prepared.manifest.wrapNonce).byteLength, 12);
  assert.equal(base64ToBytes(prepared.manifest.wrappedKey).byteLength, 48);
  const prefix = base64ToBytes(prepared.manifest.noncePrefix);
  const nonces = prepared.encryptedChunks.map((_, index) =>
    bytesToBase64(directClipboardChunkNonce(prefix, index)),
  );
  assert.equal(new Set(nonces).size, nonces.length);
  const decrypted = await decryptDirectClipboardTransfer({
    userId,
    identity: recipient,
    sourceDevice: trustedDevice(source),
    manifest: prepared.manifest,
    encryptedChunks: prepared.encryptedChunks,
  });
  assert.deepEqual(decrypted.payload, oversizedPngPayload());
});

test("direct manifest, AAD, source, recipient, and chunk order are authenticated", async () => {
  const source = await identity(sourceDeviceId, 0);
  const recipient = await identity(recipientDeviceId, 0);
  const prepared = await prepareDirectClipboardTransfer({
    userId,
    identity: source,
    recipient: trustedDevice(recipient),
    payload: oversizedPngPayload(),
    transferId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const tamperedManifest = {
    ...prepared.manifest,
    recipientDeviceId: sourceDeviceId,
  } satisfies DirectClipboardStartV1;
  await assert.rejects(
    decryptDirectClipboardTransfer({
      userId,
      identity: recipient,
      sourceDevice: trustedDevice(source),
      manifest: tamperedManifest,
      encryptedChunks: prepared.encryptedChunks,
    }),
  );
  const tamperedChunks = [...prepared.encryptedChunks];
  const first = decodeDirectClipboardChunkFrame(tamperedChunks[0]!);
  const modified = new Uint8Array(base64ToBytes(tamperedChunks[0]!));
  modified[modified.length - 1] ^= 1;
  tamperedChunks[0] = bytesToBase64(modified);
  await assert.rejects(
    decryptDirectClipboardTransfer({
      userId,
      identity: recipient,
      sourceDevice: trustedDevice(source),
      manifest: prepared.manifest,
      encryptedChunks: tamperedChunks,
    }),
  );
  tamperedChunks[0] = prepared.encryptedChunks[1]!;
  tamperedChunks[1] = prepared.encryptedChunks[0]!;
  await assert.rejects(
    decryptDirectClipboardTransfer({
      userId,
      identity: recipient,
      sourceDevice: trustedDevice(source),
      manifest: prepared.manifest,
      encryptedChunks: tamperedChunks,
    }),
  );
  assert.equal(first.index, 0);
  await assert.rejects(
    decryptDirectClipboardTransfer({
      userId,
      identity: recipient,
      sourceDevice: trustedDevice(await identity(sourceDeviceId, 1)),
      manifest: prepared.manifest,
      encryptedChunks: prepared.encryptedChunks,
    }),
  );
});
