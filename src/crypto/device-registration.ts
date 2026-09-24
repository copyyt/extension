import type { AxiosResponse } from "axios";
import {
  base64ToBytes,
  bytesToBase64,
} from "./bytes.ts";
import {
  generateRecoveryKeyPair,
  getOrCreateDeviceIdentity,
  persistRecoveryKeyPair,
  persistDeviceRegistrationMetadata,
  type DeviceIdentity,
} from "./key-store.ts";
import { signDeviceManagement, signDeviceRecovery } from "./crypto-core.ts";
import type { ClientTrustStore } from "./trust-store.ts";

export interface DeviceRegistrationRequest {
  deviceId: string;
  name: string;
  platform: "chrome";
  encryptionPublicKey: string;
  signingPublicKey: string;
  recoveryPublicKey: string;
  requestingDeviceId?: string;
  requestingKeyVersion?: number;
  managementTimestamp?: number;
  managementNonce?: string;
  managementSignature?: string;
  capabilities: string[];
  appVersion: string;
}

export interface RegisteredDeviceResponse {
  deviceId: string;
  name: string;
  platform: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  trustState: string;
  keyVersion: number;
  capabilities: string[];
  appVersion?: string;
  lastSeenAt?: string;
  revokedAt?: string | null;
  approvedByDeviceId?: string | null;
  approvalSignature?: string | null;
  approvedAt?: string | null;
  recoveryKeyRotated?: boolean;
  /** Registration only: this device's recovery key is the account's active one. */
  recoveryKeyActive?: boolean;
}

/** Signed proof that a trusted device authorized a revoke. */
export interface DeviceManagementRequest {
  requestingDeviceId: string;
  requestingKeyVersion: number;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface DeviceRecoveryRequest {
  rootDeviceId: string;
  deviceId: string;
  name: string;
  platform: "chrome";
  encryptionPublicKey: string;
  signingPublicKey: string;
  newRecoveryPublicKey: string;
  capabilities: string[];
  appVersion: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export type RegisteredDeviceListResponse =
  | RegisteredDeviceResponse[]
  | { devices: RegisteredDeviceResponse[] }
  | { pendingDevices: RegisteredDeviceResponse[] }
  | { data: RegisteredDeviceResponse[] };

export interface DeviceRegistrationApi {
  registerDevice(
    request: DeviceRegistrationRequest,
  ): Promise<AxiosResponse<RegisteredDeviceResponse>>;
  listPendingDevices(): Promise<AxiosResponse<RegisteredDeviceListResponse>>;
  approveDevice(
    request: ApproveDeviceRequest,
  ): Promise<AxiosResponse<RegisteredDeviceResponse>>;
  recoverDevice(
    request: DeviceRecoveryRequest,
  ): Promise<AxiosResponse<RegisteredDeviceResponse>>;
}

export interface ApproveDeviceRequest {
  approvingDeviceId: string;
  pendingDeviceId: string;
  approvalSignature: string;
}

/** @deprecated Use ApproveDeviceRequest for the backend HTTP DTO. */
export type DeviceApprovalRequest = ApproveDeviceRequest;

export interface RegisterCurrentDeviceOptions {
  userId: string;
  name: string;
  capabilities?: string[];
  appVersion: string;
  trustStore?: ClientTrustStore;
}

export interface RecoveryCredential {
  format: "copyyt-recovery-v1";
  rootDeviceId: string;
  privateKeyPkcs8Base64: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function parseRecoveryCredential(
  value: string,
): Promise<{ rootDeviceId: string; privateKey: CryptoKey }> {
  if (typeof value !== "string") {
    throw new TypeError("The recovery credential must be text");
  }
  // Tolerate what saving and re-pasting commonly adds: CRLF line endings,
  // surrounding blank lines and trailing spaces on each line.
  const lines = value
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (lines.length !== 3 || lines[0] !== "copyyt-recovery-v1") {
    throw new TypeError("The recovery credential format is invalid");
  }
  const rootDeviceId = lines[1]?.startsWith("rootDeviceId=")
    ? lines[1].slice("rootDeviceId=".length)
    : "";
  const privateKeyText = lines[2]?.startsWith("privateKeyPkcs8Base64=")
    ? lines[2].slice("privateKeyPkcs8Base64=".length)
    : "";
  if (!UUID_PATTERN.test(rootDeviceId) || !privateKeyText) {
    throw new TypeError("The recovery credential fields are invalid");
  }
  const bytes = base64ToBytes(privateKeyText);
  if (
    bytes.length === 0 ||
    bytesToBase64(bytes) !== privateKeyText
  ) {
    throw new TypeError("The recovery private key encoding is invalid");
  }
  let privateKey: CryptoKey;
  try {
    privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    throw new TypeError("The recovery private key is not a valid Ed25519 PKCS#8 key");
  }
  if (
    privateKey.type !== "private" ||
    privateKey.algorithm.name !== "Ed25519" ||
    !privateKey.usages.includes("sign")
  ) {
    throw new TypeError("The recovery private key is not an Ed25519 signing key");
  }
  return { rootDeviceId, privateKey };
}

export interface RecoverCurrentDeviceOptions {
  userId: string;
  name: string;
  capabilities?: string[];
  appVersion: string;
  credential: string | RecoveryCredential;
  trustStore?: ClientTrustStore;
}

export async function recoverCurrentDevice(
  api: DeviceRegistrationApi,
  options: RecoverCurrentDeviceOptions,
): Promise<{
  identity: DeviceIdentity;
  device: RegisteredDeviceResponse;
  recoveryKeyRotated: boolean;
}> {
  const identity = await getOrCreateDeviceIdentity(options.userId);
  if (identity.keyVersion === null) {
    throw new Error("The current device must be registered before recovery");
  }
  const parsed = typeof options.credential === "string"
    ? await parseRecoveryCredential(options.credential)
    : await parseRecoveryCredential(
        [
          options.credential.format,
          `rootDeviceId=${options.credential.rootDeviceId}`,
          `privateKeyPkcs8Base64=${options.credential.privateKeyPkcs8Base64}`,
        ].join("\n"),
      );
  let recoveryPrivateKey: CryptoKey | null = parsed.privateKey;
  try {
    const recovery = await generateRecoveryKeyPair();
    const timestamp = Date.now();
    const nonce = globalThis.crypto.randomUUID();
    const message = {
      userId: options.userId,
      rootDeviceId: parsed.rootDeviceId,
      deviceId: identity.deviceId,
      name: options.name,
      platform: "chrome" as const,
      encryptionPublicKey: identity.encryptionPublicKeyBase64,
      signingPublicKey: identity.signingPublicKeyBase64,
      capabilities: [...(options.capabilities ?? [])],
      appVersion: options.appVersion,
      timestamp,
      nonce,
      newRecoveryPublicKey: recovery.publicKeyBase64,
    };
    // userId is bound by the signature, but the backend takes it from the
    // authenticated session and rejects it as an unknown body field.
    const { userId: _signedUserId, ...body } = message;
    void _signedUserId;
    const request: DeviceRecoveryRequest = {
      ...body,
      signature: await signDeviceRecovery({
        recoveryPrivateKey,
        message,
      }),
    };
    const response = await api.recoverDevice(request);
    const device = response.data;
    if (
      device.deviceId !== identity.deviceId ||
      device.encryptionPublicKey !== identity.encryptionPublicKeyBase64 ||
      device.signingPublicKey !== identity.signingPublicKeyBase64 ||
      device.trustState !== "trusted" ||
      !Number.isSafeInteger(device.keyVersion) ||
      device.keyVersion <= 0
    ) {
      throw new Error("The recovery response does not match the local identity");
    }
    const registeredIdentity = await persistDeviceRegistrationMetadata(identity, {
      keyVersion: device.keyVersion,
      name: device.name,
      platform: device.platform,
      capabilities: [...device.capabilities],
      appVersion: device.appVersion,
    });
    const recoveryKeyRotated = device.recoveryKeyRotated !== false;
    const updatedIdentity = recoveryKeyRotated
      ? await persistRecoveryKeyPair(registeredIdentity, recovery)
      : registeredIdentity;
    if (options.trustStore) {
      await options.trustStore.recoverTrustAnchor(options.userId, updatedIdentity, {
        name: device.name,
        platform: device.platform,
        capabilities: [...device.capabilities],
        appVersion: device.appVersion,
      });
    }
    return { identity: updatedIdentity, device, recoveryKeyRotated };
  } finally {
    recoveryPrivateKey = null;
  }
}

export async function registerCurrentDevice(
  api: DeviceRegistrationApi,
  options: RegisterCurrentDeviceOptions,
): Promise<{ identity: DeviceIdentity; device: RegisteredDeviceResponse }> {
  const identity = await getOrCreateDeviceIdentity(options.userId);
  const request: DeviceRegistrationRequest = {
    deviceId: identity.deviceId,
    name: options.name,
    platform: "chrome",
    encryptionPublicKey: identity.encryptionPublicKeyBase64,
    signingPublicKey: identity.signingPublicKeyBase64,
    recoveryPublicKey: identity.recoveryPublicKeyBase64,
    capabilities: [...(options.capabilities ?? [])],
    appVersion: options.appVersion,
  };
  if (identity.keyVersion !== null) {
    const managementTimestamp = Date.now();
    const managementNonce = globalThis.crypto.randomUUID();
    request.requestingDeviceId = identity.deviceId;
    request.requestingKeyVersion = identity.keyVersion;
    request.managementTimestamp = managementTimestamp;
    request.managementNonce = managementNonce;
    request.managementSignature = await signDeviceManagement({
      userId: options.userId,
      identity,
      action: "update",
      targetDeviceId: identity.deviceId,
      targetKeyVersion: identity.keyVersion,
      timestamp: managementTimestamp,
      nonce: managementNonce,
      name: options.name,
      platform: "chrome",
      capabilities: [...(options.capabilities ?? [])],
      appVersion: options.appVersion,
      recoveryPublicKey: identity.recoveryPublicKeyBase64,
    });
  }
  const response = await api.registerDevice(request);
  const device = response.data;
  if (
    device.deviceId !== identity.deviceId ||
    device.encryptionPublicKey !== identity.encryptionPublicKeyBase64 ||
    device.signingPublicKey !== identity.signingPublicKeyBase64 ||
    !Number.isSafeInteger(device.keyVersion) ||
    device.keyVersion <= 0
  ) {
    throw new Error("The device registration response does not match the local identity");
  }
  const updatedIdentity = await persistDeviceRegistrationMetadata(identity, {
    keyVersion: device.keyVersion,
    name: device.name,
    platform: device.platform,
    capabilities: [...device.capabilities],
    appVersion: device.appVersion,
  });
  if (options.trustStore) {
    // Registration is only a server observation. In particular, a server
    // "trusted" label never establishes a client-side cryptographic root.
    await options.trustStore.upsertServerReportedDevice({
      userId: options.userId,
      deviceId: identity.deviceId,
      keyVersion: device.keyVersion,
      encryptionPublicKey: device.encryptionPublicKey,
      signingPublicKey: device.signingPublicKey,
      name: device.name,
      platform: device.platform,
      capabilities: [...device.capabilities],
      appVersion: device.appVersion,
      trustState: device.trustState,
    });
  }
  return { identity: updatedIdentity, device };
}
