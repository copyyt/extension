import {
  clipboardPayloadFromPlainText,
  clipboardPayloadFromPngBytes,
  getHtmlRepresentation,
  findPlainTextRepresentation,
  validateClipboardPayloadV1,
  type ClipboardPayloadV1,
  type ClipboardRepresentationV1,
} from "./payload.ts";
import type { ByteInput } from "../crypto/bytes.ts";

/**
 * The small part of a ClipboardEvent's data store used by the adapter. The
 * item list is intentionally opaque here; DOM-specific access is kept in the
 * narrow helpers below and the offscreen adapter.
 */
export interface ClipboardFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ClipboardDataItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): ClipboardFileLike | null;
}

export interface ClipboardDataItemsLike {
  readonly length: number;
  item(index: number): ClipboardDataItemLike | null;
}

export interface ClipboardDataLike {
  readonly types: readonly string[];
  readonly items?: ClipboardDataItemsLike | readonly ClipboardDataItemLike[];
  getData(type: string): string;
  setData(type: string, value: string): void;
}

function hasType(data: ClipboardDataLike, mime: string): boolean {
  return data.types.some((type) => type === mime);
}

export interface ClipboardFormatValues {
  plainText?: string;
  html?: string;
  pngBytes?: ByteInput;
}

/**
 * Assemble the supported clipboard representations without imposing relay
 * bundle size. The caller controls presence: an absent plainText is distinct
 * from an explicitly empty plainText.
 */
export function clipboardPayloadFromFormats(
  values: ClipboardFormatValues,
): ClipboardPayloadV1 {
  const representations: ClipboardRepresentationV1[] = [];

  if (values.plainText !== undefined) {
    representations.push(
      clipboardPayloadFromPlainText(values.plainText).representations[0]!,
    );
  }
  if (values.html !== undefined) {
    if (values.plainText === undefined) {
      throw new Error("Clipboard HTML requires a text/plain fallback");
    }
    representations.push({
      mime: "text/html",
      encoding: "utf-8",
      data: values.html,
    });
  }
  if (values.pngBytes !== undefined) {
    representations.push(
      clipboardPayloadFromPngBytes(values.pngBytes).representations[0]!,
    );
  }
  if (representations.length === 0) {
    throw new Error("Clipboard data contains no supported representation");
  }

  const payload: ClipboardPayloadV1 = {
    version: 1,
    representations,
  };
  validateClipboardPayloadV1(payload);
  return payload;
}

/**
 * Reads text formats as opaque strings. HTML is never parsed or passed
 * through a DOM; it is only retained as inert clipboard data.
 */
export function clipboardPayloadFromClipboardData(
  data: ClipboardDataLike,
  textareaPlainText: string,
  pngBytes?: ByteInput,
): ClipboardPayloadV1 {
  const hasPlain = hasType(data, "text/plain");
  const hasHtml = hasType(data, "text/html");
  const hasPng = pngBytes !== undefined;

  // A paste of HTML can still obtain its required plain fallback from the
  // textarea. An image-only paste must not acquire a synthetic empty text
  // representation merely because the textarea starts empty.
  const plainText = hasPlain || hasHtml || !hasPng
    ? hasPlain
      ? data.getData("text/plain")
      : textareaPlainText
    : undefined;
  const html = hasHtml ? data.getData("text/html") : undefined;

  return clipboardPayloadFromFormats({ plainText, html, pngBytes });
}

function hasUsableTextClipboardData(
  data: ClipboardDataLike,
  textareaPlainText: string,
): boolean {
  return (
    hasType(data, "text/plain") ||
    hasType(data, "text/html") ||
    textareaPlainText.length > 0
  );
}

/**
 * Read one captured PNG File after the synchronous paste command. Oversized
 * or malformed image data is omitted only when a supported text format can
 * preserve the clipboard operation exactly.
 */
export async function clipboardPayloadFromClipboardFile(
  data: ClipboardDataLike,
  textareaPlainText: string,
  pngFile: ClipboardFileLike | undefined,
): Promise<ClipboardPayloadV1> {
  if (!pngFile) {
    return clipboardPayloadFromClipboardData(data, textareaPlainText);
  }

  let pngBytes: Uint8Array;
  try {
    pngBytes = new Uint8Array(await pngFile.arrayBuffer());
  } catch {
    if (hasUsableTextClipboardData(data, textareaPlainText)) {
      return clipboardPayloadFromClipboardData(data, textareaPlainText);
    }
    throw new Error("The PNG clipboard data could not be read");
  }

  try {
    return clipboardPayloadFromClipboardData(data, textareaPlainText, pngBytes);
  } catch (error) {
    if (hasUsableTextClipboardData(data, textareaPlainText)) {
      return clipboardPayloadFromClipboardData(data, textareaPlainText);
    }
    throw error;
  }
}

/** Return the first supported PNG clipboard item in item-list order. */
export function getPngFileFromClipboardData(
  data: ClipboardDataLike,
): ClipboardFileLike | undefined {
  const items = data.items;
  if (!items) return undefined;
  const length = items.length;
  for (let index = 0; index < length; index += 1) {
    const item = Array.isArray(items)
      ? items[index]
      : typeof (items as ClipboardDataItemsLike).item === "function"
        ? (items as ClipboardDataItemsLike).item(index)
        : (items as unknown as Record<number, ClipboardDataItemLike | undefined>)[index];
    if (item?.kind === "file" && item.type === "image/png") {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return undefined;
}

/**
 * Chrome's MV3 offscreen clipboard writer intentionally supports text only.
 * The service worker cannot use the document Clipboard API directly, and the
 * offscreen document cannot satisfy its focus requirement. In real Chrome,
 * execCommand("copy") plus DataTransfer.items.add(File) produced a file-style
 * clipboard result named copyyt.png instead of a native image entry. Keep
 * image/png as a read/model capability for future assisted or native clients,
 * but never apply it from this writer.
 */
export function setChromeOffscreenClipboardDataFromPayload(
  data: ClipboardDataLike,
  payload: ClipboardPayloadV1,
): ClipboardPayloadV1 {
  validateClipboardPayloadV1(payload);

  const plain = findPlainTextRepresentation(payload);
  if (!plain) {
    throw new Error(
      "Chrome offscreen clipboard writing does not support image/png",
    );
  }

  const applied = new Set<string>();
  try {
    data.setData("text/plain", plain.data);
    applied.add("text/plain");
  } catch {
    // Keep trying independent formats. The caller will reject if no text
    // representation was actually accepted.
  }

  const html = getHtmlRepresentation(payload);
  if (html && applied.has("text/plain")) {
    try {
      data.setData("text/html", html.data);
      applied.add("text/html");
    } catch {
      // Return the plain fallback if the richer text channel is unavailable.
    }
  }

  const appliedRepresentations = payload.representations.filter((representation) =>
    applied.has(representation.mime),
  );
  if (appliedRepresentations.length === 0) {
    throw new Error("No supported clipboard representation could be applied");
  }
  // If HTML somehow became the only applied format, it cannot be represented
  // by ClipboardPayloadV1; only return combinations that satisfy validation.
  const actual: ClipboardPayloadV1 = {
    version: 1,
    representations: appliedRepresentations,
  };
  validateClipboardPayloadV1(actual);
  return actual;
}

/** @deprecated Use setChromeOffscreenClipboardDataFromPayload explicitly. */
export const setClipboardDataFromPayload =
  setChromeOffscreenClipboardDataFromPayload;

export function clipboardPayloadsEqual(
  left: ClipboardPayloadV1,
  right: ClipboardPayloadV1,
): boolean {
  const leftByMime = new Map(
    left.representations.map((representation) => [
      representation.mime,
      `${representation.encoding}\u0000${representation.data}`,
    ]),
  );
  const rightByMime = new Map(
    right.representations.map((representation) => [
      representation.mime,
      `${representation.encoding}\u0000${representation.data}`,
    ]),
  );
  return (
    leftByMime.size === rightByMime.size &&
    [...leftByMime].every(
      ([mime, value]) => rightByMime.get(mime) === value,
    )
  );
}
