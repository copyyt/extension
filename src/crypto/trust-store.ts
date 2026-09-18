import {
  isValidStoredIdentityRecord,
  type DeviceIdentity,
  type StoredIdentityRecord,
} from "./key-store.ts";
import {
  closeDatabase,
  IDENTITY_STORE,
  TRUST_DEVICE_STORE,
  openCryptoDatabase,
} from "./storage.ts";
import {
  type DeviceApprovalCertificate,
  pairingFingerprint,
  verifyDeviceApproval,
} from "./crypto-core.ts";
import { isCanonicalBase64Bytes } from "./bytes.ts";

export type LocalTrustState = "root" | "verified" | "unverified" | "revoked";
export type TrustOrigin = "initial-tofu" | "pairing";

export interface LocalDeviceRecord {
  userId: string;
  deviceId: string;
  keyVersion: number;
  encryptionPublicKey: string;
  signingPublicKey: string;
  trustState: LocalTrustState;
  name?: string;
  platform?: string;
  capabilities?: string[];
  appVersion?: string;
  approvalCertificate?: DeviceApprovalCertificate;
  trustOrigin?: TrustOrigin;
  pairedForDeviceId?: string;
  pairingFingerprint?: string;
  pinnedAt?: string;
}

export type ClientVerifiedDevice = LocalDeviceRecord & {
  trustState: "root" | "verified";
};

export class TrustStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustStoreError";
  }
}

type MaybePromise<T> = T | Promise<T>;
type ServerReportedDevice = Omit<LocalDeviceRecord, "trustState"> & {
  trustState?: string;
};

export interface ClientTrustStore {
  getDevice(userId: string, deviceId: string): MaybePromise<LocalDeviceRecord | null>;
  upsertServerReportedDevice(device: ServerReportedDevice): MaybePromise<LocalDeviceRecord>;
  bootstrapInitialTrustAnchor(
    userId: string,
    identity: DeviceIdentity,
    metadata?: Partial<LocalDeviceRecord>,
  ): MaybePromise<ClientVerifiedDevice>;
  pinPairedApprover(
    userId: string,
    localIdentity: DeviceIdentity,
    approverDeviceId: string,
    confirmedFingerprint: string,
  ): MaybePromise<ClientVerifiedDevice>;
  /** @deprecated Use bootstrapInitialTrustAnchor for the explicit TOFU ceremony. */
  pinInitialDevice(
    userId: string,
    identity: DeviceIdentity,
    metadata?: Partial<LocalDeviceRecord>,
  ): MaybePromise<ClientVerifiedDevice>;
  applyApproval(
    userId: string,
    certificate: DeviceApprovalCertificate,
  ): Promise<ClientVerifiedDevice>;
  revokeDevice(userId: string, deviceId: string): MaybePromise<void>;
  listEncryptionRecipients(userId: string): MaybePromise<ClientVerifiedDevice[]>;
}

function deviceKey(userId: string, deviceId: string): string {
  // JSON encoding avoids delimiter collisions while keeping one stable
  // account/device key for both the in-memory test store and IndexedDB.
  return JSON.stringify([userId, deviceId]);
}

function sameKeys(
  left: Pick<
    LocalDeviceRecord,
    "deviceId" | "keyVersion" | "encryptionPublicKey" | "signingPublicKey"
  >,
  right: Pick<
    LocalDeviceRecord,
    "deviceId" | "keyVersion" | "encryptionPublicKey" | "signingPublicKey"
  >,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.keyVersion === right.keyVersion &&
    left.encryptionPublicKey === right.encryptionPublicKey &&
    left.signingPublicKey === right.signingPublicKey
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAIRING_FINGERPRINT_PATTERN = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isValidApprovalCertificate(
  certificate: unknown,
): certificate is DeviceApprovalCertificate {
  if (!certificate || typeof certificate !== "object") {
    return false;
  }
  const candidate = certificate as Partial<DeviceApprovalCertificate>;
  return (
    isUuid(candidate.approvingDeviceId) &&
    isPositiveInteger(candidate.approvingKeyVersion) &&
    isUuid(candidate.pendingDeviceId) &&
    isPositiveInteger(candidate.pendingKeyVersion) &&
    isCanonicalBase64Bytes(candidate.pendingEncryptionPublicKey, 32) &&
    isCanonicalBase64Bytes(candidate.pendingSigningPublicKey, 32) &&
    isCanonicalBase64Bytes(candidate.approvalSignature, 64)
  );
}

function assertValidTrustRecord(record: unknown): asserts record is LocalDeviceRecord {
  if (!record || typeof record !== "object") {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  const candidate = record as Partial<LocalDeviceRecord>;
  if (
    typeof candidate.userId !== "string" ||
    candidate.userId.length === 0 ||
    !isUuid(candidate.deviceId) ||
    !isPositiveInteger(candidate.keyVersion) ||
    !isCanonicalBase64Bytes(candidate.signingPublicKey, 32) ||
    !isCanonicalBase64Bytes(candidate.encryptionPublicKey, 32) ||
    !candidate.trustState ||
    !["root", "verified", "unverified", "revoked"].includes(candidate.trustState)
  ) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (
    (candidate.name !== undefined && typeof candidate.name !== "string") ||
    (candidate.platform !== undefined && typeof candidate.platform !== "string") ||
    (candidate.appVersion !== undefined && typeof candidate.appVersion !== "string") ||
    (candidate.capabilities !== undefined &&
      (!Array.isArray(candidate.capabilities) ||
        !candidate.capabilities.every((value) => typeof value === "string")))
  ) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (
    candidate.approvalCertificate !== undefined &&
    !isValidApprovalCertificate(candidate.approvalCertificate)
  ) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  const hasPairingMetadata =
    candidate.pairedForDeviceId !== undefined ||
    candidate.pairingFingerprint !== undefined ||
    candidate.pinnedAt !== undefined;
  if (candidate.trustOrigin !== undefined &&
      candidate.trustOrigin !== "initial-tofu" &&
      candidate.trustOrigin !== "pairing") {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (candidate.trustState === "root" && !candidate.trustOrigin) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (candidate.trustOrigin === "initial-tofu" &&
      (candidate.trustState !== "root" || hasPairingMetadata)) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (candidate.trustOrigin === "pairing" &&
      (candidate.trustState !== "root" ||
        !isUuid(candidate.pairedForDeviceId) ||
        candidate.pairedForDeviceId === candidate.deviceId ||
        !PAIRING_FINGERPRINT_PATTERN.test(candidate.pairingFingerprint ?? "") ||
        !isValidTimestamp(candidate.pinnedAt))) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
  if (candidate.trustOrigin !== "pairing" && hasPairingMetadata) {
    throw new TrustStoreError("Persisted trust state is corrupt");
  }
}

function validIdentityFields(userId: string, identity: DeviceIdentity): void {
  if (
    identity.userId !== userId ||
    !isUuid(identity.deviceId) ||
    !isPositiveInteger(identity.keyVersion) ||
    !isCanonicalBase64Bytes(identity.signingPublicKeyBase64, 32) ||
    !isCanonicalBase64Bytes(identity.encryptionPublicKeyBase64, 32)
  ) {
    throw new TrustStoreError("The local identity is incomplete or corrupt");
  }
}

function isPersistedIdentityMatch(
  record: unknown,
  userId: string,
  identity: DeviceIdentity,
): record is StoredIdentityRecord {
  return (
    isValidStoredIdentityRecord(record) &&
    record.userId === userId &&
    record.deviceId === identity.deviceId &&
    record.registration?.keyVersion === identity.keyVersion &&
    record.signingPublicKeyBase64 === identity.signingPublicKeyBase64 &&
    record.encryptionPublicKeyBase64 === identity.encryptionPublicKeyBase64
  );
}

function sameRecord(left: LocalDeviceRecord, right: LocalDeviceRecord): boolean {
  return (
    sameKeys(left, right) &&
    left.userId === right.userId &&
    left.trustState === right.trustState &&
    left.name === right.name &&
    left.platform === right.platform &&
    left.appVersion === right.appVersion &&
    JSON.stringify(left.capabilities ?? []) === JSON.stringify(right.capabilities ?? []) &&
    JSON.stringify(left.approvalCertificate ?? null) ===
      JSON.stringify(right.approvalCertificate ?? null) &&
    left.trustOrigin === right.trustOrigin &&
    left.pairedForDeviceId === right.pairedForDeviceId &&
    left.pairingFingerprint === right.pairingFingerprint &&
    left.pinnedAt === right.pinnedAt
  );
}

function cloneCertificate(
  certificate: DeviceApprovalCertificate | undefined,
): DeviceApprovalCertificate | undefined {
  return certificate ? { ...certificate } : undefined;
}

function cloneDevice(device: LocalDeviceRecord): LocalDeviceRecord {
  return {
    ...device,
    capabilities: device.capabilities ? [...device.capabilities] : undefined,
    approvalCertificate: cloneCertificate(device.approvalCertificate),
  };
}

function locallyVerified(device: LocalDeviceRecord | null | undefined): device is ClientVerifiedDevice {
  return Boolean(
    device && (device.trustState === "root" || device.trustState === "verified"),
  );
}

function safeBootstrapMetadata(
  metadata: Partial<LocalDeviceRecord>,
): Omit<LocalDeviceRecord, "userId" | "deviceId" | "keyVersion" | "encryptionPublicKey" | "signingPublicKey" | "trustState"> {
  const safeMetadata = { ...metadata } as Partial<LocalDeviceRecord>;
  delete safeMetadata.userId;
  delete safeMetadata.deviceId;
  delete safeMetadata.keyVersion;
  delete safeMetadata.encryptionPublicKey;
  delete safeMetadata.signingPublicKey;
  delete safeMetadata.trustState;
  delete safeMetadata.approvalCertificate;
  delete safeMetadata.trustOrigin;
  delete safeMetadata.pairedForDeviceId;
  delete safeMetadata.pairingFingerprint;
  delete safeMetadata.pinnedAt;
  return safeMetadata;
}

function deviceFromIdentity(
  userId: string,
  identity: DeviceIdentity,
  trustState: "root" | "verified",
  metadata: Partial<LocalDeviceRecord> = {},
): ClientVerifiedDevice {
  validIdentityFields(userId, identity);
  return {
    ...safeBootstrapMetadata(metadata),
    userId,
    deviceId: identity.deviceId,
    keyVersion: identity.keyVersion!,
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    trustState,
    trustOrigin: "initial-tofu",
  };
}

function deviceFromPairedApprover(
  approver: LocalDeviceRecord,
  localIdentity: DeviceIdentity,
  confirmedFingerprint: string,
): ClientVerifiedDevice {
  const pinnedAt = new Date().toISOString();
  return {
    userId: approver.userId,
    deviceId: approver.deviceId,
    keyVersion: approver.keyVersion,
    encryptionPublicKey: approver.encryptionPublicKey,
    signingPublicKey: approver.signingPublicKey,
    name: approver.name,
    platform: approver.platform,
    capabilities: approver.capabilities ? [...approver.capabilities] : undefined,
    appVersion: approver.appVersion,
    trustState: "root",
    trustOrigin: "pairing",
    pairedForDeviceId: localIdentity.deviceId,
    pairingFingerprint: confirmedFingerprint,
    pinnedAt,
  };
}

function assertApprovalMatchesPending(
  pending: LocalDeviceRecord,
  certificate: DeviceApprovalCertificate,
): void {
  if (
    pending.keyVersion !== certificate.pendingKeyVersion ||
    pending.encryptionPublicKey !== certificate.pendingEncryptionPublicKey ||
    pending.signingPublicKey !== certificate.pendingSigningPublicKey
  ) {
    throw new TrustStoreError("The approval does not match the pending device record");
  }
}

function approvalDevice(
  pending: LocalDeviceRecord,
  certificate: DeviceApprovalCertificate,
): ClientVerifiedDevice {
  return {
    ...cloneDevice(pending),
    trustState: "verified",
    // Keep the signed certificate so a reconstructed store can audit and
    // rebuild the verified edge without trusting a later server label.
    approvalCertificate: { ...certificate },
  };
}

/**
 * Test-only, process-local implementation. Production code should use
 * IndexedDBTrustStore so roots, approvals, and revocations survive restarts.
 */
export class InMemoryTrustStore implements ClientTrustStore {
  private readonly devices = new Map<string, LocalDeviceRecord>();

  getDevice(userId: string, deviceId: string): LocalDeviceRecord | null {
    const device = this.devices.get(deviceKey(userId, deviceId));
    if (!device) {
      return null;
    }
    assertValidTrustRecord(device);
    return cloneDevice(device);
  }

  upsertServerReportedDevice(device: ServerReportedDevice): LocalDeviceRecord {
    if (
      typeof device.userId !== "string" ||
      device.userId.length === 0 ||
      !isUuid(device.deviceId) ||
      !isPositiveInteger(device.keyVersion) ||
      !isCanonicalBase64Bytes(device.encryptionPublicKey, 32) ||
      !isCanonicalBase64Bytes(device.signingPublicKey, 32)
    ) {
      throw new TrustStoreError("The server-reported device is invalid");
    }
    const key = deviceKey(device.userId, device.deviceId);
    const current = this.devices.get(key);
    const incoming: LocalDeviceRecord = {
      userId: device.userId,
      deviceId: device.deviceId,
      keyVersion: device.keyVersion,
      encryptionPublicKey: device.encryptionPublicKey,
      signingPublicKey: device.signingPublicKey,
      name: device.name,
      platform: device.platform,
      capabilities: device.capabilities ? [...device.capabilities] : undefined,
      appVersion: device.appVersion,
      trustState: device.trustState === "revoked" ? "revoked" : "unverified",
      approvalCertificate: undefined,
    };
    if (current?.trustState === "revoked") {
      return cloneDevice(current);
    }
    if (incoming.trustState === "revoked") {
      assertValidTrustRecord(incoming);
      this.devices.set(key, incoming);
      return cloneDevice(incoming);
    }
    if (locallyVerified(current)) {
      if (!sameKeys(current, incoming)) {
        throw new TrustStoreError("Trusted device metadata changed unexpectedly");
      }
      return cloneDevice(current);
    }
    assertValidTrustRecord(incoming);
    this.devices.set(key, incoming);
    return cloneDevice(incoming);
  }

  bootstrapInitialTrustAnchor(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): ClientVerifiedDevice {
    const device = deviceFromIdentity(userId, identity, "root", metadata);
    const current = this.getDevice(userId, identity.deviceId);
    if (current?.trustState === "revoked") {
      throw new TrustStoreError("A revoked device cannot become a trust anchor");
    }
    if (current && !sameKeys(current, device)) {
      throw new TrustStoreError("The local identity does not match the stored device");
    }
    const hasAnotherRoot = [...this.devices.values()].some(
      (candidate) => candidate.userId === userId && candidate.trustState === "root",
    );
    if (hasAnotherRoot) {
      throw new TrustStoreError("An account already has a local trust anchor");
    }
    assertValidTrustRecord(device);
    this.devices.set(deviceKey(userId, identity.deviceId), device);
    return cloneDevice(device) as ClientVerifiedDevice;
  }

  async pinPairedApprover(
    userId: string,
    localIdentity: DeviceIdentity,
    approverDeviceId: string,
    confirmedFingerprint: string,
  ): Promise<ClientVerifiedDevice> {
    validIdentityFields(userId, localIdentity);
    if (!PAIRING_FINGERPRINT_PATTERN.test(confirmedFingerprint)) {
      throw new TrustStoreError("The confirmed pairing fingerprint is invalid");
    }
    const pending = this.getDevice(userId, localIdentity.deviceId);
    if (
      !pending ||
      pending.trustState !== "unverified" ||
      !sameKeys(pending, {
        deviceId: localIdentity.deviceId,
        keyVersion: localIdentity.keyVersion!,
        encryptionPublicKey: localIdentity.encryptionPublicKeyBase64,
        signingPublicKey: localIdentity.signingPublicKeyBase64,
      })
    ) {
      throw new TrustStoreError("The local pending device is not present or does not match");
    }
    const approver = this.getDevice(userId, approverDeviceId);
    if (
      !approver ||
      approver.userId !== userId ||
      approver.deviceId === localIdentity.deviceId ||
      approver.trustState !== "unverified" ||
      !isPositiveInteger(approver.keyVersion) ||
      !isCanonicalBase64Bytes(approver.signingPublicKey, 32) ||
      !isCanonicalBase64Bytes(approver.encryptionPublicKey, 32)
    ) {
      throw new TrustStoreError("Only an unverified same-account device can be paired");
    }
    return this.pinApproverAfterFingerprint(
      userId,
      localIdentity,
      pending,
      approver,
      confirmedFingerprint,
    );
  }

  private async pinApproverAfterFingerprint(
    userId: string,
    localIdentity: DeviceIdentity,
    pending: LocalDeviceRecord,
    approver: LocalDeviceRecord,
    confirmedFingerprint: string,
  ): Promise<ClientVerifiedDevice> {
    const computedFingerprint = await pairingFingerprint({
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
    if (computedFingerprint !== confirmedFingerprint) {
      throw new TrustStoreError("The confirmed pairing fingerprint does not match");
    }
    const latestPending = this.getDevice(userId, localIdentity.deviceId);
    const latestApprover = this.getDevice(userId, approver.deviceId);
    if (
      !latestPending ||
      !latestApprover ||
      !sameRecord(latestPending, pending) ||
      !sameRecord(latestApprover, approver)
    ) {
      throw new TrustStoreError("Pairing records changed before the anchor was persisted");
    }
    if (this.devices.has(deviceKey(userId, approver.deviceId)) &&
        [...this.devices.values()].some(
          (candidate) => candidate.userId === userId && candidate.trustState === "root",
        )) {
      throw new TrustStoreError("An account already has a local trust anchor");
    }
    const root = deviceFromPairedApprover(approver, localIdentity, confirmedFingerprint);
    assertValidTrustRecord(root);
    this.devices.set(deviceKey(userId, approver.deviceId), root);
    return cloneDevice(root) as ClientVerifiedDevice;
  }

  pinInitialDevice(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): ClientVerifiedDevice {
    return this.bootstrapInitialTrustAnchor(userId, identity, metadata);
  }

  async applyApproval(
    userId: string,
    certificate: DeviceApprovalCertificate,
  ): Promise<ClientVerifiedDevice> {
    const approver = this.getDevice(userId, certificate.approvingDeviceId);
    const pending = this.getDevice(userId, certificate.pendingDeviceId);
    if (!approver || approver.userId !== userId || !locallyVerified(approver)) {
      throw new TrustStoreError("Only a locally trusted approver from this account can extend trust");
    }
    if (!pending || pending.userId !== userId || pending.trustState !== "unverified") {
      throw new TrustStoreError("The pending device is not present in the local trust store");
    }
    assertApprovalMatchesPending(pending, certificate);
    if (!(await verifyDeviceApproval({ userId, certificate, approverDevice: approver }))) {
      throw new TrustStoreError("The device approval signature is invalid");
    }
    const latestApprover = this.getDevice(userId, approver.deviceId);
    const latestPending = this.getDevice(userId, pending.deviceId);
    if (
      !latestApprover ||
      !latestPending ||
      !sameRecord(latestApprover, approver) ||
      !sameRecord(latestPending, pending) ||
      !locallyVerified(latestApprover) ||
      latestPending.trustState !== "unverified"
    ) {
      throw new TrustStoreError("The approval records changed before verification was persisted");
    }
    const verified = approvalDevice(pending, certificate);
    assertValidTrustRecord(verified);
    this.devices.set(deviceKey(userId, pending.deviceId), verified);
    return cloneDevice(verified) as ClientVerifiedDevice;
  }

  revokeDevice(userId: string, deviceId: string): void {
    const device = this.getDevice(userId, deviceId);
    if (device) {
      const revoked = {
        ...device,
        trustState: "revoked",
      } satisfies LocalDeviceRecord;
      assertValidTrustRecord(revoked);
      this.devices.set(deviceKey(userId, deviceId), revoked);
    }
  }

  listEncryptionRecipients(userId: string): ClientVerifiedDevice[] {
    return [...this.devices.values()]
      .filter((device): device is ClientVerifiedDevice => {
        assertValidTrustRecord(device);
        return device.userId === userId && locallyVerified(device);
      })
      .map((device) => cloneDevice(device) as ClientVerifiedDevice);
  }
}

function readStoredDevice(
  userId: string,
  deviceId: string,
): Promise<LocalDeviceRecord | null> {
  return withReadonlyRequest((store) => store.get(deviceKey(userId, deviceId))).then(
    (device) => {
      if (device === undefined) {
        return null;
      }
      assertValidTrustRecord(device);
      return cloneDevice(device);
    },
  );
}

function readStoredDevices(userId: string): Promise<LocalDeviceRecord[]> {
  return withReadonlyRequest((store) => store.getAll()).then((devices) =>
    (devices as unknown[]).map((device) => {
      assertValidTrustRecord(device);
      return device;
    }).filter((device) => device.userId === userId).map(cloneDevice),
  );
}

function withReadonlyRequest<T>(
  requestFactory: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openCryptoDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(TRUST_DEVICE_STORE, "readonly");
        const request = requestFactory(transaction.objectStore(TRUST_DEVICE_STORE));
        request.onerror = () => reject(request.error ?? new TrustStoreError("Unable to read trust state"));
        request.onsuccess = () => resolve(request.result);
        transaction.oncomplete = () => closeDatabase(database);
        transaction.onerror = () => {
          closeDatabase(database);
          reject(transaction.error ?? new TrustStoreError("Unable to read trust state"));
        };
        transaction.onabort = () => {
          closeDatabase(database);
          reject(transaction.error ?? new TrustStoreError("Unable to read trust state"));
        };
      }),
  );
}

function withReadwriteTransaction<T>(
  storeNames: string | string[],
  work: (
    transaction: IDBTransaction,
    finish: (value: T) => void,
    fail: (error: unknown) => void,
  ) => void,
): Promise<T> {
  return openCryptoDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeNames, "readwrite");
        let result: T;
        let hasResult = false;
        let failure: unknown;
        let settled = false;
        const finish = (value: T): void => {
          result = value;
          hasResult = true;
        };
        const fail = (error: unknown): void => {
          if (!failure) {
            failure = error;
          }
          try {
            transaction.abort();
          } catch {
            // The transaction may already be closing after a request error.
          }
        };
        transaction.oncomplete = () => {
          closeDatabase(database);
          if (settled) {
            return;
          }
          settled = true;
          if (failure) {
            reject(failure);
          } else if (hasResult) {
            resolve(result);
          } else {
            reject(new TrustStoreError("Trust-state transaction completed without a result"));
          }
        };
        transaction.onerror = () => {
          closeDatabase(database);
          if (!settled) {
            settled = true;
            reject(failure ?? transaction.error ?? new TrustStoreError("Unable to persist trust state"));
          }
        };
        transaction.onabort = () => {
          closeDatabase(database);
          if (!settled) {
            settled = true;
            reject(failure ?? transaction.error ?? new TrustStoreError("Unable to persist trust state"));
          }
        };
        try {
          work(transaction, finish, fail);
        } catch (error) {
          fail(error);
        }
      }),
  );
}

function normalizeServerReportedDevice(device: ServerReportedDevice): LocalDeviceRecord {
  if (
    typeof device.userId !== "string" ||
    device.userId.length === 0 ||
    !isUuid(device.deviceId) ||
    !isPositiveInteger(device.keyVersion) ||
    !isCanonicalBase64Bytes(device.encryptionPublicKey, 32) ||
    !isCanonicalBase64Bytes(device.signingPublicKey, 32)
  ) {
    throw new TrustStoreError("The server-reported device is invalid");
  }
  const incoming: LocalDeviceRecord = {
    userId: device.userId,
    deviceId: device.deviceId,
    keyVersion: device.keyVersion,
    encryptionPublicKey: device.encryptionPublicKey,
    signingPublicKey: device.signingPublicKey,
    name: device.name,
    platform: device.platform,
    capabilities: device.capabilities ? [...device.capabilities] : undefined,
    appVersion: device.appVersion,
    trustState: device.trustState === "revoked" ? "revoked" : "unverified",
    approvalCertificate: undefined,
  };
  assertValidTrustRecord(incoming);
  return incoming;
}

/** Durable production trust store. It contains only public/non-secret state. */
export class IndexedDBTrustStore implements ClientTrustStore {
  async getDevice(userId: string, deviceId: string): Promise<LocalDeviceRecord | null> {
    return readStoredDevice(userId, deviceId);
  }

  async upsertServerReportedDevice(device: ServerReportedDevice): Promise<LocalDeviceRecord> {
    const incoming = normalizeServerReportedDevice(device);
    return withReadwriteTransaction<LocalDeviceRecord>(
      TRUST_DEVICE_STORE,
      (transaction, finish, fail) => {
        const store = transaction.objectStore(TRUST_DEVICE_STORE);
        const request = store.get(deviceKey(incoming.userId, incoming.deviceId));
        request.onerror = () => fail(request.error ?? new TrustStoreError("Unable to read trust state"));
        request.onsuccess = () => {
          const raw = request.result as LocalDeviceRecord | undefined;
          if (raw !== undefined) {
            try {
              assertValidTrustRecord(raw);
            } catch (error) {
              fail(error);
              return;
            }
          }
          const current = raw;
          if (current?.trustState === "revoked") {
            finish(cloneDevice(current));
            return;
          }
          if (incoming.trustState === "revoked") {
            store.put(incoming, deviceKey(incoming.userId, incoming.deviceId));
            finish(cloneDevice(incoming));
            return;
          }
          if (locallyVerified(current)) {
            if (!sameKeys(current, incoming)) {
              fail(new TrustStoreError("Trusted device metadata changed unexpectedly"));
              return;
            }
            finish(cloneDevice(current));
            return;
          }
          store.put(incoming, deviceKey(incoming.userId, incoming.deviceId));
          finish(cloneDevice(incoming));
        };
      },
    );
  }

  async bootstrapInitialTrustAnchor(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): Promise<ClientVerifiedDevice> {
    const device = deviceFromIdentity(userId, identity, "root", metadata);
    assertValidTrustRecord(device);
    return withReadwriteTransaction<ClientVerifiedDevice>(
      [IDENTITY_STORE, TRUST_DEVICE_STORE],
      (transaction, finish, fail) => {
        const identityStore = transaction.objectStore(IDENTITY_STORE);
        const store = transaction.objectStore(TRUST_DEVICE_STORE);
        const identityRequest = identityStore.get(userId);
        const currentRequest = store.get(deviceKey(userId, identity.deviceId));
        const allRequest = store.getAll();
        let persistedIdentity: StoredIdentityRecord | undefined;
        let current: LocalDeviceRecord | undefined;
        let allDevices: LocalDeviceRecord[] | undefined;
        let identityReady = false;
        let currentReady = false;
        let allReady = false;
        const attempt = (): void => {
          if (!identityReady || !currentReady || !allReady) {
            return;
          }
          try {
            if (!persistedIdentity || !isPersistedIdentityMatch(persistedIdentity, userId, identity)) {
              throw new TrustStoreError("The identity is not the account's stored local identity");
            }
            if (current?.trustState === "revoked") {
              throw new TrustStoreError("A revoked device cannot become a trust anchor");
            }
            if (current && !sameKeys(current, device)) {
              throw new TrustStoreError("The local identity does not match the stored device");
            }
            if (allDevices!.some((candidate) => candidate.userId === userId && candidate.trustState === "root")) {
              throw new TrustStoreError("An account already has a local trust anchor");
            }
            store.put(device, deviceKey(userId, identity.deviceId));
            finish(device);
          } catch (error) {
            fail(error);
          }
        };
        identityRequest.onerror = () => fail(identityRequest.error ?? new TrustStoreError("Unable to read device identity"));
        identityRequest.onsuccess = () => {
          persistedIdentity = identityRequest.result as StoredIdentityRecord | undefined;
          identityReady = true;
          attempt();
        };
        currentRequest.onerror = () => fail(currentRequest.error ?? new TrustStoreError("Unable to read trust state"));
        currentRequest.onsuccess = () => {
          current = currentRequest.result as LocalDeviceRecord | undefined;
          if (current) {
            try {
              assertValidTrustRecord(current);
            } catch (error) {
              fail(error);
              return;
            }
          }
          currentReady = true;
          attempt();
        };
        allRequest.onerror = () => fail(allRequest.error ?? new TrustStoreError("Unable to read trust state"));
        allRequest.onsuccess = () => {
          try {
            allDevices = (allRequest.result as unknown[]).map((candidate) => {
              assertValidTrustRecord(candidate);
              return candidate;
            });
          } catch (error) {
            fail(error);
            return;
          }
          allReady = true;
          attempt();
        };
      },
    );
  }

  async pinPairedApprover(
    userId: string,
    localIdentity: DeviceIdentity,
    approverDeviceId: string,
    confirmedFingerprint: string,
  ): Promise<ClientVerifiedDevice> {
    validIdentityFields(userId, localIdentity);
    if (!PAIRING_FINGERPRINT_PATTERN.test(confirmedFingerprint)) {
      throw new TrustStoreError("The confirmed pairing fingerprint is invalid");
    }
    if (approverDeviceId === localIdentity.deviceId) {
      throw new TrustStoreError("A device cannot pair with itself");
    }
    const pending = await this.getDevice(userId, localIdentity.deviceId);
    const approver = await this.getDevice(userId, approverDeviceId);
    if (
      !pending ||
      pending.trustState !== "unverified" ||
      !sameKeys(pending, {
        deviceId: localIdentity.deviceId,
        keyVersion: localIdentity.keyVersion!,
        encryptionPublicKey: localIdentity.encryptionPublicKeyBase64,
        signingPublicKey: localIdentity.signingPublicKeyBase64,
      })
    ) {
      throw new TrustStoreError("The local pending device is not present or does not match");
    }
    if (
      !approver ||
      approver.userId !== userId ||
      approver.trustState !== "unverified" ||
      approver.deviceId === localIdentity.deviceId ||
      !isPositiveInteger(approver.keyVersion) ||
      !isCanonicalBase64Bytes(approver.signingPublicKey, 32) ||
      !isCanonicalBase64Bytes(approver.encryptionPublicKey, 32)
    ) {
      throw new TrustStoreError("Only an unverified same-account device can be paired");
    }
    const computedFingerprint = await pairingFingerprint({
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
    if (computedFingerprint !== confirmedFingerprint) {
      throw new TrustStoreError("The confirmed pairing fingerprint does not match");
    }
    const root = deviceFromPairedApprover(approver, localIdentity, confirmedFingerprint);
    assertValidTrustRecord(root);
    return withReadwriteTransaction<ClientVerifiedDevice>(
      [IDENTITY_STORE, TRUST_DEVICE_STORE],
      (transaction, finish, fail) => {
        const identityStore = transaction.objectStore(IDENTITY_STORE);
        const store = transaction.objectStore(TRUST_DEVICE_STORE);
        const identityRequest = identityStore.get(userId);
        const pendingRequest = store.get(deviceKey(userId, pending.deviceId));
        const approverRequest = store.get(deviceKey(userId, approver.deviceId));
        const allRequest = store.getAll();
        let latestPending: LocalDeviceRecord | undefined;
        let latestApprover: LocalDeviceRecord | undefined;
        let allDevices: LocalDeviceRecord[] | undefined;
        let persistedIdentity: StoredIdentityRecord | undefined;
        let identityReady = false;
        let pendingReady = false;
        let approverReady = false;
        let allReady = false;
        const attempt = (): void => {
          if (!identityReady || !pendingReady || !approverReady || !allReady) {
            return;
          }
          try {
            if (!persistedIdentity || !isPersistedIdentityMatch(persistedIdentity, userId, localIdentity)) {
              throw new TrustStoreError("The identity is not the account's stored local identity");
            }
            if (!latestPending || !latestApprover ||
                !sameRecord(latestPending, pending) ||
                !sameRecord(latestApprover, approver)) {
              throw new TrustStoreError("Pairing records changed before the anchor was persisted");
            }
            if (latestPending.trustState !== "unverified" ||
                latestApprover.trustState !== "unverified") {
              throw new TrustStoreError("Pairing requires both devices to remain unverified");
            }
            if (allDevices!.some((candidate) => candidate.userId === userId && candidate.trustState === "root")) {
              throw new TrustStoreError("An account already has a local trust anchor");
            }
            store.put(root, deviceKey(userId, root.deviceId));
            finish(root);
          } catch (error) {
            fail(error);
          }
        };
        identityRequest.onerror = () => fail(identityRequest.error ?? new TrustStoreError("Unable to read device identity"));
        identityRequest.onsuccess = () => {
          persistedIdentity = identityRequest.result as StoredIdentityRecord | undefined;
          identityReady = true;
          attempt();
        };
        const read = (
          request: IDBRequest<unknown>,
          assign: (value: LocalDeviceRecord | undefined) => void,
          ready: () => void,
        ): void => {
          request.onerror = () => fail(request.error ?? new TrustStoreError("Unable to read trust state"));
          request.onsuccess = () => {
            const value = request.result as LocalDeviceRecord | undefined;
            if (value) {
              try {
                assertValidTrustRecord(value);
              } catch (error) {
                fail(error);
                return;
              }
            }
            assign(value);
            ready();
            attempt();
          };
        };
        read(pendingRequest, (value) => { latestPending = value; }, () => { pendingReady = true; });
        read(approverRequest, (value) => { latestApprover = value; }, () => { approverReady = true; });
        allRequest.onerror = () => fail(allRequest.error ?? new TrustStoreError("Unable to read trust state"));
        allRequest.onsuccess = () => {
          try {
            allDevices = (allRequest.result as unknown[]).map((candidate) => {
              assertValidTrustRecord(candidate);
              return candidate;
            });
          } catch (error) {
            fail(error);
            return;
          }
          allReady = true;
          attempt();
        };
      },
    );
  }

  pinInitialDevice(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): Promise<ClientVerifiedDevice> {
    return this.bootstrapInitialTrustAnchor(userId, identity, metadata);
  }

  async applyApproval(
    userId: string,
    certificate: DeviceApprovalCertificate,
  ): Promise<ClientVerifiedDevice> {
    const approver = await this.getDevice(userId, certificate.approvingDeviceId);
    const pending = await this.getDevice(userId, certificate.pendingDeviceId);
    if (!approver || approver.userId !== userId || !locallyVerified(approver)) {
      throw new TrustStoreError("Only a locally trusted approver from this account can extend trust");
    }
    if (!pending || pending.userId !== userId || pending.trustState !== "unverified") {
      throw new TrustStoreError("The pending device is not present in the local trust store");
    }
    assertApprovalMatchesPending(pending, certificate);
    if (!(await verifyDeviceApproval({ userId, certificate, approverDevice: approver }))) {
      throw new TrustStoreError("The device approval signature is invalid");
    }
    return withReadwriteTransaction<ClientVerifiedDevice>(
      TRUST_DEVICE_STORE,
      (transaction, finish, fail) => {
        const store = transaction.objectStore(TRUST_DEVICE_STORE);
        const approverRequest = store.get(deviceKey(userId, approver.deviceId));
        const pendingRequest = store.get(deviceKey(userId, pending.deviceId));
        let latestApprover: LocalDeviceRecord | undefined;
        let latestPending: LocalDeviceRecord | undefined;
        let approverReady = false;
        let pendingReady = false;
        const attempt = (): void => {
          if (!approverReady || !pendingReady) {
            return;
          }
          try {
            if (!latestApprover || !latestPending ||
                !sameRecord(latestApprover, approver) ||
                !sameRecord(latestPending, pending)) {
              throw new TrustStoreError("The approval records changed before verification was persisted");
            }
            if (!locallyVerified(latestApprover) || latestPending.trustState !== "unverified") {
              throw new TrustStoreError("The approval trust transition is no longer valid");
            }
            assertApprovalMatchesPending(latestPending, certificate);
            const verified = approvalDevice(latestPending, certificate);
            assertValidTrustRecord(verified);
            store.put(verified, deviceKey(userId, verified.deviceId));
            finish(verified);
          } catch (error) {
            fail(error);
          }
        };
        const read = (
          request: IDBRequest<unknown>,
          assign: (value: LocalDeviceRecord | undefined) => void,
          ready: () => void,
        ): void => {
          request.onerror = () => fail(request.error ?? new TrustStoreError("Unable to read trust state"));
          request.onsuccess = () => {
            const value = request.result as LocalDeviceRecord | undefined;
            if (!value) {
              assign(undefined);
              ready();
              attempt();
              return;
            }
            try {
              assertValidTrustRecord(value);
            } catch (error) {
              fail(error);
              return;
            }
            assign(value);
            ready();
            attempt();
          };
        };
        read(approverRequest, (value) => { latestApprover = value; }, () => { approverReady = true; });
        read(pendingRequest, (value) => { latestPending = value; }, () => { pendingReady = true; });
      },
    );
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await withReadwriteTransaction<void>(
      TRUST_DEVICE_STORE,
      (transaction, finish, fail) => {
        const store = transaction.objectStore(TRUST_DEVICE_STORE);
        const request = store.get(deviceKey(userId, deviceId));
        request.onerror = () => fail(request.error ?? new TrustStoreError("Unable to read trust state"));
        request.onsuccess = () => {
          const device = request.result as LocalDeviceRecord | undefined;
          if (!device) {
            finish(undefined);
            return;
          }
          try {
            assertValidTrustRecord(device);
            if (device.trustState === "revoked") {
              finish(undefined);
              return;
            }
            const revoked = { ...device, trustState: "revoked" } satisfies LocalDeviceRecord;
            assertValidTrustRecord(revoked);
            store.put(revoked, deviceKey(userId, deviceId));
            finish(undefined);
          } catch (error) {
            fail(error);
          }
        };
      },
    );
  }

  async listEncryptionRecipients(userId: string): Promise<ClientVerifiedDevice[]> {
    return (await readStoredDevices(userId))
      .filter((device): device is ClientVerifiedDevice => locallyVerified(device))
      .map((device) => cloneDevice(device) as ClientVerifiedDevice);
  }
}

export const DurableTrustStore = IndexedDBTrustStore;
