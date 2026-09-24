import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAssistedPngSuppressionStore,
  InMemoryPendingAssistedImageStore,
} from "./runtime-db.ts";
import type { DirectClipboardStartV1 } from "../crypto/direct-clipboard.ts";

const PNG_BASE64 = "iVBORw0KGgoD";

function encryptedEnvelope() {
  return {
    itemId: "item-1",
    sourceDeviceId: "source-1",
    sourceKeyVersion: 1,
    sourceSignature: "signature",
    protocolVersion: 1 as const,
    contentType: "application/vnd.copyyt.clipboard-bundle+json",
    ciphertext: "ciphertext-only",
    nonce: "nonce-only",
    recipients: [
      {
        deviceId: "destination-1",
        deviceKeyVersion: 1,
        wrapNonce: "wrap-nonce",
        wrappedContentKey: "wrapped-key",
      },
    ],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("pending assisted image records persist encrypted envelopes, never PNG plaintext", async () => {
  const store = new InMemoryPendingAssistedImageStore();
  await store.put({
    userId: "user-1",
    itemId: "item-1",
    sourceDeviceId: "source-1",
    sourceDeviceName: "Source Chrome",
    receivedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hasPng: true,
    envelope: encryptedEnvelope(),
  });

  const persisted = await store.list("user-1");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.envelope!.ciphertext, "ciphertext-only");
  assert.equal(JSON.stringify(persisted).includes(PNG_BASE64), false);
  assert.equal("pngBytes" in persisted[0]!, false);
  assert.equal("plaintext" in persisted[0]!.envelope!, false);
});

test("direct pending assisted image records persist only the encrypted package", async () => {
  const store = new InMemoryPendingAssistedImageStore();
  const manifest = {
    type: "clipboard-secure-start",
    protocol: "copyyt-direct-clipboard-v1",
    transferId: "33333333-3333-4333-8333-333333333333",
    userId: "11111111-1111-4111-8111-111111111111",
    sourceDeviceId: "00000000-0000-4000-8000-000000000001",
    sourceKeyVersion: 1,
    recipientDeviceId: "00000000-0000-4000-8000-000000000002",
    recipientKeyVersion: 1,
    contentType: "application/vnd.copyyt.clipboard-bundle+json",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    plaintextByteLength: 32_748,
    chunkPlaintextSize: 32_748,
    chunkCount: 1,
    noncePrefix: "AAAAAAAAAAA=",
    wrapNonce: "AAAAAAAAAAAAAAAA",
    wrappedKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sourceSignature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  } satisfies DirectClipboardStartV1;
  await store.put({
    userId: "11111111-1111-4111-8111-111111111111",
    itemId: manifest.transferId,
    sourceDeviceId: manifest.sourceDeviceId,
    receivedAt: new Date().toISOString(),
    expiresAt: manifest.expiresAt,
    hasPng: true,
    directPackage: {
      manifest,
      encryptedChunks: ["encrypted-frame"],
    },
  });

  const persisted = await store.get(manifest.userId, manifest.transferId);
  assert.ok(persisted?.directPackage);
  assert.equal("envelope" in persisted, false);
  assert.equal(JSON.stringify(persisted).includes(PNG_BASE64), false);
  assert.equal(JSON.stringify(persisted).includes("encrypted-frame"), true);
});

test("assisted PNG suppression is durable metadata and single-use", async () => {
  const store = new InMemoryAssistedPngSuppressionStore();
  await store.put({
    userId: "user-1",
    itemId: "item-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(await store.consumeNext("user-1"), true);
  assert.equal(await store.consumeNext("user-1"), false);
});
