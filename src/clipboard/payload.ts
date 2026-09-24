import {
  MAX_CLIPBOARD_PLAINTEXT_BYTES,
  MAX_LOCAL_CLIPBOARD_IMAGE_BYTES,
} from "./limits.ts";
import {
  base64ToBytes,
  bytesToBase64,
  toBytes,
  type ByteInput,
} from "../crypto/bytes.ts";

export const CLIPBOARD_PAYLOAD_VERSION = 1 as const;
export const CLIPBOARD_BUNDLE_V1_MIME =
  "application/vnd.copyyt.clipboard-bundle+json" as const;

export type ClipboardRepresentationV1 =
  | {
      mime: "text/plain";
      encoding: "utf-8";
      data: string;
    }
  | {
      mime: "text/html";
      encoding: "utf-8";
      data: string;
    }
  | {
      mime: "image/png";
      encoding: "base64";
      data: string;
    };

export interface ClipboardPayloadV1 {
  version: 1;
  representations: ClipboardRepresentationV1[];
}

declare const clipboardBundleV1BytesBrand: unique symbol;

/** Bytes returned by the canonical bundle encoder, safe to reuse internally. */
export type ClipboardBundleV1Bytes = Uint8Array & {
  readonly [clipboardBundleV1BytesBrand]: true;
};

const utf8Encoder = new TextEncoder();
// ignoreBOM preserves a leading U+FEFF as clipboard data instead of stripping it.
const strictUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const MAX_LOCAL_CLIPBOARD_IMAGE_BASE64_LENGTH =
  4 * Math.ceil(MAX_LOCAL_CLIPBOARD_IMAGE_BYTES / 3);

function assertPlaintextByteLength(byteLength: number): void {
  if (byteLength > MAX_CLIPBOARD_PLAINTEXT_BYTES) {
    throw new Error("Clipboard content exceeds the plaintext byte limit");
  }
}

function assertPngBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new Error("PNG clipboard data is empty");
  }
  if (bytes.byteLength > MAX_LOCAL_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("PNG clipboard data exceeds the local image limit");
  }
  if (!hasPngSignature(bytes)) {
    throw new Error("PNG clipboard data has an invalid signature");
  }
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function pngBytesFromBase64(data: string): Uint8Array {
  // Reject an oversized encoded value before invoking atob so malformed or
  // hostile message data cannot cause an avoidable large temporary decode.
  if (data.length > MAX_LOCAL_CLIPBOARD_IMAGE_BASE64_LENGTH) {
    throw new Error("PNG clipboard data exceeds the local image limit");
  }
  const bytes = base64ToBytes(data);
  assertPngBytes(bytes);
  return bytes;
}

function hasExactFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key))
  );
}

/** Validate the typed model without imposing bundle JSON overhead on raw text. */
export function validateClipboardPayloadV1(
  payload: unknown,
): asserts payload is ClipboardPayloadV1 {
  if (!hasExactFields(payload, ["version", "representations"])) {
    throw new Error("Malformed clipboard payload object");
  }
  if (payload.version !== CLIPBOARD_PAYLOAD_VERSION) {
    throw new Error("Unsupported clipboard payload version");
  }
  if (!Array.isArray(payload.representations)) {
    throw new Error("Clipboard representations must be an array");
  }
  if (
    payload.representations.length < 1 ||
    payload.representations.length > 3
  ) {
    throw new Error("Clipboard payload must contain one to three representations");
  }

  const seenMimes = new Set<string>();
  for (const representation of payload.representations) {
    if (!hasExactFields(representation, ["mime", "encoding", "data"])) {
      throw new Error("Malformed clipboard representation object");
    }
    if (
      representation.mime !== "text/plain" &&
      representation.mime !== "text/html" &&
      representation.mime !== "image/png"
    ) {
      throw new Error("Unsupported clipboard representation MIME");
    }
    if (seenMimes.has(representation.mime)) {
      throw new Error("Duplicate clipboard representation MIME");
    }
    seenMimes.add(representation.mime);
    if (typeof representation.data !== "string") {
      throw new Error("Clipboard representation data must be a string");
    }
    if (representation.mime === "image/png") {
      if (representation.encoding !== "base64") {
        throw new Error("PNG clipboard representation must use base64 encoding");
      }
      pngBytesFromBase64(representation.data);
    } else {
      if (representation.encoding !== "utf-8") {
        throw new Error("Text clipboard representation must use utf-8 encoding");
      }
      assertPlaintextByteLength(
        utf8Encoder.encode(representation.data).byteLength,
      );
    }
  }
  if (seenMimes.has("text/html") && !seenMimes.has("text/plain")) {
    throw new Error("Clipboard HTML requires a text/plain fallback");
  }
}

export function clipboardPayloadFromPlainText(
  text: string,
): ClipboardPayloadV1 {
  if (typeof text !== "string") {
    throw new Error("Clipboard text must be a string");
  }
  assertPlaintextByteLength(utf8Encoder.encode(text).byteLength);
  return {
    version: CLIPBOARD_PAYLOAD_VERSION,
    representations: [{ mime: "text/plain", encoding: "utf-8", data: text }],
  };
}

export function getPlainTextRepresentation(
  payload: ClipboardPayloadV1,
): Extract<ClipboardRepresentationV1, { mime: "text/plain" }> {
  const representation = findPlainTextRepresentation(payload);
  if (!representation) {
    throw new Error("Clipboard payload requires a text/plain fallback");
  }
  return representation;
}

export function findPlainTextRepresentation(
  payload: ClipboardPayloadV1,
): Extract<ClipboardRepresentationV1, { mime: "text/plain" }> | undefined {
  return payload.representations.find(
    (candidate) => candidate.mime === "text/plain",
  );
}

export function hasPlainTextRepresentation(payload: ClipboardPayloadV1): boolean {
  return findPlainTextRepresentation(payload) !== undefined;
}

export function getHtmlRepresentation(
  payload: ClipboardPayloadV1,
): Extract<ClipboardRepresentationV1, { mime: "text/html" }> | undefined {
  return payload.representations.find(
    (candidate) => candidate.mime === "text/html",
  );
}

export function getPngRepresentation(
  payload: ClipboardPayloadV1,
): Extract<ClipboardRepresentationV1, { mime: "image/png" }> | undefined {
  return payload.representations.find(
    (candidate) => candidate.mime === "image/png",
  );
}

export function getPngBytes(payload: ClipboardPayloadV1): Uint8Array {
  const representation = getPngRepresentation(payload);
  if (!representation) {
    throw new Error("Clipboard payload does not contain an image/png representation");
  }
  return pngBytesFromBase64(representation.data);
}

/** Construct an image-only local payload from the exact PNG bytes. */
export function clipboardPayloadFromPngBytes(
  bytes: ByteInput,
): ClipboardPayloadV1 {
  const pngBytes = toBytes(bytes);
  assertPngBytes(pngBytes);
  return {
    version: CLIPBOARD_PAYLOAD_VERSION,
    representations: [
      { mime: "image/png", encoding: "base64", data: bytesToBase64(pngBytes) },
    ],
  };
}

/**
 * Project a local payload to the text-only formats understood by Phase 2C.2.
 * Image data is intentionally omitted until the later image transport phase.
 */
export function projectClipboardPayloadToText(
  payload: ClipboardPayloadV1,
): ClipboardPayloadV1 {
  const plain = findPlainTextRepresentation(payload);
  if (!plain) {
    throw new Error("Clipboard payload has no text network projection");
  }
  const html = getHtmlRepresentation(payload);
  return {
    version: CLIPBOARD_PAYLOAD_VERSION,
    representations: html ? [plain, html] : [plain],
  };
}

/** Legacy wire content is raw UTF-8, never a serialized payload object. */
export function decodeClipboardPlainText(
  bytes: Uint8Array,
): ClipboardPayloadV1 {
  assertPlaintextByteLength(bytes.byteLength);
  return clipboardPayloadFromPlainText(strictUtf8Decoder.decode(bytes));
}

/** Serialize the strict, unreleased bundle-v1 representation model. */
export function encodeClipboardBundleV1(
  payload: ClipboardPayloadV1,
  maxBytes = MAX_CLIPBOARD_PLAINTEXT_BYTES,
): ClipboardBundleV1Bytes {
  validateClipboardPayloadV1(payload);
  const bytes = utf8Encoder.encode(JSON.stringify(payload));
  if (bytes.byteLength > maxBytes) {
    throw new Error("Clipboard bundle exceeds the configured byte limit");
  }
  return bytes as ClipboardBundleV1Bytes;
}

/** Decode a strict bundle-v1 payload with opaque, inert text/PNG data. */
export function decodeClipboardBundleV1(
  bytes: Uint8Array,
  maxBytes = MAX_CLIPBOARD_PLAINTEXT_BYTES,
): ClipboardPayloadV1 {
  if (bytes.byteLength > maxBytes) {
    throw new Error("Clipboard bundle exceeds the configured byte limit");
  }
  const payload: unknown = JSON.parse(strictUtf8Decoder.decode(bytes));
  validateClipboardPayloadV1(payload);
  return payload;
}
