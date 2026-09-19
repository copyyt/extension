import {
  CLIPBOARD_BUNDLE_V1_MIME,
  encodeClipboardBundleV1,
  getHtmlRepresentation,
  getPlainTextRepresentation,
  type ClipboardPayloadV1,
} from "./payload.ts";
import {
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
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

function hasRichClipboardCapabilities(capabilities: unknown): boolean {
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === "string")
  ) {
    return false;
  }
  return (
    capabilities.includes(CLIPBOARD_BUNDLE_V1_CAPABILITY) &&
    capabilities.includes(CLIPBOARD_HTML_V1_CAPABILITY)
  );
}

function recipientSupportsRichClipboard(
  recipient: ClipboardWireRecipient,
): boolean {
  return (
    hasRichClipboardCapabilities(recipient.local.capabilities) &&
    hasRichClipboardCapabilities(recipient.server.capabilities)
  );
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
  const plainText = getPlainTextRepresentation(input.payload).data;
  if (
    !getHtmlRepresentation(input.payload) ||
    input.recipients.length === 0 ||
    !input.recipients.every(recipientSupportsRichClipboard)
  ) {
    return {
      contentType: "text/plain",
      plaintext: plainText,
      format: "legacy-text",
    };
  }

  try {
    return {
      contentType: CLIPBOARD_BUNDLE_V1_MIME,
      plaintext: encodeClipboardBundleV1(input.payload),
      format: "bundle-v1",
    };
  } catch {
    return {
      contentType: "text/plain",
      plaintext: plainText,
      format: "legacy-text",
    };
  }
}

