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

export class RecoveryCredentialSealedError extends Error {
  constructor() {
    super("The recovery credential was already exported and removed from this device");
    this.name = "RecoveryCredentialSealedError";
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
  /** Public half of the one-time offline recovery credential. */
  readonly recoveryPublicKeyBase64: string;
  readonly recoveryExportedAt: string | null;
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
  /**
   * Recovery signing key is extractable only for explicit user export. Once
   * the user confirms the offline copy is saved, it is deleted and only the
   * public half plus `recoveryExportedAt` remain.
   */
  recoveryPrivateKey?: CryptoKey;
  recoveryPublicKey?: CryptoKey;
  recoveryPublicKeyBase64?: string;
  recoveryExportedAt?: string;
  registration: DeviceRegistrationMetadata | null;
}

export interface PrivateKeyHandles {
  signingPrivateKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  /** Absent after the recovery credential has been exported and sealed. */
  recoveryPrivateKey?: CryptoKey;
}

export interface RecoveryKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBase64: string;
}

const privateKeyHandles = new WeakMap<DeviceIdentity, PrivateKeyHandles>();
const activeIdentities = new Set<DeviceIdentity>();
const creationPromises = new Map<string, Promise<DeviceIdentity>>();

export async function generateRecoveryKeyPair(): Promise<RecoveryKeyPair> {
  const pair = (await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", pair.publicKey),
  );
  if (publicKey.length !== 32) {
    throw new DeviceIdentityCorruptError();
  }
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyBase64: bytesToBase64(publicKey),
  };
}

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

/**
 * A record is complete when it holds the recovery public key and either the
 * private key (not yet exported) or an export timestamp (sealed). A sealed
 * record must never get a fresh pair: the server still holds its public key.
 */
function hasCompleteRecoveryMaterial(record: StoredIdentityRecord): boolean {
  return Boolean(
    record.recoveryPublicKey &&
      record.recoveryPublicKeyBase64 &&
      (record.recoveryPrivateKey || record.recoveryExportedAt),
  );
}

async function ensureRecoveryMaterial(
  userId: string,
  record: StoredIdentityRecord,
): Promise<StoredIdentityRecord> {
  if (hasCompleteRecoveryMaterial(record)) {
    return record;
  }
  const recoveryPair = (await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const recoveryPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", recoveryPair.publicKey),
  );
  if (recoveryPublicKey.length !== 32) {
    throw new DeviceIdentityCorruptError();
  }
  const database = await openCryptoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDENTITY_STORE, "readwrite");
    const store = transaction.objectStore(IDENTITY_STORE);
    const request = store.get(userId);
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
        current.userId !== userId
      ) {
        failure = new DeviceIdentityCorruptError();
        transaction.abort();
        return;
      }
      if (hasCompleteRecoveryMaterial(current)) {
        nextRecord = current;
        return;
      }
      nextRecord = {
        ...current,
        recoveryPrivateKey: recoveryPair.privateKey,
        recoveryPublicKey: recoveryPair.publicKey,
        recoveryPublicKeyBase64: bytesToBase64(recoveryPublicKey),
      };
      store.put(nextRecord, userId);
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

function isRecoveryPrivateKey(key: unknown): key is CryptoKey {
  if (!key || typeof key !== "object") return false;
  const candidate = key as CryptoKey;
  return (
    candidate.type === "private" &&
    candidate.algorithm.name === "Ed25519" &&
    candidate.extractable &&
    hasUsage(candidate, "sign")
  );
}

export function isValidStoredIdentityRecord(record: unknown): record is StoredIdentityRecord {
  if (!record || typeof record !== "object") {
    return false;
  }
  const candidate = record as Partial<StoredIdentityRecord>;
  const registration = candidate.registration;
  const hasNoRecoveryMaterial =
    candidate.recoveryPrivateKey === undefined &&
    candidate.recoveryPublicKey === undefined &&
    candidate.recoveryPublicKeyBase64 === undefined &&
    candidate.recoveryExportedAt === undefined;
  const hasRecoveryPublicMaterial =
    isPublicKey(candidate.recoveryPublicKey, "Ed25519", "verify") &&
    isCanonicalBase64Bytes(candidate.recoveryPublicKeyBase64, 32);
  const hasRecoveryMaterial =
    hasRecoveryPublicMaterial &&
    isRecoveryPrivateKey(candidate.recoveryPrivateKey) &&
    (candidate.recoveryExportedAt === undefined ||
      typeof candidate.recoveryExportedAt === "string");
  const hasSealedRecoveryMaterial =
    hasRecoveryPublicMaterial &&
    candidate.recoveryPrivateKey === undefined &&
    typeof candidate.recoveryExportedAt === "string";
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
    (hasNoRecoveryMaterial || hasRecoveryMaterial || hasSealedRecoveryMaterial) &&
    validRegistration
  );
}

async function identityFromRecord(record: StoredIdentityRecord): Promise<DeviceIdentity> {
  if (
    !record.recoveryPublicKey ||
    !record.recoveryPublicKeyBase64 ||
    (record.recoveryPrivateKey === undefined
      ? typeof record.recoveryExportedAt !== "string"
      : !isRecoveryPrivateKey(record.recoveryPrivateKey)) ||
    !isPublicKey(record.recoveryPublicKey, "Ed25519", "verify") ||
    !isCanonicalBase64Bytes(record.recoveryPublicKeyBase64, 32)
  ) {
    throw new DeviceIdentityCorruptError();
  }
  const signingPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", record.signingPublicKey),
  );
  const encryptionPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", record.encryptionPublicKey),
  );
  const recoveryPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", record.recoveryPublicKey),
  );
  if (signingPublicKey.length !== 32 || encryptionPublicKey.length !== 32) {
    throw new DeviceIdentityCorruptError();
  }
  if (
    recoveryPublicKey.length !== 32 ||
    record.recoveryPublicKeyBase64 !== bytesToBase64(recoveryPublicKey)
  ) {
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
    recoveryPublicKeyBase64: bytesToBase64(recoveryPublicKey),
    recoveryExportedAt: record.recoveryExportedAt ?? null,
    registration: record.registration
      ? { ...record.registration, capabilities: [...record.registration.capabilities] }
      : null,
  };
  privateKeyHandles.set(identity, {
    signingPrivateKey: record.signingPrivateKey,
    encryptionPrivateKey: record.encryptionPrivateKey,
    ...(record.recoveryPrivateKey
      ? { recoveryPrivateKey: record.recoveryPrivateKey }
      : {}),
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
  const recoveryPair = (await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const signingPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", signingPair.publicKey),
  );
  const encryptionPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", encryptionPair.publicKey),
  );
  const recoveryPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", recoveryPair.publicKey),
  );
  if (
    signingPublicKey.length !== 32 ||
    encryptionPublicKey.length !== 32 ||
    recoveryPublicKey.length !== 32
  ) {
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
    recoveryPrivateKey: recoveryPair.privateKey,
    recoveryPublicKey: recoveryPair.publicKey,
    recoveryPublicKeyBase64: bytesToBase64(recoveryPublicKey),
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
    return await identityFromRecord(await ensureRecoveryMaterial(userId, record));
  } catch (error) {
    if (error instanceof DeviceIdentityCorruptError) throw error;
    throw error;
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
        recoveryPrivateKey: current.recoveryPrivateKey,
        recoveryPublicKey: current.recoveryPublicKey,
        recoveryPublicKeyBase64: current.recoveryPublicKeyBase64,
        recoveryExportedAt: current.recoveryExportedAt,
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

/** Export only through an explicit trusted-context user action. */
export async function exportRecoveryPrivateKey(identity: DeviceIdentity): Promise<string> {
  const handles = getPrivateKeyHandles(identity);
  if (!handles.recoveryPrivateKey) {
    throw new RecoveryCredentialSealedError();
  }
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", handles.recoveryPrivateKey),
  );
  return bytesToBase64(bytes);
}

/**
 * Records that the user saved the offline credential and deletes the local
 * private key, so the device no longer holds a way to re-export it.
 */
export async function sealRecoveryCredential(
  identity: DeviceIdentity,
  exportedAt = new Date().toISOString(),
): Promise<DeviceIdentity> {
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new TypeError("The recovery export timestamp must be valid");
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
        current.deviceId !== identity.deviceId ||
        !current.recoveryPrivateKey ||
        !current.recoveryPublicKey ||
        !current.recoveryPublicKeyBase64
      ) {
        failure = new DeviceIdentityCorruptError();
        transaction.abort();
        return;
      }
      const { recoveryPrivateKey: _deleted, ...rest } = current;
      void _deleted;
      nextRecord = { ...rest, recoveryExportedAt: exportedAt };
      store.put(nextRecord, identity.userId);
    };
    transaction.oncomplete = () => {
      closeDatabase(database);
      if (failure || !nextRecord) reject(failure ?? new DeviceIdentityCorruptError());
      else resolve(nextRecord);
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

export async function persistRecoveryKeyPair(
  identity: DeviceIdentity,
  recovery: RecoveryKeyPair,
): Promise<DeviceIdentity> {
  if (!isCanonicalBase64Bytes(recovery.publicKeyBase64, 32)) {
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
      nextRecord = {
        ...current,
        recoveryPrivateKey: recovery.privateKey,
        recoveryPublicKey: recovery.publicKey,
        recoveryPublicKeyBase64: recovery.publicKeyBase64,
        recoveryExportedAt: undefined,
      };
      store.put(nextRecord, identity.userId);
    };
    transaction.oncomplete = () => {
      closeDatabase(database);
      if (failure || !nextRecord) reject(failure ?? new DeviceIdentityCorruptError());
      else resolve(nextRecord);
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
  const recoveryPair = (await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const recoveryPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", recoveryPair.publicKey),
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
    recoveryPublicKeyBase64: bytesToBase64(recoveryPublicKey),
    recoveryExportedAt: null,
    registration: null,
  };
  privateKeyHandles.set(identity, {
    signingPrivateKey: input.signingPrivateKey,
    encryptionPrivateKey: input.encryptionPrivateKey,
    recoveryPrivateKey: recoveryPair.privateKey,
  });
  activeIdentities.add(identity);
  return identity;
}
