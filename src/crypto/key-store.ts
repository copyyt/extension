import { bytesToBase64, isCanonicalBase64Bytes } from "./bytes.ts";

const DATABASE_NAME = "copyyt-crypto-v1";
const DATABASE_VERSION = 1;
const IDENTITY_STORE = "identity";
const IDENTITY_KEY = "device";

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
  readonly deviceId: string;
  readonly keyVersion: number | null;
  readonly signingPublicKey: Uint8Array;
  readonly signingPublicKeyBase64: string;
  readonly encryptionPublicKey: Uint8Array;
  readonly encryptionPublicKeyBase64: string;
  readonly registration: DeviceRegistrationMetadata | null;
}

interface StoredIdentityRecord {
  schemaVersion: 1;
  deviceId: string;
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
let creationPromise: Promise<DeviceIdentity> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is required for the Copyyt device identity");
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) {
        database.createObjectStore(IDENTITY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRecord(): Promise<StoredIdentityRecord | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readonly");
    const request = transaction.objectStore(IDENTITY_STORE).get(IDENTITY_KEY);
    request.onerror = () => reject(request.error ?? new Error("Unable to read device identity"));
    request.onsuccess = () => resolve(request.result as StoredIdentityRecord | undefined);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to read device identity"));
  });
}

async function writeRecord(record: StoredIdentityRecord): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    transaction.objectStore(IDENTITY_STORE).put(record, IDENTITY_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Unable to persist device identity"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Unable to persist device identity"));
    };
  });
}

async function deleteRecord(): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    transaction.objectStore(IDENTITY_STORE).delete(IDENTITY_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Unable to clear device identity"));
    };
  });
}

function hasUsage(key: CryptoKey, usage: KeyUsage): boolean {
  return key.usages.includes(usage);
}

function isKey(key: unknown, type: KeyType, algorithmName: string, usage: KeyUsage): key is CryptoKey {
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

function isPublicKey(key: unknown, algorithmName: string, usage?: KeyUsage): key is CryptoKey {
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

function isValidRecord(record: unknown): record is StoredIdentityRecord {
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
    typeof candidate.deviceId === "string" &&
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

  const identity: DeviceIdentity = {
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

async function createRecord(): Promise<StoredIdentityRecord> {
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
    deviceId: globalThis.crypto.randomUUID(),
    signingPrivateKey: signingPair.privateKey,
    signingPublicKey: signingPair.publicKey,
    encryptionPrivateKey: encryptionPair.privateKey,
    encryptionPublicKey: encryptionPair.publicKey,
    registration: null,
  };
}

export async function getDeviceIdentity(): Promise<DeviceIdentity | null> {
  const record = await readRecord();
  if (!record) {
    return null;
  }
  if (!isValidRecord(record)) {
    throw new DeviceIdentityCorruptError();
  }
  try {
    return await identityFromRecord(record);
  } catch {
    throw new DeviceIdentityCorruptError();
  }
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  if (!creationPromise) {
    creationPromise = (async () => {
      const existing = await getDeviceIdentity();
      if (existing) {
        return existing;
      }
      const record = await createRecord();
      await writeRecord(record);
      return identityFromRecord(record);
    })().finally(() => {
      creationPromise = null;
    });
  }
  return creationPromise;
}

export async function persistDeviceRegistrationMetadata(
  identity: DeviceIdentity,
  registration: DeviceRegistrationMetadata,
): Promise<DeviceIdentity> {
  const current = await readRecord();
  if (!current || !isValidRecord(current) || current.deviceId !== identity.deviceId) {
    throw new DeviceIdentityCorruptError();
  }
  current.registration = {
    ...registration,
    capabilities: [...registration.capabilities],
  };
  await writeRecord(current);
  return identityFromRecord(current);
}

export async function clearDeviceIdentity(): Promise<void> {
  for (const identity of activeIdentities) {
    privateKeyHandles.delete(identity);
  }
  activeIdentities.clear();
  await deleteRecord();
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
