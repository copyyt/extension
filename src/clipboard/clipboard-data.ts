import {
  clipboardPayloadFromPlainText,
  encodeClipboardBundleV1,
  getPlainTextRepresentation,
  type ClipboardPayloadV1,
  type ClipboardRepresentationV1,
} from "./payload.ts";

/** The small part of ClipboardEvent.clipboardData used by the adapter. */
export interface ClipboardDataLike {
  readonly types: readonly string[];
  getData(type: string): string;
  setData(type: string, value: string): void;
}

function hasType(data: ClipboardDataLike, mime: string): boolean {
  return data.types.some((type) => type === mime);
}

/**
 * Reads clipboard formats as opaque strings. HTML is never parsed or passed
 * through a DOM; it is only retained when the future bundle can carry it.
 */
export function clipboardPayloadFromClipboardData(
  data: ClipboardDataLike,
  textareaPlainText: string,
): ClipboardPayloadV1 {
  const plainText = hasType(data, "text/plain")
    ? data.getData("text/plain")
    : textareaPlainText;
  const plainOnly = clipboardPayloadFromPlainText(plainText);

  if (!hasType(data, "text/html")) return plainOnly;

  const html = data.getData("text/html");
  const rich: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      getPlainTextRepresentation(plainOnly),
      { mime: "text/html", encoding: "utf-8", data: html },
    ],
  };

  // A valid raw clipboard remains useful even when its rich future bundle
  // would exceed the safe encrypted plaintext limit. HTML is never truncated.
  try {
    encodeClipboardBundleV1(rich);
    return rich;
  } catch {
    return plainOnly;
  }
}

/** Writes exact opaque clipboard representations from inside a copy event. */
export function setClipboardDataFromPayload(
  data: ClipboardDataLike,
  payload: ClipboardPayloadV1,
): void {
  const plain = getPlainTextRepresentation(payload).data;
  data.setData("text/plain", plain);
  const html = payload.representations.find(
    (representation): representation is Extract<ClipboardRepresentationV1, { mime: "text/html" }> =>
      representation.mime === "text/html",
  );
  if (html) data.setData("text/html", html.data);
}

export function clipboardPayloadsEqual(
  left: ClipboardPayloadV1,
  right: ClipboardPayloadV1,
): boolean {
  const leftByMime = new Map(
    left.representations.map((representation) => [representation.mime, representation.data]),
  );
  const rightByMime = new Map(
    right.representations.map((representation) => [representation.mime, representation.data]),
  );
  return (
    leftByMime.size === rightByMime.size &&
    [...leftByMime].every(
      ([mime, value]) => rightByMime.get(mime) === value,
    )
  );
}
