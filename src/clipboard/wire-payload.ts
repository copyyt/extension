import {
  CLIPBOARD_BUNDLE_V1_MIME,
  encodeClipboardBundleV1,
  findPlainTextRepresentation,
  getHtmlRepresentation,
  getPngRepresentation,
  getPlainTextRepresentation,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
  CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
} from "./capabilities.ts";

export type ClipboardWirePayload =
  | {
      contentType: "text/plain";
      plaintext: string;
      format: "legacy-text";
    }
  | {
      contentType: typeof CLIPBOARD_BUNDLE_V1_MIME;
      plaintext: Uint8Array;
      format: "bundle-v1";
    };

/**
 * Capability metadata for one actual encryption recipient. The two copies are
 * intentionally kept separate: a server observation never replaces the local
 * verified record for feature negotiation.
 */
export interface ClipboardWireRecipient {
  local: { capabilities?: unknown };
  server: { capabilities?: unknown };
}

export interface ClipboardWireProjection {
  payload: ClipboardPayloadV1;
  wirePayload: ClipboardWirePayload;
  recipients: readonly ClipboardWireRecipient[];
}

export class ClipboardWirePayloadTooLargeError extends Error {
  constructor() {
    super("Clipboard bundle exceeds the encrypted relay plaintext limit");
    this.name = "ClipboardWirePayloadTooLargeError";
  }
}

function hasCapability(capabilities: unknown, capability: string): boolean {
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === "string")
  ) {
    return false;
  }
  return capabilities.includes(capability);
}

function recipientSupportsCapability(
  recipient: ClipboardWireRecipient,
  capability: string,
): boolean {
  return (
    hasCapability(recipient.local.capabilities, capability) &&
    hasCapability(recipient.server.capabilities, capability)
  );
}

export function recipientSupportsClipboardBundle(
  recipient: ClipboardWireRecipient,
): boolean {
  return recipientSupportsCapability(recipient, CLIPBOARD_BUNDLE_V1_CAPABILITY);
}

export function recipientSupportsClipboardHtml(
  recipient: ClipboardWireRecipient,
): boolean {
  return recipientSupportsClipboardBundle(recipient) &&
    recipientSupportsCapability(recipient, CLIPBOARD_HTML_V1_CAPABILITY);
}

export function recipientSupportsAssistedPng(
  recipient: ClipboardWireRecipient,
): boolean {
  return recipientSupportsClipboardBundle(recipient) &&
    recipientSupportsCapability(
      recipient,
      CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
    );
}

function projectForRecipient(
  payload: ClipboardPayloadV1,
  recipient: ClipboardWireRecipient,
): ClipboardPayloadV1 | null {
  const plain = findPlainTextRepresentation(payload);
  const html = getHtmlRepresentation(payload);
  const png = getPngRepresentation(payload);
  const representations = [] as ClipboardPayloadV1["representations"];
  if (plain) representations.push(plain);
  if (html && recipientSupportsClipboardHtml(recipient)) {
    representations.push(html);
  }
  if (png && recipientSupportsAssistedPng(recipient)) {
    representations.push(png);
  }
  if (representations.length === 0) return null;
  if (png && !recipientSupportsAssistedPng(recipient) && !plain) return null;
  return { version: 1, representations };
}

function projectionKey(payload: ClipboardPayloadV1): string {
  return JSON.stringify(payload.representations);
}

function wirePayloadForProjection(
  payload: ClipboardPayloadV1,
): ClipboardWirePayload {
  const plain = findPlainTextRepresentation(payload);
  const hasBundleData = Boolean(
    getHtmlRepresentation(payload) || getPngRepresentation(payload),
  );
  if (!hasBundleData && plain) {
    return { contentType: "text/plain", plaintext: plain.data, format: "legacy-text" };
  }
  try {
    return {
      contentType: CLIPBOARD_BUNDLE_V1_MIME,
      plaintext: encodeClipboardBundleV1(payload),
      format: "bundle-v1",
    };
  } catch {
    if (getPngRepresentation(payload)) {
      throw new ClipboardWirePayloadTooLargeError();
    }
    if (!plain) throw new Error("Clipboard bundle has no text fallback");
    return { contentType: "text/plain", plaintext: plain.data, format: "legacy-text" };
  }
}

/** Select one encrypted plaintext projection per compatible capability group. */
export function selectClipboardWirePayloads(input: {
  payload: ClipboardPayloadV1;
  recipients: readonly ClipboardWireRecipient[];
}): ClipboardWireProjection[] {
  const groups = new Map<string, { payload: ClipboardPayloadV1; recipients: ClipboardWireRecipient[] }>();
  for (const recipient of input.recipients) {
    const payload = projectForRecipient(input.payload, recipient);
    if (!payload) continue;
    const key = projectionKey(payload);
    const group = groups.get(key);
    if (group) group.recipients.push(recipient);
    else groups.set(key, { payload, recipients: [recipient] });
  }
  return [...groups.values()].map(({ payload, recipients }) => ({
    payload,
    wirePayload: wirePayloadForProjection(payload),
    recipients,
  }));
}

/**
 * Select the single wire representation shared by every actual recipient.
 * Capability uncertainty and bundle-size failures deliberately downgrade to
 * the exact text/plain fallback.
 */
export function selectClipboardWirePayload(input: {
  payload: ClipboardPayloadV1;
  recipients: readonly ClipboardWireRecipient[];
}): ClipboardWirePayload {
  if (input.recipients.length === 0) throw new Error("No clipboard recipients are available");
  const projections = selectClipboardWirePayloads(input);
  return projections.length === 1
    ? projections[0]!.wirePayload
    : (() => {
        const plain = getPlainTextRepresentation(input.payload);
        return { contentType: "text/plain", plaintext: plain.data, format: "legacy-text" };
      })();
}
