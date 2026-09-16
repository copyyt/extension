import type { AxiosResponse } from "axios";
import {
  getOrCreateDeviceIdentity,
  persistDeviceRegistrationMetadata,
  type DeviceIdentity,
} from "./key-store.ts";
import type { ClientTrustStore } from "./trust-store.ts";

export interface DeviceRegistrationRequest {
  deviceId: string;
  name: string;
  platform: "chrome";
  encryptionPublicKey: string;
  signingPublicKey: string;
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
}

export type RegisteredDeviceListResponse =
  | RegisteredDeviceResponse[]
  | { devices: RegisteredDeviceResponse[] }
  | { data: RegisteredDeviceResponse[] };

export interface DeviceRegistrationApi {
  registerDevice(
    request: DeviceRegistrationRequest,
  ): Promise<AxiosResponse<RegisteredDeviceResponse>>;
}

export interface RegisterCurrentDeviceOptions {
  userId: string;
  name: string;
  capabilities?: string[];
  appVersion: string;
  trustStore?: ClientTrustStore;
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
    capabilities: [...(options.capabilities ?? [])],
    appVersion: options.appVersion,
  };
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
