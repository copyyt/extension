import type { DeviceIdentity } from "./key-store.ts";
import {
  closeDatabase,
  TRUST_DEVICE_STORE,
  openCryptoDatabase,
} from "./storage.ts";
import {
  type DeviceApprovalCertificate,
  verifyDeviceApproval,
} from "./crypto-core.ts";

export type LocalTrustState = "root" | "verified" | "unverified" | "revoked";

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
  left: Pick<LocalDeviceRecord, "deviceId" | "keyVersion" | "encryptionPublicKey" | "signingPublicKey">,
  right: Pick<LocalDeviceRecord, "deviceId" | "keyVersion" | "encryptionPublicKey" | "signingPublicKey">,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.keyVersion === right.keyVersion &&
    left.encryptionPublicKey === right.encryptionPublicKey &&
    left.signingPublicKey === right.signingPublicKey
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
  return safeMetadata;
}

function deviceFromIdentity(
  userId: string,
  identity: DeviceIdentity,
  trustState: "root" | "verified",
  metadata: Partial<LocalDeviceRecord> = {},
): ClientVerifiedDevice {
  if (identity.userId !== userId) {
    throw new TrustStoreError("The local identity belongs to another account");
  }
  if (identity.keyVersion === null || !Number.isSafeInteger(identity.keyVersion) || identity.keyVersion <= 0) {
    throw new TrustStoreError("The device must be registered before it can be a trust anchor");
  }
  return {
    ...safeBootstrapMetadata(metadata),
    userId,
    deviceId: identity.deviceId,
    keyVersion: identity.keyVersion,
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    trustState,
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
    return device ? cloneDevice(device) : null;
  }

  upsertServerReportedDevice(device: ServerReportedDevice): LocalDeviceRecord {
    const key = deviceKey(device.userId, device.deviceId);
    const current = this.devices.get(key);
    const incoming: LocalDeviceRecord = {
      ...device,
      trustState: device.trustState === "revoked" ? "revoked" : "unverified",
      approvalCertificate: undefined,
    };
    if (current?.trustState === "revoked") {
      return cloneDevice(current);
    }
    if (incoming.trustState === "revoked") {
      this.devices.set(key, incoming);
      return cloneDevice(incoming);
    }
    if (locallyVerified(current)) {
      if (!sameKeys(current, incoming)) {
        throw new TrustStoreError("Trusted device metadata changed unexpectedly");
      }
      return cloneDevice(current);
    }
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
    this.devices.set(deviceKey(userId, identity.deviceId), device);
    return cloneDevice(device) as ClientVerifiedDevice;
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
    if (!pending || pending.userId !== userId || pending.trustState === "revoked") {
      throw new TrustStoreError("The pending device is not present in the local trust store");
    }
    assertApprovalMatchesPending(pending, certificate);
    if (!(await verifyDeviceApproval({ userId, certificate, approverDevice: approver }))) {
      throw new TrustStoreError("The device approval signature is invalid");
    }
    const verified = approvalDevice(pending, certificate);
    this.devices.set(deviceKey(userId, pending.deviceId), verified);
    return cloneDevice(verified) as ClientVerifiedDevice;
  }

  revokeDevice(userId: string, deviceId: string): void {
    const device = this.getDevice(userId, deviceId);
    if (device) {
      this.devices.set(deviceKey(userId, deviceId), {
        ...device,
        trustState: "revoked",
      });
    }
  }

  listEncryptionRecipients(userId: string): ClientVerifiedDevice[] {
    return [...this.devices.values()]
      .filter((device): device is ClientVerifiedDevice => device.userId === userId && locallyVerified(device))
      .map((device) => cloneDevice(device) as ClientVerifiedDevice);
  }
}

function readStoredDevice(
  userId: string,
  deviceId: string,
): Promise<LocalDeviceRecord | null> {
  return withReadonlyRequest((store) => store.get(deviceKey(userId, deviceId)));
}

function readStoredDevices(userId: string): Promise<LocalDeviceRecord[]> {
  return withReadonlyRequest((store) => store.getAll()).then((devices) =>
    (devices as LocalDeviceRecord[])
      .filter((device) => device.userId === userId)
      .map(cloneDevice),
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
        transaction.onerror = () => reject(transaction.error ?? new TrustStoreError("Unable to read trust state"));
        transaction.onabort = () => reject(transaction.error ?? new TrustStoreError("Unable to read trust state"));
      }),
  );
}

function writeStoredDevice(device: LocalDeviceRecord): Promise<void> {
  return openCryptoDatabase().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(TRUST_DEVICE_STORE, "readwrite");
        transaction.objectStore(TRUST_DEVICE_STORE).put(device, deviceKey(device.userId, device.deviceId));
        transaction.oncomplete = () => {
          closeDatabase(database);
          resolve();
        };
        transaction.onerror = () => {
          closeDatabase(database);
          reject(transaction.error ?? new TrustStoreError("Unable to persist trust state"));
        };
        transaction.onabort = () => {
          closeDatabase(database);
          reject(transaction.error ?? new TrustStoreError("Unable to persist trust state"));
        };
      }),
  );
}

/** Durable production trust store. It contains only public/non-secret state. */
export class IndexedDBTrustStore implements ClientTrustStore {
  async getDevice(userId: string, deviceId: string): Promise<LocalDeviceRecord | null> {
    const device = await readStoredDevice(userId, deviceId);
    return device ? cloneDevice(device) : null;
  }

  async upsertServerReportedDevice(device: ServerReportedDevice): Promise<LocalDeviceRecord> {
    const current = await this.getDevice(device.userId, device.deviceId);
    const incoming: LocalDeviceRecord = {
      ...device,
      trustState: device.trustState === "revoked" ? "revoked" : "unverified",
      approvalCertificate: undefined,
    };
    if (current?.trustState === "revoked") {
      return current;
    }
    if (incoming.trustState === "revoked") {
      await writeStoredDevice(incoming);
      return cloneDevice(incoming);
    }
    if (locallyVerified(current)) {
      if (!sameKeys(current, incoming)) {
        throw new TrustStoreError("Trusted device metadata changed unexpectedly");
      }
      return current;
    }
    await writeStoredDevice(incoming);
    return cloneDevice(incoming);
  }

  async bootstrapInitialTrustAnchor(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): Promise<ClientVerifiedDevice> {
    // The durable implementation requires the identity to be the account's
    // currently stored local identity, not merely a caller-supplied key object.
    const { getDeviceIdentity } = await import("./key-store.ts");
    const storedIdentity = await getDeviceIdentity(userId);
    if (
      !storedIdentity ||
      storedIdentity.deviceId !== identity.deviceId ||
      storedIdentity.signingPublicKeyBase64 !== identity.signingPublicKeyBase64 ||
      storedIdentity.encryptionPublicKeyBase64 !== identity.encryptionPublicKeyBase64
    ) {
      throw new TrustStoreError("The identity is not the account's stored local identity");
    }
    const device = deviceFromIdentity(userId, identity, "root", metadata);
    const current = await this.getDevice(userId, identity.deviceId);
    if (current?.trustState === "revoked") {
      throw new TrustStoreError("A revoked device cannot become a trust anchor");
    }
    if (current && !sameKeys(current, device)) {
      throw new TrustStoreError("The local identity does not match the stored device");
    }
    const allDevices = await readStoredDevices(userId);
    if (allDevices.some((candidate) => candidate.trustState === "root")) {
      throw new TrustStoreError("An account already has a local trust anchor");
    }
    await writeStoredDevice(device);
    return cloneDevice(device) as ClientVerifiedDevice;
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
    if (!pending || pending.userId !== userId || pending.trustState === "revoked") {
      throw new TrustStoreError("The pending device is not present in the local trust store");
    }
    assertApprovalMatchesPending(pending, certificate);
    if (!(await verifyDeviceApproval({ userId, certificate, approverDevice: approver }))) {
      throw new TrustStoreError("The device approval signature is invalid");
    }
    const verified = approvalDevice(pending, certificate);
    const latest = await this.getDevice(userId, pending.deviceId);
    if (!latest || latest.trustState === "revoked" || !sameKeys(latest, pending)) {
      throw new TrustStoreError("The pending device changed before approval was persisted");
    }
    await writeStoredDevice(verified);
    return cloneDevice(verified) as ClientVerifiedDevice;
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.getDevice(userId, deviceId);
    if (device) {
      await writeStoredDevice({ ...device, trustState: "revoked" });
    }
  }

  async listEncryptionRecipients(userId: string): Promise<ClientVerifiedDevice[]> {
    return (await readStoredDevices(userId))
      .filter((device): device is ClientVerifiedDevice => locallyVerified(device))
      .map((device) => cloneDevice(device) as ClientVerifiedDevice);
  }
}

export const DurableTrustStore = IndexedDBTrustStore;
