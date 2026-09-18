export type ByteInput = Uint8Array | ArrayBuffer;

export const asBufferSource = (value: Uint8Array): BufferSource =>
  value as unknown as BufferSource;

export function toBytes(value: ByteInput): Uint8Array {
  return value instanceof Uint8Array
    ? new Uint8Array(value)
    : new Uint8Array(value);
}

export function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function utf8Decode(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("The random byte length must be a non-negative integer");
  }
  const result = new Uint8Array(length);
  globalThis.crypto.getRandomValues(result);
  return result;
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    asBufferSource(value),
  );
  return new Uint8Array(digest);
}

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function bytesToBase64(value: Uint8Array): string {
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, offset + chunkSize);
    output += String.fromCharCode(...chunk);
  }
  return btoa(output);
}

export function base64ToBytes(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw new TypeError("Expected canonical padded standard base64");
  }
  const decoded = atob(value);
  const result = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytesToBase64(result) !== value) {
    throw new TypeError("Expected canonical padded standard base64");
  }
  return result;
}

export function isCanonicalBase64Bytes(
  value: unknown,
  byteLength: number,
): value is string {
  try {
    return typeof value === "string" && base64ToBytes(value).length === byteLength;
  } catch {
    return false;
  }
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
