import {
  base64ToBytes,
  bytesToBase64,
  sha256,
  utf8Encode,
} from "./bytes.ts";

export const CRYPTO_PROTOCOL_VERSION = 1 as const;
export const DEVICE_APPROVAL_MESSAGE_VERSION = "copyyt-device-approval-v1";
export const CLIPBOARD_ENVELOPE_SIGNATURE_MESSAGE_VERSION =
  "copyyt-clipboard-envelope-v1";
export const SOCKET_AUTH_MESSAGE_VERSION = "copyyt-socket-auth-v1";
export const KEY_WRAP_CONTEXT_VERSION = "copyyt-key-wrap-v1";
export const KEY_WRAP_HKDF_SALT = "copyyt-key-wrap-hkdf-salt-v1";
export const PAYLOAD_AAD_VERSION = "copyyt-payload-v1";
export const PAIRING_FINGERPRINT_CONTEXT_VERSION =
  "copyyt-pairing-fingerprint-v1";
export const DIRECT_CLIPBOARD_WRAP_CONTEXT_VERSION =
  "copyyt-direct-clipboard-wrap-v1";
export const DIRECT_CLIPBOARD_MANIFEST_SIGNATURE_VERSION =
  "copyyt-direct-clipboard-manifest-v1";
export const DIRECT_CLIPBOARD_CHUNK_AAD_VERSION =
  "copyyt-direct-clipboard-chunk-v1";

function canonicalLines(lines: string[]): Uint8Array {
  return utf8Encode(`${lines.join("\n")}\n`);
}

function canonicalExpiry(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("expiresAt must be a valid date");
  }
  return date.toISOString();
}

export function canonicalIsoExpiry(value: Date | string): string {
  return canonicalExpiry(value);
}

export interface DirectClipboardManifestMessageInput {
  protocol: string;
  userId: string;
  transferId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  recipientDeviceId: string;
  recipientKeyVersion: number;
  contentType: string;
  expiresAt: Date | string;
  plaintextByteLength: number;
  chunkPlaintextSize: number;
  chunkCount: number;
  noncePrefix: Uint8Array | string;
  wrapNonce: Uint8Array | string;
  wrappedKey: Uint8Array | string;
}

function canonicalBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? base64ToBytes(value) : new Uint8Array(value);
}

export function buildDirectClipboardManifestMessage(
  input: DirectClipboardManifestMessageInput,
): Uint8Array {
  return canonicalLines([
    DIRECT_CLIPBOARD_MANIFEST_SIGNATURE_VERSION,
    `protocol=${input.protocol}`,
    `userId=${input.userId}`,
    `transferId=${input.transferId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `recipientDeviceId=${input.recipientDeviceId}`,
    `recipientKeyVersion=${input.recipientKeyVersion}`,
    `contentType=${input.contentType}`,
    `expiresAt=${canonicalExpiry(input.expiresAt)}`,
    `plaintextByteLength=${input.plaintextByteLength}`,
    `chunkPlaintextSize=${input.chunkPlaintextSize}`,
    `chunkCount=${input.chunkCount}`,
    `noncePrefix=${bytesToBase64(canonicalBytes(input.noncePrefix))}`,
    `wrapNonce=${bytesToBase64(canonicalBytes(input.wrapNonce))}`,
    `wrappedKey=${bytesToBase64(canonicalBytes(input.wrappedKey))}`,
  ]);
}

export interface DirectClipboardChunkAadInput
  extends Omit<
    DirectClipboardManifestMessageInput,
    "noncePrefix" | "wrapNonce" | "wrappedKey"
  > {
  chunkIndex: number;
  expectedPlaintextLength: number;
}

export function buildDirectClipboardChunkAad(
  input: DirectClipboardChunkAadInput,
): Uint8Array {
  return canonicalLines([
    DIRECT_CLIPBOARD_CHUNK_AAD_VERSION,
    `protocol=${input.protocol}`,
    `userId=${input.userId}`,
    `transferId=${input.transferId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `recipientDeviceId=${input.recipientDeviceId}`,
    `recipientKeyVersion=${input.recipientKeyVersion}`,
    `contentType=${input.contentType}`,
    `expiresAt=${canonicalExpiry(input.expiresAt)}`,
    `plaintextByteLength=${input.plaintextByteLength}`,
    `chunkPlaintextSize=${input.chunkPlaintextSize}`,
    `chunkCount=${input.chunkCount}`,
    `chunkIndex=${input.chunkIndex}`,
    `expectedPlaintextLength=${input.expectedPlaintextLength}`,
  ]);
}

export interface DirectClipboardWrapContextInput {
  userId: string;
  transferId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  recipientDeviceId: string;
  recipientKeyVersion: number;
}

export function buildDirectClipboardWrapContext(
  input: DirectClipboardWrapContextInput,
): Uint8Array {
  return canonicalLines([
    DIRECT_CLIPBOARD_WRAP_CONTEXT_VERSION,
    `userId=${input.userId}`,
    `transferId=${input.transferId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `recipientDeviceId=${input.recipientDeviceId}`,
    `recipientKeyVersion=${input.recipientKeyVersion}`,
  ]);
}

export interface DeviceApprovalMessageInput {
  userId: string;
  approvingDeviceId: string;
  approvingKeyVersion: number;
  pendingDeviceId: string;
  pendingKeyVersion: number;
  pendingEncryptionPublicKey: string;
  pendingSigningPublicKey: string;
}

export function buildDeviceApprovalMessage(
  input: DeviceApprovalMessageInput,
): Uint8Array {
  return canonicalLines([
    DEVICE_APPROVAL_MESSAGE_VERSION,
    `userId=${input.userId}`,
    `approvingDeviceId=${input.approvingDeviceId}`,
    `approvingKeyVersion=${input.approvingKeyVersion}`,
    `pendingDeviceId=${input.pendingDeviceId}`,
    `pendingKeyVersion=${input.pendingKeyVersion}`,
    `pendingEncryptionPublicKey=${input.pendingEncryptionPublicKey}`,
    `pendingSigningPublicKey=${input.pendingSigningPublicKey}`,
  ]);
}

export interface SocketAuthMessageInput {
  userId: string;
  deviceId: string;
  keyVersion: number;
  socketId: string;
  challenge: string;
}

export function buildSocketAuthMessage(
  input: SocketAuthMessageInput,
): Uint8Array {
  return canonicalLines([
    SOCKET_AUTH_MESSAGE_VERSION,
    `userId=${input.userId}`,
    `deviceId=${input.deviceId}`,
    `keyVersion=${input.keyVersion}`,
    `socketId=${input.socketId}`,
    `challenge=${input.challenge}`,
  ]);
}

export interface ClipboardEnvelopeSignatureMessageInput {
  userId: string;
  protocolVersion: number;
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  contentType: string;
  nonce: Uint8Array | string;
  ciphertext: Uint8Array | string;
  expiresAt: Date | string;
}

export async function buildClipboardEnvelopeSignatureMessage(
  input: ClipboardEnvelopeSignatureMessageInput,
): Promise<Uint8Array> {
  const nonce =
    typeof input.nonce === "string"
      ? base64ToBytes(input.nonce)
      : new Uint8Array(input.nonce);
  const ciphertext =
    typeof input.ciphertext === "string"
      ? base64ToBytes(input.ciphertext)
      : new Uint8Array(input.ciphertext);
  const ciphertextSha256 = bytesToBase64(await sha256(ciphertext));

  return canonicalLines([
    CLIPBOARD_ENVELOPE_SIGNATURE_MESSAGE_VERSION,
    `userId=${input.userId}`,
    `protocolVersion=${input.protocolVersion}`,
    `itemId=${input.itemId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `contentType=${input.contentType}`,
    `nonce=${bytesToBase64(nonce)}`,
    `ciphertextSha256=${ciphertextSha256}`,
    `expiresAt=${canonicalExpiry(input.expiresAt)}`,
  ]);
}

export interface KeyWrapContextInput {
  userId: string;
  protocolVersion: number;
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  recipientDeviceId: string;
  recipientKeyVersion: number;
}

export function buildKeyWrapContext(input: KeyWrapContextInput): Uint8Array {
  return canonicalLines([
    KEY_WRAP_CONTEXT_VERSION,
    `userId=${input.userId}`,
    `protocolVersion=${input.protocolVersion}`,
    `itemId=${input.itemId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `recipientDeviceId=${input.recipientDeviceId}`,
    `recipientKeyVersion=${input.recipientKeyVersion}`,
  ]);
}

export interface PayloadAadInput {
  userId: string;
  protocolVersion: number;
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  contentType: string;
  expiresAt: Date | string;
}

export function buildPayloadAad(input: PayloadAadInput): Uint8Array {
  return canonicalLines([
    PAYLOAD_AAD_VERSION,
    `userId=${input.userId}`,
    `protocolVersion=${input.protocolVersion}`,
    `itemId=${input.itemId}`,
    `sourceDeviceId=${input.sourceDeviceId}`,
    `sourceKeyVersion=${input.sourceKeyVersion}`,
    `contentType=${input.contentType}`,
    `expiresAt=${canonicalExpiry(input.expiresAt)}`,
  ]);
}

export interface PairingFingerprintInput {
  userId: string;
  approvingDeviceId: string;
  approvingKeyVersion: number;
  approvingSigningPublicKey: string;
  approvingEncryptionPublicKey: string;
  pendingDeviceId: string;
  pendingKeyVersion: number;
  pendingSigningPublicKey: string;
  pendingEncryptionPublicKey: string;
}

export function buildPairingFingerprintContext(
  input: PairingFingerprintInput,
): Uint8Array {
  return canonicalLines([
    PAIRING_FINGERPRINT_CONTEXT_VERSION,
    `userId=${input.userId}`,
    `approvingDeviceId=${input.approvingDeviceId}`,
    `approvingKeyVersion=${input.approvingKeyVersion}`,
    `approvingSigningPublicKey=${input.approvingSigningPublicKey}`,
    `approvingEncryptionPublicKey=${input.approvingEncryptionPublicKey}`,
    `pendingDeviceId=${input.pendingDeviceId}`,
    `pendingKeyVersion=${input.pendingKeyVersion}`,
    `pendingSigningPublicKey=${input.pendingSigningPublicKey}`,
    `pendingEncryptionPublicKey=${input.pendingEncryptionPublicKey}`,
  ]);
}
