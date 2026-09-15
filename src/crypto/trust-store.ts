import type { DeviceIdentity } from "./key-store.ts";
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

export interface ClientTrustStore {
  getDevice(userId: string, deviceId: string): LocalDeviceRecord | null;
  upsertServerReportedDevice(device: Omit<LocalDeviceRecord, "trustState"> & { trustState?: string }): LocalDeviceRecord;
  pinInitialDevice(userId: string, identity: DeviceIdentity, metadata?: Partial<LocalDeviceRecord>): ClientVerifiedDevice;
  applyApproval(
    userId: string,
    certificate: DeviceApprovalCertificate,
  ): Promise<ClientVerifiedDevice>;
  revokeDevice(userId: string, deviceId: string): void;
  listEncryptionRecipients(userId: string): ClientVerifiedDevice[];
}

function sameKeys(left: LocalDeviceRecord, right: Omit<LocalDeviceRecord, "trustState">): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.keyVersion === right.keyVersion &&
    left.encryptionPublicKey === right.encryptionPublicKey &&
    left.signingPublicKey === right.signingPublicKey
  );
}

function cloneDevice(device: LocalDeviceRecord): LocalDeviceRecord {
  return {
    ...device,
    capabilities: device.capabilities ? [...device.capabilities] : undefined,
  };
}

/**
 * In-memory by design for this phase: callers can replace it with a durable
 * implementation without changing crypto-core APIs. Server reports enter as
 * unverified and can never be encryption recipients until locally verified.
 */
export class InMemoryTrustStore implements ClientTrustStore {
  private readonly devices = new Map<string, LocalDeviceRecord>();

  getDevice(userId: string, deviceId: string): LocalDeviceRecord | null {
    const device = this.devices.get(`${userId}:${deviceId}`);
    return device ? cloneDevice(device) : null;
  }

  upsertServerReportedDevice(
    device: Omit<LocalDeviceRecord, "trustState"> & { trustState?: string },
  ): LocalDeviceRecord {
    const key = `${device.userId}:${device.deviceId}`;
    const current = this.devices.get(key);
    const incoming = {
      ...device,
      trustState: device.trustState === "revoked" ? "revoked" : "unverified",
    } as LocalDeviceRecord;
    if (incoming.trustState === "revoked") {
      this.devices.set(key, incoming);
      return cloneDevice(incoming);
    }
    if (current?.trustState === "revoked") {
      return cloneDevice(current);
    }
    if (current && (current.trustState === "root" || current.trustState === "verified")) {
      if (!sameKeys(current, incoming)) {
        throw new TrustStoreError("Trusted device metadata changed unexpectedly");
      }
      return cloneDevice(current);
    }
    this.devices.set(key, incoming);
    return cloneDevice(incoming);
  }

  pinInitialDevice(
    userId: string,
    identity: DeviceIdentity,
    metadata: Partial<LocalDeviceRecord> = {},
  ): ClientVerifiedDevice {
    if (identity.keyVersion === null) {
      throw new TrustStoreError("The device must be registered before it can be a trust anchor");
    }
    const key = `${userId}:${identity.deviceId}`;
    const current = this.devices.get(key);
    if (current?.trustState === "revoked") {
      throw new TrustStoreError("A revoked device cannot become a trust anchor");
    }
    if (current && !sameKeys(current, {
      userId,
      deviceId: identity.deviceId,
      keyVersion: identity.keyVersion,
      encryptionPublicKey: identity.encryptionPublicKeyBase64,
      signingPublicKey: identity.signingPublicKeyBase64,
    })) {
      throw new TrustStoreError("The local identity does not match the stored device");
    }
    const hasAnotherRoot = [...this.devices.values()].some(
      (device) => device.userId === userId && device.trustState === "root" && device.deviceId !== identity.deviceId,
    );
    if (hasAnotherRoot) {
      throw new TrustStoreError("An account already has a local trust anchor");
    }
    const safeMetadata = { ...metadata };
    delete safeMetadata.userId;
    delete safeMetadata.deviceId;
    delete safeMetadata.keyVersion;
    delete safeMetadata.encryptionPublicKey;
    delete safeMetadata.signingPublicKey;
    delete safeMetadata.trustState;
    const device: ClientVerifiedDevice = {
      ...safeMetadata,
      userId,
      deviceId: identity.deviceId,
      keyVersion: identity.keyVersion,
      encryptionPublicKey: identity.encryptionPublicKeyBase64,
      signingPublicKey: identity.signingPublicKeyBase64,
      trustState: "root",
    };
    this.devices.set(key, device);
    return cloneDevice(device) as ClientVerifiedDevice;
  }

  async applyApproval(
    userId: string,
    certificate: DeviceApprovalCertificate,
  ): Promise<ClientVerifiedDevice> {
    const approver = this.getDevice(userId, certificate.approvingDeviceId);
    const pending = this.getDevice(userId, certificate.pendingDeviceId);
    if (!approver || (approver.trustState !== "root" && approver.trustState !== "verified")) {
      throw new TrustStoreError("Only a locally trusted approver can extend trust");
    }
    if (!pending || pending.trustState === "revoked") {
      throw new TrustStoreError("The pending device is not present in the local trust store");
    }
    if (
      pending.keyVersion !== certificate.pendingKeyVersion ||
      pending.encryptionPublicKey !== certificate.pendingEncryptionPublicKey ||
      pending.signingPublicKey !== certificate.pendingSigningPublicKey
    ) {
      throw new TrustStoreError("The approval does not match the pending device record");
    }
    if (!(await verifyDeviceApproval({ userId, certificate, approverDevice: approver }))) {
      throw new TrustStoreError("The device approval signature is invalid");
    }
    const verified: ClientVerifiedDevice = { ...pending, trustState: "verified" };
    this.devices.set(`${userId}:${pending.deviceId}`, verified);
    return cloneDevice(verified) as ClientVerifiedDevice;
  }

  revokeDevice(userId: string, deviceId: string): void {
    const device = this.getDevice(userId, deviceId);
    if (device) {
      this.devices.set(`${userId}:${deviceId}`, { ...device, trustState: "revoked" });
    }
  }

  listEncryptionRecipients(userId: string): ClientVerifiedDevice[] {
    return [...this.devices.values()]
      .filter(
        (device): device is ClientVerifiedDevice =>
          device.userId === userId &&
          (device.trustState === "root" || device.trustState === "verified"),
      )
      .map((device) => cloneDevice(device) as ClientVerifiedDevice);
  }
}
