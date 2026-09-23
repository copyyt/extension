import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTrustStore, type LocalDeviceRecord } from "./trust-store.ts";

const userId = "user-1";
const rootId = "00000000-0000-4000-8000-000000000001";
const base = {
  userId,
  deviceId: rootId,
  keyVersion: 1,
  encryptionPublicKey: Buffer.alloc(32, 1).toString("base64"),
  signingPublicKey: Buffer.alloc(32, 2).toString("base64"),
};

function storeWith(record: LocalDeviceRecord): InMemoryTrustStore {
  const store = new InMemoryTrustStore();
  (store as unknown as { devices: Map<string, LocalDeviceRecord> }).devices.set(
    JSON.stringify([userId, rootId]),
    record,
  );
  return store;
}

test("revoking a root pinned during pairing succeeds and drops its pairing ceremony", () => {
  const store = storeWith({
    ...base,
    trustState: "root",
    trustOrigin: "pairing",
    pairedForDeviceId: "00000000-0000-4000-8000-000000000002",
    pairingFingerprint: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
    pinnedAt: new Date().toISOString(),
  });
  store.revokeDevice(userId, rootId);
  const revoked = store.getDevice(userId, rootId)!;
  assert.equal(revoked.trustState, "revoked");
  assert.equal(revoked.trustOrigin, undefined);
  assert.equal(revoked.pairedForDeviceId, undefined);
  assert.equal(revoked.signingPublicKey, base.signingPublicKey, "keys stay pinned as revoked");
  assert.deepEqual(store.listEncryptionRecipients(userId), []);
});

test("revoking an initial-tofu root succeeds", () => {
  const store = storeWith({ ...base, trustState: "root", trustOrigin: "initial-tofu" });
  store.revokeDevice(userId, rootId);
  assert.equal(store.getDevice(userId, rootId)!.trustState, "revoked");
});
