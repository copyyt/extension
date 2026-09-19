import { MAX_CLIPBOARD_PLAINTEXT_BYTES } from "./limits.ts";

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
    };

export interface ClipboardPayloadV1 {
  version: 1;
  representations: ClipboardRepresentationV1[];
}

const utf8Encoder = new TextEncoder();
// ignoreBOM preserves a leading U+FEFF as clipboard data instead of stripping it.
const strictUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

function assertPlaintextByteLength(byteLength: number): void {
  if (byteLength > MAX_CLIPBOARD_PLAINTEXT_BYTES) {
    throw new Error("Clipboard content exceeds the plaintext byte limit");
  }
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
    payload.representations.length > 2
  ) {
    throw new Error(
      "Clipboard payload must contain one or two representations",
    );
  }

  const seenMimes = new Set<string>();
  for (const representation of payload.representations) {
    if (!hasExactFields(representation, ["mime", "encoding", "data"])) {
      throw new Error("Malformed clipboard representation object");
    }
    if (
      representation.mime !== "text/plain" &&
      representation.mime !== "text/html"
    ) {
      throw new Error("Unsupported clipboard representation MIME");
    }
    if (seenMimes.has(representation.mime)) {
      throw new Error("Duplicate clipboard representation MIME");
    }
    seenMimes.add(representation.mime);
    if (representation.encoding !== "utf-8") {
      throw new Error("Unsupported clipboard representation encoding");
    }
    if (typeof representation.data !== "string") {
      throw new Error("Clipboard representation data must be a string");
    }
    assertPlaintextByteLength(
      utf8Encoder.encode(representation.data).byteLength,
    );
  }
  if (!seenMimes.has("text/plain")) {
    throw new Error("Clipboard payload requires a text/plain fallback");
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
  const representation = payload.representations.find(
    (candidate) => candidate.mime === "text/plain",
  );
  if (!representation) {
    throw new Error("Clipboard payload requires a text/plain fallback");
  }
  return representation;
}

export function getHtmlRepresentation(
  payload: ClipboardPayloadV1,
): Extract<ClipboardRepresentationV1, { mime: "text/html" }> | undefined {
  return payload.representations.find(
    (candidate) => candidate.mime === "text/html",
  );
}

/** Legacy wire content is raw UTF-8, never a serialized payload object. */
export function decodeClipboardPlainText(
  bytes: Uint8Array,
): ClipboardPayloadV1 {
  assertPlaintextByteLength(bytes.byteLength);
  return clipboardPayloadFromPlainText(strictUtf8Decoder.decode(bytes));
}

/** Foundation for a future sender; Phase 2C.0 sends only legacy raw text. */
export function encodeClipboardBundleV1(
  payload: ClipboardPayloadV1,
): Uint8Array {
  validateClipboardPayloadV1(payload);
  const bytes = utf8Encoder.encode(JSON.stringify(payload));
  assertPlaintextByteLength(bytes.byteLength);
  return bytes;
}

/** HTML is opaque data; callers may apply only the plain-text fallback for now. */
export function decodeClipboardBundleV1(bytes: Uint8Array): ClipboardPayloadV1 {
  assertPlaintextByteLength(bytes.byteLength);
  const payload: unknown = JSON.parse(strictUtf8Decoder.decode(bytes));
  validateClipboardPayloadV1(payload);
  return payload;
}
