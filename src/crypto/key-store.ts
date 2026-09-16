import { bytesToBase64, isCanonicalBase64Bytes } from "./bytes.ts";
import {
  closeDatabase,
  IDENTITY_STORE,
  openCryptoDatabase,
} from "./storage.ts";

export class DeviceIdentityCorruptError extends Error {
  constructor() {
    super(
      "The local device identity is incomplete or corrupt; clear it and require explicit re-registration",
    );
    this.name = "DeviceIdentityCorruptError";
  }
}

export class DeviceIdentityNotFoundError extends Error {
  constructor() {
    super("No local device identity exists");
    this.name = "DeviceIdentityNotFoundError";
  }
}

export interface DeviceRegistrationMetadata {
  keyVersion: number;
  name: string;
  platform: string;
  capabilities: string[];
  appVersion?: string;
}

export interface DeviceIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyVersion: number | null;
  readonly signingPublicKey: Uint8Array;
  readonly signingPublicKeyBase64: string;
  readonly encryptionPublicKey: Uint8Array;
  readonly encryptionPublicKeyBase64: string;
  readonly registration: DeviceRegistrationMetadata | null;
}

export interface StoredIdentityRecord {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  signingPublicKeyBase64: string;
  encryptionPublicKeyBase64: string;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  encryptionPublicKey: CryptoKey;
  registration: DeviceRegistrationMetadata | null;
}

export interface PrivateKeyHandles {
  signingPrivateKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
}

const privateKeyHandles = new WeakMap<DeviceIdentity, PrivateKeyHandles>();
const activeIdentities = new Set<DeviceIdentity>();
const creationPromises = new Map<string, Promise<DeviceIdentity>>();

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("userId is required for device identity operations");
  }
}

async function readRecord(userId: string): Promise<StoredIdentityRecord | undefined> {
  assertUserId(userId);
  const database = await openCryptoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readonly");
    const request = transaction.objectStore(IDENTITY_STORE).get(userId);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read device identity"));
    request.onsuccess = () => resolve(request.result as StoredIdentityRecord | undefined);
    transaction.oncomplete = () => closeDatabase(database);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Unable to read device identity"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Unable to read device identity"));
  });
}

async function addRecord(
  userId: string,
  record: StoredIdentityRecord,
): Promise<void> {
  const database = await openCryptoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    const request = transaction.objectStore(IDENTITY_STORE).add(record, userId);
    request.onerror = () => {
      // Preserve the request's ConstraintError so a losing creator can reload
      // the record created by the winning MV3 realm.
      transaction.onerror = null;
      transaction.abort();
      reject(request.error ?? new Error("Unable to create device identity"));
    };
    transaction.oncomplete = () => {
      closeDatabase(database);
      resolve();
    };
    transaction.onerror = () => {
      closeDatabase(database);
      reject(transaction.error ?? new Error("Unable to create device identity"));
    };
    transaction.onabort = () => {
      closeDatabase(database);
      reject(transaction.error ?? request.error ?? new Error("Unable to create device identity"));
    };
  });
}

async function deleteRecord(userId: string): Promise<void> {
  assertUserId(userId);
  const database = await openCryptoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    transaction.objectStore(IDENTITY_STORE).delete(userId);
    transaction.oncomplete = () => {
      closeDatabase(database);
      resolve();
    };
    transaction.onerror = () => {
      closeDatabase(database);
      reject(transaction.error ?? new Error("Unable to clear device identity"));
    };
    transaction.onabort = () => {
      closeDatabase(database);
      reject(transaction.error ?? new Error("Unable to clear device identity"));
    };
  });
}

function hasUsage(key: CryptoKey, usage: KeyUsage): boolean {
  return key.usages.includes(usage);
}

function isKey(
  key: unknown,
  type: KeyType,
  algorithmName: string,
  usage: KeyUsage,
): key is CryptoKey {
  if (!key || typeof key !== "object") {
    return false;
  }
  const candidate = key as CryptoKey;
  return (
    candidate.type === type &&
    candidate.algorithm.name === algorithmName &&
    candidate.extractable === (type === "public") &&
    hasUsage(candidate, usage)
  );
}

function isPublicKey(
  key: unknown,
  algorithmName: string,
  usage?: KeyUsage,
): key is CryptoKey {
  if (!key || typeof key !== "object") {
    return false;
  }
  const candidate = key as CryptoKey;
  return (
    candidate.type === "public" &&
    candidate.algorithm.name === algorithmName &&
    candidate.extractable &&
    (usage ? hasUsage(candidate, usage) : candidate.usages.length === 0)
  );
}

export function isValidStoredIdentityRecord(record: unknown): record is StoredIdentityRecord {
  if (!record || typeof record !== "object") {
    return false;
  }
  const candidate = record as Partial<StoredIdentityRecord>;
  const registration = candidate.registration;
  const validRegistration =
    registration === null ||
    (typeof registration === "object" &&
      Number.isSafeInteger(registration.keyVersion) &&
      registration.keyVersion > 0 &&
      typeof registration.name === "string" &&
      typeof registration.platform === "string" &&
      Array.isArray(registration.capabilities) &&
      registration.capabilities.every((value) => typeof value === "string") &&
      (registration.appVersion === undefined || typeof registration.appVersion === "string"));

  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.userId === "string" &&
    candidate.userId.length > 0 &&
    typeof candidate.deviceId === "string" &&
    isCanonicalBase64Bytes(candidate.signingPublicKeyBase64, 32) &&
    isCanonicalBase64Bytes(candidate.encryptionPublicKeyBase64, 32) &&
    isKey(candidate.signingPrivateKey, "private", "Ed25519", "sign") &&
    isPublicKey(candidate.signingPublicKey, "Ed25519", "verify") &&
    isKey(candidate.encryptionPrivateKey, "private", "X25519", "deriveBits") &&
    isPublicKey(candidate.encryptionPublicKey, "X25519") &&
    validRegistration
  );
}

async function identityFromRecord(record: StoredIdentityRecord): Promise<DeviceIdentity> {
  const signingPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", record.signingPublicKey),
  );
  const encryptionPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", record.encryptionPublicKey),
  );
  if (signingPublicKey.length !== 32 || encryptionPublicKey.length !== 32) {
    throw new DeviceIdentityCorruptError();
  }
  if (
    record.signingPublicKeyBase64 !== bytesToBase64(signingPublicKey) ||
    record.encryptionPublicKeyBase64 !== bytesToBase64(encryptionPublicKey)
  ) {
    throw new DeviceIdentityCorruptError();
  }

  const identity: DeviceIdentity = {
    userId: record.userId,
    deviceId: record.deviceId,
    keyVersion: record.registration?.keyVersion ?? null,
    signingPublicKey,
    signingPublicKeyBase64: bytesToBase64(signingPublicKey),
    encryptionPublicKey,
    encryptionPublicKeyBase64: bytesToBase64(encryptionPublicKey),
    registration: record.registration
      ? { ...record.registration, capabilities: [...record.registration.capabilities] }
      : null,
  };
  privateKeyHandles.set(identity, {
    signingPrivateKey: record.signingPrivateKey,
    encryptionPrivateKey: record.encryptionPrivateKey,
  });
  activeIdentities.add(identity);
  return identity;
}

async function createRecord(userId: string): Promise<StoredIdentityRecord> {
  const signingPair = (await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const encryptionPair = (await globalThis.crypto.subtle.generateKey(
    { name: "X25519" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const signingPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", signingPair.publicKey),
  );
  const encryptionPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", encryptionPair.publicKey),
  );
  if (signingPublicKey.length !== 32 || encryptionPublicKey.length !== 32) {
    throw new Error("WebCrypto returned an unexpected public-key length");
  }

  return {
    schemaVersion: 1,
    userId,
    deviceId: globalThis.crypto.randomUUID(),
    signingPublicKeyBase64: bytesToBase64(signingPublicKey),
    encryptionPublicKeyBase64: bytesToBase64(encryptionPublicKey),
    signingPrivateKey: signingPair.privateKey,
    signingPublicKey: signingPair.publicKey,
    encryptionPrivateKey: encryptionPair.privateKey,
    encryptionPublicKey: encryptionPair.publicKey,
    registration: null,
  };
}

export async function getDeviceIdentity(userId: string): Promise<DeviceIdentity | null> {
  const record = await readRecord(userId);
  if (!record) {
    return null;
  }
  if (!isValidStoredIdentityRecord(record) || record.userId !== userId) {
    throw new DeviceIdentityCorruptError();
  }
  try {
    return await identityFromRecord(record);
  } catch {
    throw new DeviceIdentityCorruptError();
  }
}

async function createOrLoadDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  const existing = await getDeviceIdentity(userId);
  if (existing) {
    return existing;
  }

  const candidate = await createRecord(userId);
  try {
    // This must remain add(), never put(): the account key is the persistent
    // cross-context compare-and-set for MV3 realms.
    await addRecord(userId, candidate);
    return identityFromRecord(candidate);
  } catch (error) {
    if ((error as DOMException | undefined)?.name !== "ConstraintError") {
      throw error;
    }
    const winner = await getDeviceIdentity(userId);
    if (!winner) {
      throw new DeviceIdentityCorruptError();
    }
    return winner;
  }
}

export async function getOrCreateDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  assertUserId(userId);
  let promise = creationPromises.get(userId);
  if (!promise) {
    promise = createOrLoadDeviceIdentity(userId).finally(() => {
      if (creationPromises.get(userId) === promise) {
        creationPromises.delete(userId);
      }
    });
    creationPromises.set(userId, promise);
  }
  return promise;
}

export async function persistDeviceRegistrationMetadata(
  identity: DeviceIdentity,
  registration: DeviceRegistrationMetadata,
): Promise<DeviceIdentity> {
  if (
    !Number.isSafeInteger(registration.keyVersion) ||
    registration.keyVersion <= 0 ||
    typeof registration.name !== "string" ||
    typeof registration.platform !== "string" ||
    !Array.isArray(registration.capabilities) ||
    !registration.capabilities.every((value) => typeof value === "string") ||
    (registration.appVersion !== undefined && typeof registration.appVersion !== "string")
  ) {
    throw new DeviceIdentityCorruptError();
  }
  const database = await openCryptoDatabase();
  const updated = await new Promise<StoredIdentityRecord>((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    const store = transaction.objectStore(IDENTITY_STORE);
    const request = store.get(identity.userId);
    let nextRecord: StoredIdentityRecord | undefined;
    let failure: unknown;
    request.onerror = () => {
      failure = request.error ?? new DeviceIdentityCorruptError();
      transaction.abort();
    };
    request.onsuccess = () => {
      const current = request.result as StoredIdentityRecord | undefined;
      if (
        !current ||
        !isValidStoredIdentityRecord(current) ||
        current.userId !== identity.userId ||
        current.deviceId !== identity.deviceId
      ) {
        failure = new DeviceIdentityCorruptError();
        transaction.abort();
        return;
      }
      // Rebuild from the record read in this same transaction. The caller can
      // update registration metadata, but can never supply replacement keys.
      nextRecord = {
        schemaVersion: current.schemaVersion,
        userId: current.userId,
        deviceId: current.deviceId,
        signingPublicKeyBase64: current.signingPublicKeyBase64,
        encryptionPublicKeyBase64: current.encryptionPublicKeyBase64,
        signingPrivateKey: current.signingPrivateKey,
        signingPublicKey: current.signingPublicKey,
        encryptionPrivateKey: current.encryptionPrivateKey,
        encryptionPublicKey: current.encryptionPublicKey,
        registration: {
          ...registration,
          capabilities: [...registration.capabilities],
        },
      };
      store.put(nextRecord, identity.userId);
    };
    transaction.oncomplete = () => {
      closeDatabase(database);
      if (failure || !nextRecord) {
        reject(failure ?? new DeviceIdentityCorruptError());
      } else {
        resolve(nextRecord);
      }
    };
    transaction.onerror = () => {
      closeDatabase(database);
      reject(failure ?? transaction.error ?? new DeviceIdentityCorruptError());
    };
    transaction.onabort = () => {
      closeDatabase(database);
      reject(failure ?? transaction.error ?? new DeviceIdentityCorruptError());
    };
  });
  return identityFromRecord(updated);
}

export async function clearDeviceIdentity(userId: string): Promise<void> {
  assertUserId(userId);
  for (const identity of activeIdentities) {
    if (identity.userId === userId) {
      privateKeyHandles.delete(identity);
      activeIdentities.delete(identity);
    }
  }
  await deleteRecord(userId);
}

/** @internal Used by the framework-independent crypto core, not UI code. */
export function getPrivateKeyHandles(identity: DeviceIdentity): PrivateKeyHandles {
  const handles = privateKeyHandles.get(identity);
  if (!handles) {
    throw new DeviceIdentityNotFoundError();
  }
  return handles;
}

/** @internal Fixed-key unit-test construction; no key material is serialized. */
export async function createDeviceIdentityForTesting(input: {
  userId: string;
  deviceId: string;
  keyVersion: number;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  encryptionPublicKey: CryptoKey;
}): Promise<DeviceIdentity> {
  const signingPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", input.signingPublicKey),
  );
  const encryptionPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", input.encryptionPublicKey),
  );
  if (
    !isCanonicalBase64Bytes(bytesToBase64(signingPublicKey), 32) ||
    !isCanonicalBase64Bytes(bytesToBase64(encryptionPublicKey), 32)
  ) {
    throw new Error("Test identity public keys must be exactly 32 bytes");
  }
  const identity: DeviceIdentity = {
    userId: input.userId,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    signingPublicKey,
    signingPublicKeyBase64: bytesToBase64(signingPublicKey),
    encryptionPublicKey,
    encryptionPublicKeyBase64: bytesToBase64(encryptionPublicKey),
    registration: null,
  };
  privateKeyHandles.set(identity, {
    signingPrivateKey: input.signingPrivateKey,
    encryptionPrivateKey: input.encryptionPrivateKey,
  });
  activeIdentities.add(identity);
  return identity;
}
