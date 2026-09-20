import {
  DIRECT_APPLICATION_FRAME_INDEX_BYTES,
  DIRECT_APPLICATION_MAX_FRAME_BYTES,
  DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
  DIRECT_CLIPBOARD_CONTENT_TYPE,
  DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES,
  DIRECT_CLIPBOARD_PROTOCOL,
  isUuid,
} from "../direct/protocol.ts";
import {
  AES_GCM_TAG_BYTES,
  MAX_CLIPBOARD_PLAINTEXT_BYTES,
} from "../clipboard/limits.ts";
import {
  decodeClipboardBundleV1,
  encodeClipboardBundleV1,
  validateClipboardPayloadV1,
  type ClipboardBundleV1Bytes,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
import {
  asBufferSource,
  base64ToBytes,
  bytesToBase64,
  isCanonicalBase64Bytes,
  randomBytes,
} from "./bytes.ts";
import {
  buildDirectClipboardChunkAad,
  canonicalIsoExpiry,
} from "./protocol.ts";
import {
  CryptoProtocolError,
  signDirectClipboardManifest,
  unwrapDirectClipboardKeyForRecipient,
  verifyDirectClipboardManifestSignature,
  wrapDirectClipboardKeyForRecipient,
  type VerifiedRecipient,
} from "./crypto-core.ts";
import type { DeviceIdentity } from "./key-store.ts";
import type { ClientVerifiedDevice, LocalDeviceRecord } from "./trust-store.ts";

const AES_GCM_TAG_LENGTH = AES_GCM_TAG_BYTES * 8;
const DIRECT_NONCE_PREFIX_BYTES = 8;
const DIRECT_WRAP_NONCE_BYTES = 12;
const DIRECT_CEK_BYTES = 32;

export interface DirectClipboardStartV1 {
  type: "clipboard-secure-start";
  protocol: typeof DIRECT_CLIPBOARD_PROTOCOL;
  transferId: string;
  userId: string;
  sourceDeviceId: string;
  sourceKeyVersion: number;
  recipientDeviceId: string;
  recipientKeyVersion: number;
  contentType: typeof DIRECT_CLIPBOARD_CONTENT_TYPE;
  expiresAt: string;
  plaintextByteLength: number;
  chunkPlaintextSize: typeof DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE;
  chunkCount: number;
  noncePrefix: string;
  wrapNonce: string;
  wrappedKey: string;
  sourceSignature: string;
}

export interface PreparedDirectClipboardTransfer {
  manifest: DirectClipboardStartV1;
  encryptedChunks: string[];
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key))
  );
}

const MANIFEST_FIELDS = [
  "type",
  "protocol",
  "transferId",
  "userId",
  "sourceDeviceId",
  "sourceKeyVersion",
  "recipientDeviceId",
  "recipientKeyVersion",
  "contentType",
  "expiresAt",
  "plaintextByteLength",
  "chunkPlaintextSize",
  "chunkCount",
  "noncePrefix",
  "wrapNonce",
  "wrappedKey",
  "sourceSignature",
] as const;

export function isDirectClipboardStartV1(
  value: unknown,
): value is DirectClipboardStartV1 {
  if (!exactFields(value, MANIFEST_FIELDS)) return false;
  const candidate = value as Partial<DirectClipboardStartV1>;
  return (
    candidate.type === "clipboard-secure-start" &&
    candidate.protocol === DIRECT_CLIPBOARD_PROTOCOL &&
    isUuid(candidate.transferId) &&
    typeof candidate.userId === "string" &&
    candidate.userId.length > 0 &&
    isUuid(candidate.sourceDeviceId) &&
    Number.isSafeInteger(candidate.sourceKeyVersion) &&
    (candidate.sourceKeyVersion as number) > 0 &&
    isUuid(candidate.recipientDeviceId) &&
    Number.isSafeInteger(candidate.recipientKeyVersion) &&
    (candidate.recipientKeyVersion as number) > 0 &&
    candidate.contentType === DIRECT_CLIPBOARD_CONTENT_TYPE &&
    typeof candidate.expiresAt === "string" &&
    Number.isSafeInteger(candidate.plaintextByteLength) &&
    (candidate.plaintextByteLength as number) > 0 &&
    (candidate.plaintextByteLength as number) <= DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES &&
    candidate.chunkPlaintextSize === DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE &&
    Number.isSafeInteger(candidate.chunkCount) &&
    (candidate.chunkCount as number) > 0 &&
    (candidate.chunkCount as number) < 2 ** 32 &&
    isCanonicalBase64Bytes(candidate.noncePrefix, DIRECT_NONCE_PREFIX_BYTES) &&
    isCanonicalBase64Bytes(candidate.wrapNonce, DIRECT_WRAP_NONCE_BYTES) &&
    isCanonicalBase64Bytes(candidate.wrappedKey, 48) &&
    isCanonicalBase64Bytes(candidate.sourceSignature, 64)
  );
}

function expectedChunkCount(manifest: DirectClipboardStartV1): number {
  return Math.ceil(manifest.plaintextByteLength / manifest.chunkPlaintextSize);
}

function expectedPlaintextLength(
  manifest: DirectClipboardStartV1,
  index: number,
): number {
  const offset = index * manifest.chunkPlaintextSize;
  return Math.min(
    manifest.chunkPlaintextSize,
    manifest.plaintextByteLength - offset,
  );
}

function chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  if (noncePrefix.length !== DIRECT_NONCE_PREFIX_BYTES) {
    throw new CryptoProtocolError("The direct nonce prefix is invalid");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 32) {
    throw new CryptoProtocolError("The direct chunk index is invalid");
  }
  const nonce = new Uint8Array(12);
  nonce.set(noncePrefix);
  new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}

export function directClipboardChunkNonce(
  noncePrefix: Uint8Array,
  index: number,
): Uint8Array {
  return chunkNonce(noncePrefix, index);
}

function manifestCryptoFields(manifest: DirectClipboardStartV1) {
  return {
    protocol: manifest.protocol,
    userId: manifest.userId,
    transferId: manifest.transferId,
    sourceDeviceId: manifest.sourceDeviceId,
    sourceKeyVersion: manifest.sourceKeyVersion,
    recipientDeviceId: manifest.recipientDeviceId,
    recipientKeyVersion: manifest.recipientKeyVersion,
    contentType: manifest.contentType,
    expiresAt: manifest.expiresAt,
    plaintextByteLength: manifest.plaintextByteLength,
    chunkPlaintextSize: manifest.chunkPlaintextSize,
    chunkCount: manifest.chunkCount,
  };
}

function assertManifestMath(manifest: DirectClipboardStartV1, now = Date.now()): void {
  if (expectedChunkCount(manifest) !== manifest.chunkCount) {
    throw new CryptoProtocolError("The direct chunk count does not match the byte length");
  }
  if (manifest.chunkCount >= 2 ** 32) {
    throw new CryptoProtocolError("The direct transfer has too many chunks");
  }
  const expiry = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== manifest.expiresAt) {
    throw new CryptoProtocolError("The direct expiry is invalid");
  }
  if (expiry <= now) {
    throw new CryptoProtocolError("The direct clipboard transfer has expired");
  }
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (bytes.length !== DIRECT_CEK_BYTES) {
    throw new CryptoProtocolError("The direct clipboard CEK is invalid");
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    asBufferSource(bytes),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function frameBytes(index: number, ciphertext: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DIRECT_APPLICATION_FRAME_INDEX_BYTES + ciphertext.length);
  new DataView(frame.buffer).setUint32(0, index, false);
  frame.set(ciphertext, DIRECT_APPLICATION_FRAME_INDEX_BYTES);
  return frame;
}

export function decodeDirectClipboardChunkFrame(value: string): {
  index: number;
  ciphertext: Uint8Array;
} {
  const frame = base64ToBytes(value);
  if (
    frame.byteLength < DIRECT_APPLICATION_FRAME_INDEX_BYTES + AES_GCM_TAG_BYTES ||
    frame.byteLength > DIRECT_APPLICATION_MAX_FRAME_BYTES
  ) {
    throw new CryptoProtocolError("The direct encrypted chunk frame has an invalid size");
  }
  return {
    index: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false),
    ciphertext: frame.slice(DIRECT_APPLICATION_FRAME_INDEX_BYTES),
  };
}

export async function prepareDirectClipboardTransfer(input: {
  userId: string;
  identity: DeviceIdentity;
  recipient: ClientVerifiedDevice | VerifiedRecipient;
  payload: ClipboardPayloadV1;
  /** Canonical bytes produced by the direct routing projection, when present. */
  canonicalPlaintext?: ClipboardBundleV1Bytes;
  transferId: string;
  expiresAt: Date | string;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<PreparedDirectClipboardTransfer> {
  if (input.identity.userId !== input.userId) {
    throw new CryptoProtocolError("The direct source identity belongs to another account");
  }
  if (input.identity.keyVersion === null) {
    throw new CryptoProtocolError("The direct source device is not registered");
  }
  if (!isUuid(input.transferId)) {
    throw new CryptoProtocolError("The direct transfer ID is invalid");
  }
  if (input.recipient.userId !== input.userId || input.recipient.deviceId === input.identity.deviceId) {
    throw new CryptoProtocolError("The direct recipient is invalid");
  }
  const expiresAt = canonicalIsoExpiry(input.expiresAt);
  let plaintext: Uint8Array;
  if (input.canonicalPlaintext) {
    try {
      // Decode the branded bytes before encryption so this optimization cannot
      // introduce an alternate or unchecked direct clipboard serialization.
      decodeClipboardBundleV1(
        input.canonicalPlaintext,
        DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES,
      );
      plaintext = input.canonicalPlaintext;
    } catch {
      throw new CryptoProtocolError("The direct clipboard bundle is invalid");
    }
  } else {
    validateClipboardPayloadV1(input.payload);
    plaintext = encodeClipboardBundleV1(
      input.payload,
      DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES,
    );
  }
  if (plaintext.byteLength === 0 || plaintext.byteLength > DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES) {
    throw new CryptoProtocolError("The direct clipboard bundle is too large");
  }
  const chunkCount = Math.ceil(
    plaintext.byteLength / DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
  );
  if (chunkCount >= 2 ** 32) {
    throw new CryptoProtocolError("The direct transfer has too many chunks");
  }
  const sourceRandom = input.randomBytes ?? randomBytes;
  const contentKey = sourceRandom(DIRECT_CEK_BYTES);
  const noncePrefix = sourceRandom(DIRECT_NONCE_PREFIX_BYTES);
  const wrapNonce = sourceRandom(DIRECT_WRAP_NONCE_BYTES);
  if (contentKey.length !== DIRECT_CEK_BYTES || noncePrefix.length !== DIRECT_NONCE_PREFIX_BYTES || wrapNonce.length !== DIRECT_WRAP_NONCE_BYTES) {
    throw new CryptoProtocolError("The direct random source returned an invalid length");
  }
  const wrapped = await wrapDirectClipboardKeyForRecipient({
    userId: input.userId,
    transferId: input.transferId,
    sourceDeviceId: input.identity.deviceId,
    sourceKeyVersion: input.identity.keyVersion,
    senderIdentity: input.identity,
    recipient: input.recipient,
    contentKey,
    wrapNonce,
  });
  const recipientKeyVersion =
    ("deviceKeyVersion" in input.recipient
      ? input.recipient.deviceKeyVersion
      : undefined) ?? input.recipient.keyVersion;
  if (recipientKeyVersion === undefined) {
    throw new CryptoProtocolError("The direct recipient key version is required");
  }
  const unsignedManifest: Omit<DirectClipboardStartV1, "sourceSignature"> = {
    type: "clipboard-secure-start",
    protocol: DIRECT_CLIPBOARD_PROTOCOL,
    transferId: input.transferId,
    userId: input.userId,
    sourceDeviceId: input.identity.deviceId,
    sourceKeyVersion: input.identity.keyVersion,
    recipientDeviceId: input.recipient.deviceId,
    recipientKeyVersion,
    contentType: DIRECT_CLIPBOARD_CONTENT_TYPE,
    expiresAt,
    plaintextByteLength: plaintext.byteLength,
    chunkPlaintextSize: DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
    chunkCount,
    noncePrefix: bytesToBase64(noncePrefix),
    wrapNonce: wrapped.wrapNonce,
    wrappedKey: wrapped.wrappedKey,
  };
  const sourceSignature = await signDirectClipboardManifest({
    identity: input.identity,
    manifest: unsignedManifest,
  });
  const manifest: DirectClipboardStartV1 = { ...unsignedManifest, sourceSignature };
  const aesKey = await importAesKey(contentKey, ["encrypt"]);
  const encryptedChunks: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const plaintextChunk = plaintext.slice(
      index * DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
      (index + 1) * DIRECT_APPLICATION_PLAINTEXT_CHUNK_SIZE,
    );
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(chunkNonce(noncePrefix, index)),
          additionalData: asBufferSource(
            buildDirectClipboardChunkAad({
              ...manifestCryptoFields(manifest),
              chunkIndex: index,
              expectedPlaintextLength: plaintextChunk.byteLength,
            }),
          ),
          tagLength: AES_GCM_TAG_LENGTH,
        },
        aesKey,
        asBufferSource(plaintextChunk),
      ),
    );
    encryptedChunks.push(bytesToBase64(frameBytes(index, ciphertext)));
  }
  return { manifest, encryptedChunks };
}

export async function decryptDirectClipboardTransfer(input: {
  userId: string;
  identity: DeviceIdentity;
  sourceDevice: ClientVerifiedDevice | LocalDeviceRecord;
  manifest: DirectClipboardStartV1;
  encryptedChunks: readonly string[];
  now?: () => Date;
}): Promise<{ payload: ClipboardPayloadV1; plaintextBytes: Uint8Array }> {
  if (!isDirectClipboardStartV1(input.manifest)) {
    throw new CryptoProtocolError("The direct start manifest is invalid");
  }
  const manifest = input.manifest;
  if (
    manifest.userId !== input.userId ||
    input.identity.userId !== input.userId ||
    manifest.recipientDeviceId !== input.identity.deviceId ||
    input.identity.keyVersion === null ||
    manifest.recipientKeyVersion !== input.identity.keyVersion ||
    manifest.sourceDeviceId !== input.sourceDevice.deviceId ||
    manifest.sourceKeyVersion !== input.sourceDevice.keyVersion ||
    input.sourceDevice.userId !== input.userId ||
    (input.sourceDevice.trustState !== "root" && input.sourceDevice.trustState !== "verified")
  ) {
    throw new CryptoProtocolError("The direct source or recipient identity is not verified");
  }
  assertManifestMath(manifest, (input.now ?? (() => new Date()))().getTime());
  const verified = await verifyDirectClipboardManifestSignature({
    manifest,
    sourceSignature: manifest.sourceSignature,
    sourceSigningPublicKey: input.sourceDevice.signingPublicKey,
  });
  if (!verified) throw new CryptoProtocolError("The direct manifest signature is invalid");
  if (input.encryptedChunks.length !== manifest.chunkCount) {
    throw new CryptoProtocolError("The direct encrypted chunk count is invalid");
  }
  const contentKey = await unwrapDirectClipboardKeyForRecipient({
    userId: input.userId,
    transferId: manifest.transferId,
    sourceDeviceId: manifest.sourceDeviceId,
    sourceKeyVersion: manifest.sourceKeyVersion,
    recipientIdentity: input.identity,
    recipientDeviceId: manifest.recipientDeviceId,
    recipientKeyVersion: manifest.recipientKeyVersion,
    sourceEncryptionPublicKey: input.sourceDevice.encryptionPublicKey,
    wrapNonce: manifest.wrapNonce,
    wrappedKey: manifest.wrappedKey,
  });
  const noncePrefix = base64ToBytes(manifest.noncePrefix);
  const aesKey = await importAesKey(contentKey, ["decrypt"]);
  const plaintextChunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const expectedLength = expectedPlaintextLength(manifest, index);
    const frame = decodeDirectClipboardChunkFrame(input.encryptedChunks[index]!);
    if (frame.index !== index) {
      throw new CryptoProtocolError("The direct chunk index is out of order or duplicated");
    }
    if (frame.ciphertext.byteLength !== expectedLength + AES_GCM_TAG_BYTES) {
      throw new CryptoProtocolError("The direct encrypted chunk size is invalid");
    }
    let plaintextChunk: Uint8Array;
    try {
      plaintextChunk = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(chunkNonce(noncePrefix, index)),
            additionalData: asBufferSource(
              buildDirectClipboardChunkAad({
                ...manifestCryptoFields(manifest),
                chunkIndex: index,
                expectedPlaintextLength: expectedLength,
              }),
            ),
            tagLength: AES_GCM_TAG_LENGTH,
          },
          aesKey,
          asBufferSource(frame.ciphertext),
        ),
      );
    } catch {
      throw new CryptoProtocolError("The direct chunk authentication failed");
    }
    if (plaintextChunk.byteLength !== expectedLength) {
      throw new CryptoProtocolError("The direct plaintext chunk size is invalid");
    }
    plaintextChunks.push(plaintextChunk);
    total += plaintextChunk.byteLength;
  }
  if (total !== manifest.plaintextByteLength) {
    throw new CryptoProtocolError("The direct plaintext length is invalid");
  }
  const plaintextBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of plaintextChunks) {
    plaintextBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const payload = decodeClipboardBundleV1(
      plaintextBytes,
      DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES,
    );
    validateClipboardPayloadV1(payload);
    return { payload, plaintextBytes };
  } catch {
    throw new CryptoProtocolError("The direct clipboard bundle is invalid");
  }
}

export const DIRECT_CLIPBOARD_RELAY_LIMIT = MAX_CLIPBOARD_PLAINTEXT_BYTES;
export const DIRECT_CLIPBOARD_NONCE_PREFIX_BYTES = DIRECT_NONCE_PREFIX_BYTES;
export const DIRECT_CLIPBOARD_WRAP_NONCE_BYTES = DIRECT_WRAP_NONCE_BYTES;
