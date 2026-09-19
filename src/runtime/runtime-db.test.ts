import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAssistedPngSuppressionStore,
  InMemoryPendingAssistedImageStore,
} from "./runtime-db.ts";

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
  assert.equal(persisted[0]!.envelope.ciphertext, "ciphertext-only");
  assert.equal(JSON.stringify(persisted).includes(PNG_BASE64), false);
  assert.equal("pngBytes" in persisted[0]!, false);
  assert.equal("plaintext" in persisted[0]!.envelope, false);
});

test("assisted PNG suppression is durable metadata and single-use", async () => {
  const store = new InMemoryAssistedPngSuppressionStore();
  await store.put({
    userId: "user-1",
    itemId: "item-1",
    payloadFingerprint: "fingerprint-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(await store.consumeByFingerprint("user-1", "fingerprint-1"), true);
  assert.equal(await store.consumeByFingerprint("user-1", "fingerprint-1"), false);
});
