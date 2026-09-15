import {
  asBufferSource,
  base64ToBytes,
  bytesToBase64,
  isCanonicalBase64Bytes,
  randomBytes,
  sha256,
  utf8Decode,
  utf8Encode,
} from "./bytes.ts";
import {
  buildClipboardEnvelopeSignatureMessage,
  buildDeviceApprovalMessage,
  buildKeyWrapContext,
  buildPairingFingerprintContext,
  buildPayloadAad,
  buildSocketAuthMessage,
  CRYPTO_PROTOCOL_VERSION,
  KEY_WRAP_HKDF_SALT,
} from "./protocol.ts";
import {
  getPrivateKeyHandles,
  type DeviceIdentity,
} from "./key-store.ts";
import type {
  ClientTrustStore,
  ClientVerifiedDevice,
  LocalDeviceRecord,
} from "./trust-store.ts";

const ED25519 = { name: "Ed25519" } as Algorithm;
const X25519 = { name: "X25519" } as Algorithm;
const AES_GCM_TAG_LENGTH = 128;
const KEY_LENGTH_BYTES = 32;
const NONCE_LENGTH_BYTES = 12;

export type RandomByteSource = (length: number) => Uint8Array;

export class CryptoProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoProtocolError";
  }
}

export interface VerifiedRecipient {
  deviceId: string;
  deviceKeyVersion?: number;
  keyVersion?: number;
  encryptionPublicKey: Uint8Array | string;
  trustState: ClientVerifiedDevice["trustState"];
}

export interface ClipboardItemEnvelope {
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  sourceSignature: string;
  protocolVersion: typeof CRYPTO_PROTOCOL_VERSION;
  contentType: string;
  ciphertext: string;
  nonce: string;
  recipients: Array<{
    deviceId: string;
    deviceKeyVersion: number;
    wrapNonce: string;
    wrappedContentKey: string;
  }>;
  expiresAt: Date | string;
}

export interface EncryptClipboardItemInput {
  userId: string;
  identity: DeviceIdentity;
  plaintext: string | Uint8Array;
  contentType: string;
  expiresAt: Date | string;
  recipients: VerifiedRecipient[];
  itemId?: string;
  randomBytes?: RandomByteSource;
}

export interface DecryptClipboardItemInput {
  userId: string;
  identity: DeviceIdentity;
  sourceDevice?: ClientVerifiedDevice | LocalDeviceRecord;
  trustStore?: Pick<ClientTrustStore, "getDevice">;
  envelope: ClipboardItemEnvelope;
}

export interface DeviceApprovalCertificate {
  approvingDeviceId: string;
  approvingKeyVersion: number;
  pendingDeviceId: string;
  pendingKeyVersion: number;
  pendingEncryptionPublicKey: string;
  pendingSigningPublicKey: string;
  approvalSignature: string;
}

function assertLength(value: Uint8Array, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new CryptoProtocolError(`${label} must be exactly ${expected} bytes`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CryptoProtocolError(`${label} must be a positive integer`);
  }
}

function getRandomSource(input?: RandomByteSource): RandomByteSource {
  return input ?? randomBytes;
}

function recipientKeyVersion(recipient: VerifiedRecipient): number {
  const keyVersion = recipient.deviceKeyVersion ?? recipient.keyVersion;
  if (keyVersion === undefined) {
    throw new CryptoProtocolError("The recipient key version is required");
  }
  return keyVersion;
}

function publicKeyBytes(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? base64ToBytes(value) : new Uint8Array(value);
  assertLength(bytes, 32, "Public key");
  return bytes;
}

async function importPublicKey(
  bytes: Uint8Array,
  algorithm: Algorithm,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(bytes),
    algorithm,
    true,
    usage,
  );
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  assertLength(bytes, KEY_LENGTH_BYTES, "AES key");
  return globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(bytes),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
  context: Uint8Array,
): Promise<CryptoKey> {
  const peerPublicKey = await importPublicKey(peerPublicKeyBytes, X25519, []);
  const sharedSecret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: "X25519", public: peerPublicKey } as Algorithm,
      privateKey,
      256,
    ),
  );
  const ikm = await globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(sharedSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = await sha256(utf8Encode(KEY_WRAP_HKDF_SALT));
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asBufferSource(salt),
      info: asBufferSource(context),
    } as HkdfParams,
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function signWithIdentity(identity: DeviceIdentity, message: Uint8Array): Promise<Uint8Array> {
  const { signingPrivateKey } = getPrivateKeyHandles(identity);
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign(ED25519, signingPrivateKey, asBufferSource(message)),
  );
  assertLength(signature, 64, "Ed25519 signature");
  return signature;
}

async function verifyWithPublicKey(
  publicKeyBytes: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64) {
    return false;
  }
  try {
    const publicKey = await importPublicKey(publicKeyBytes, ED25519, ["verify"]);
    return globalThis.crypto.subtle.verify(
      ED25519,
      publicKey,
      asBufferSource(signature),
      asBufferSource(message),
    );
  } catch {
    return false;
  }
}

export async function wrapContentKeyForRecipient(input: {
  userId: string;
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  senderIdentity: DeviceIdentity;
  recipient: VerifiedRecipient;
  contentKey: Uint8Array;
  wrapNonce?: Uint8Array;
}): Promise<{ wrapNonce: string; wrappedContentKey: string }> {
  assertLength(input.contentKey, KEY_LENGTH_BYTES, "Clipboard content key");
  assertPositiveInteger(input.sourceKeyVersion, "sourceKeyVersion");
  const recipientKeyVersionValue = recipientKeyVersion(input.recipient);
  assertPositiveInteger(recipientKeyVersionValue, "recipientKeyVersion");
  if (input.recipient.trustState !== "root" && input.recipient.trustState !== "verified") {
    throw new CryptoProtocolError("Only locally verified devices may receive wrapped keys");
  }
  const wrapNonce = input.wrapNonce
    ? new Uint8Array(input.wrapNonce)
    : randomBytes(NONCE_LENGTH_BYTES);
  assertLength(wrapNonce, NONCE_LENGTH_BYTES, "Key-wrap nonce");
  const context = buildKeyWrapContext({
    userId: input.userId,
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    itemId: input.itemId,
    sourceDeviceId: input.sourceDeviceId,
    sourceKeyVersion: input.sourceKeyVersion,
    recipientDeviceId: input.recipient.deviceId,
    recipientKeyVersion: recipientKeyVersionValue,
  });
  const wrappingKey = await deriveWrappingKey(
    getPrivateKeyHandles(input.senderIdentity).encryptionPrivateKey,
    publicKeyBytes(input.recipient.encryptionPublicKey),
    context,
  );
  const wrapped = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(wrapNonce),
        additionalData: asBufferSource(context),
        tagLength: AES_GCM_TAG_LENGTH,
      },
      wrappingKey,
      asBufferSource(input.contentKey),
    ),
  );
  assertLength(wrapped, 48, "Wrapped content key");
  return {
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedContentKey: bytesToBase64(wrapped),
  };
}

export async function unwrapContentKeyForRecipient(input: {
  userId: string;
  itemId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  recipientIdentity: DeviceIdentity;
  recipientDeviceId: string;
  recipientKeyVersion: number;
  sourceEncryptionPublicKey: Uint8Array | string;
  wrapNonce: string;
  wrappedContentKey: string;
}): Promise<Uint8Array> {
  assertPositiveInteger(input.sourceKeyVersion, "sourceKeyVersion");
  assertPositiveInteger(input.recipientKeyVersion, "recipientKeyVersion");
  const wrapNonce = base64ToBytes(input.wrapNonce);
  const wrappedContentKey = base64ToBytes(input.wrappedContentKey);
  assertLength(wrapNonce, NONCE_LENGTH_BYTES, "Key-wrap nonce");
  assertLength(wrappedContentKey, 48, "Wrapped content key");
  const context = buildKeyWrapContext({
    userId: input.userId,
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    itemId: input.itemId,
    sourceDeviceId: input.sourceDeviceId,
    sourceKeyVersion: input.sourceKeyVersion,
    recipientDeviceId: input.recipientDeviceId,
    recipientKeyVersion: input.recipientKeyVersion,
  });
  const wrappingKey = await deriveWrappingKey(
    getPrivateKeyHandles(input.recipientIdentity).encryptionPrivateKey,
    publicKeyBytes(input.sourceEncryptionPublicKey),
    context,
  );
  try {
    const contentKey = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(wrapNonce),
          additionalData: asBufferSource(context),
          tagLength: AES_GCM_TAG_LENGTH,
        },
        wrappingKey,
        asBufferSource(wrappedContentKey),
      ),
    );
    assertLength(contentKey, KEY_LENGTH_BYTES, "Unwrapped content key");
    return contentKey;
  } catch {
    throw new CryptoProtocolError("Content-key unwrap failed");
  }
}

export async function signDeviceApproval(input: {
  userId: string;
  approvingIdentity: DeviceIdentity;
  pendingDevice: Pick<
    DeviceApprovalCertificate,
    "pendingDeviceId" | "pendingKeyVersion" | "pendingEncryptionPublicKey" | "pendingSigningPublicKey"
  >;
}): Promise<string> {
  const keyVersion = input.approvingIdentity.keyVersion;
  if (keyVersion === null) {
    throw new CryptoProtocolError("The device must be registered before signing approval");
  }
  const message = buildDeviceApprovalMessage({
    userId: input.userId,
    approvingDeviceId: input.approvingIdentity.deviceId,
    approvingKeyVersion: keyVersion,
    ...input.pendingDevice,
  });
  return bytesToBase64(await signWithIdentity(input.approvingIdentity, message));
}

export async function verifyDeviceApproval(input: {
  userId: string;
  certificate: DeviceApprovalCertificate;
  approverDevice: Pick<LocalDeviceRecord, "deviceId" | "keyVersion" | "signingPublicKey" | "trustState">;
}): Promise<boolean> {
  const { certificate, approverDevice } = input;
  if (
    (approverDevice.trustState !== "root" && approverDevice.trustState !== "verified") ||
    certificate.approvingDeviceId !== approverDevice.deviceId ||
    certificate.approvingKeyVersion !== approverDevice.keyVersion ||
    !isCanonicalBase64Bytes(certificate.approvalSignature, 64) ||
    !isCanonicalBase64Bytes(certificate.pendingEncryptionPublicKey, 32) ||
    !isCanonicalBase64Bytes(certificate.pendingSigningPublicKey, 32)
  ) {
    return false;
  }
  try {
    return verifyWithPublicKey(
      base64ToBytes(approverDevice.signingPublicKey),
      buildDeviceApprovalMessage({
        userId: input.userId,
        approvingDeviceId: certificate.approvingDeviceId,
        approvingKeyVersion: certificate.approvingKeyVersion,
        pendingDeviceId: certificate.pendingDeviceId,
        pendingKeyVersion: certificate.pendingKeyVersion,
        pendingEncryptionPublicKey: certificate.pendingEncryptionPublicKey,
        pendingSigningPublicKey: certificate.pendingSigningPublicKey,
      }),
      base64ToBytes(certificate.approvalSignature),
    );
  } catch {
    return false;
  }
}

export async function signSocketChallenge(input: {
  userId: string;
  identity: DeviceIdentity;
  socketId: string;
  challenge: string;
}): Promise<string> {
  const keyVersion = input.identity.keyVersion;
  if (keyVersion === null) {
    throw new CryptoProtocolError("The device must be registered before socket authentication");
  }
  return bytesToBase64(
    await signWithIdentity(
      input.identity,
      buildSocketAuthMessage({
        userId: input.userId,
        deviceId: input.identity.deviceId,
        keyVersion,
        socketId: input.socketId,
        challenge: input.challenge,
      }),
    ),
  );
}

export async function verifyClipboardEnvelopeSignature(input: {
  userId: string;
  envelope: Pick<ClipboardItemEnvelope, "protocolVersion" | "itemId" | "sourceDeviceId" | "sourceKeyVersion" | "contentType" | "nonce" | "ciphertext" | "expiresAt" | "sourceSignature">;
  sourceSigningPublicKey: Uint8Array | string;
}): Promise<boolean> {
  if (
    input.envelope.protocolVersion !== CRYPTO_PROTOCOL_VERSION ||
    !isCanonicalBase64Bytes(input.envelope.sourceSignature, 64)
  ) {
    return false;
  }
  try {
    const message = await buildClipboardEnvelopeSignatureMessage({
      userId: input.userId,
      protocolVersion: input.envelope.protocolVersion,
      itemId: input.envelope.itemId,
      sourceDeviceId: input.envelope.sourceDeviceId,
      sourceKeyVersion: input.envelope.sourceKeyVersion,
      contentType: input.envelope.contentType,
      nonce: input.envelope.nonce,
      ciphertext: input.envelope.ciphertext,
      expiresAt: input.envelope.expiresAt,
    });
    return verifyWithPublicKey(
      publicKeyBytes(input.sourceSigningPublicKey),
      message,
      base64ToBytes(input.envelope.sourceSignature),
    );
  } catch {
    return false;
  }
}

export async function encryptClipboardItem(
  input: EncryptClipboardItemInput,
): Promise<ClipboardItemEnvelope> {
  if (input.recipients.length === 0) {
    throw new CryptoProtocolError("At least one locally verified recipient is required");
  }
  const sourceKeyVersion = input.identity.keyVersion;
  if (sourceKeyVersion === null) {
    throw new CryptoProtocolError("The source device must be registered before encryption");
  }
  const recipientIds = new Set<string>();
  for (const recipient of input.recipients) {
    if (recipient.trustState !== "root" && recipient.trustState !== "verified") {
      throw new CryptoProtocolError("Server-reported unverified devices cannot be encryption recipients");
    }
    if (recipientIds.has(recipient.deviceId)) {
      throw new CryptoProtocolError("Each encryption recipient may appear only once");
    }
    recipientIds.add(recipient.deviceId);
  }
  const itemId = input.itemId ?? globalThis.crypto.randomUUID();
  const expiresAt = input.expiresAt instanceof Date
    ? input.expiresAt.toISOString()
    : new Date(input.expiresAt).toISOString();
  const payloadAad = buildPayloadAad({
    userId: input.userId,
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    itemId,
    sourceDeviceId: input.identity.deviceId,
    sourceKeyVersion,
    contentType: input.contentType,
    expiresAt,
  });
  const sourceRandom = getRandomSource(input.randomBytes);
  const contentKey = sourceRandom(KEY_LENGTH_BYTES);
  const payloadNonce = sourceRandom(NONCE_LENGTH_BYTES);
  assertLength(contentKey, KEY_LENGTH_BYTES, "Clipboard content key");
  assertLength(payloadNonce, NONCE_LENGTH_BYTES, "Payload nonce");
  const plaintext = typeof input.plaintext === "string" ? utf8Encode(input.plaintext) : new Uint8Array(input.plaintext);
  const aesKey = await importAesKey(contentKey, ["encrypt", "decrypt"]);
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(payloadNonce),
        additionalData: asBufferSource(payloadAad),
        tagLength: AES_GCM_TAG_LENGTH,
      },
      aesKey,
      asBufferSource(plaintext),
    ),
  );
  const recipients = [];
  for (const recipient of input.recipients) {
    recipients.push({
      deviceId: recipient.deviceId,
      deviceKeyVersion: recipientKeyVersion(recipient),
      ...(await wrapContentKeyForRecipient({
        userId: input.userId,
        itemId,
        sourceDeviceId: input.identity.deviceId,
        sourceKeyVersion,
        senderIdentity: input.identity,
        recipient,
        contentKey,
        wrapNonce: sourceRandom(NONCE_LENGTH_BYTES),
      })),
    });
  }
  const sourceSignature = await signWithIdentity(
    input.identity,
    await buildClipboardEnvelopeSignatureMessage({
      userId: input.userId,
      protocolVersion: CRYPTO_PROTOCOL_VERSION,
      itemId,
      sourceDeviceId: input.identity.deviceId,
      sourceKeyVersion,
      contentType: input.contentType,
      nonce: payloadNonce,
      ciphertext,
      expiresAt,
    }),
  );
  return {
    itemId,
    sourceDeviceId: input.identity.deviceId,
    sourceKeyVersion,
    sourceSignature: bytesToBase64(sourceSignature),
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    contentType: input.contentType,
    ciphertext: bytesToBase64(ciphertext),
    nonce: bytesToBase64(payloadNonce),
    recipients,
    expiresAt,
  };
}

export async function decryptClipboardItem(input: DecryptClipboardItemInput): Promise<{
  plaintext: string;
  plaintextBytes: Uint8Array;
}> {
  const { envelope, identity } = input;
  if (envelope.protocolVersion !== CRYPTO_PROTOCOL_VERSION) {
    throw new CryptoProtocolError("Unsupported clipboard protocol version");
  }
  const sourceDevice = input.trustStore
    ? input.trustStore.getDevice(input.userId, envelope.sourceDeviceId)
    : input.sourceDevice;
  if (!sourceDevice) {
    throw new CryptoProtocolError("The source device is not present in the local trust store");
  }
  if (sourceDevice.trustState !== "root" && sourceDevice.trustState !== "verified") {
    throw new CryptoProtocolError("The source device is not locally trusted");
  }
  if (
    sourceDevice.deviceId !== envelope.sourceDeviceId ||
    sourceDevice.keyVersion !== envelope.sourceKeyVersion
  ) {
    throw new CryptoProtocolError("The source device key version is not verified");
  }
  if (!(await verifyClipboardEnvelopeSignature({
    userId: input.userId,
    envelope,
    sourceSigningPublicKey: sourceDevice.signingPublicKey,
  }))) {
    throw new CryptoProtocolError("The source envelope signature is invalid");
  }
  if (envelope.recipients.length !== 1) {
    throw new CryptoProtocolError("An incoming device envelope must contain exactly one recipient");
  }
  const recipient = envelope.recipients[0];
  if (!recipient || recipient.deviceId !== identity.deviceId) {
    throw new CryptoProtocolError("The clipboard item is addressed to another device");
  }
  if (identity.keyVersion === null || recipient.deviceKeyVersion !== identity.keyVersion) {
    throw new CryptoProtocolError("The recipient key version is not current");
  }
  const contentKey = await unwrapContentKeyForRecipient({
    userId: input.userId,
    itemId: envelope.itemId,
    sourceDeviceId: envelope.sourceDeviceId,
    sourceKeyVersion: envelope.sourceKeyVersion,
    recipientIdentity: identity,
    recipientDeviceId: recipient.deviceId,
    recipientKeyVersion: recipient.deviceKeyVersion,
    sourceEncryptionPublicKey: sourceDevice.encryptionPublicKey,
    wrapNonce: recipient.wrapNonce,
    wrappedContentKey: recipient.wrappedContentKey,
  });
  const payloadAad = buildPayloadAad({
    userId: input.userId,
    protocolVersion: envelope.protocolVersion,
    itemId: envelope.itemId,
    sourceDeviceId: envelope.sourceDeviceId,
    sourceKeyVersion: envelope.sourceKeyVersion,
    contentType: envelope.contentType,
    expiresAt: envelope.expiresAt,
  });
  const nonce = base64ToBytes(envelope.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  assertLength(nonce, NONCE_LENGTH_BYTES, "Payload nonce");
  const aesKey = await importAesKey(contentKey, ["decrypt"]);
  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(payloadAad),
          tagLength: AES_GCM_TAG_LENGTH,
        },
        aesKey,
        asBufferSource(ciphertext),
      ),
    );
  } catch {
    throw new CryptoProtocolError("Clipboard payload authentication failed");
  }
  return { plaintext: utf8Decode(plaintextBytes), plaintextBytes };
}

export async function pairingFingerprint(
  input: Parameters<typeof buildPairingFingerprintContext>[0],
): Promise<string> {
  const digest = await sha256(buildPairingFingerprintContext(input));
  return Array.from(digest.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join("-");
}

export const computePairingFingerprint = pairingFingerprint;
