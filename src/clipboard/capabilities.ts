export const CLIPBOARD_CAPABILITY = "clipboard";
export const CLIPBOARD_BUNDLE_V1_CAPABILITY = "clipboard-bundle-v1";
export const CLIPBOARD_HTML_V1_CAPABILITY = "clipboard-html-v1";
/**
 * PNG receive is deliberately advertised as an assisted action. Chrome can
 * read PNG clipboard data in the offscreen document, but it cannot apply a
 * native image clipboard value there without a focused extension page.
 */
export const CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY =
  "clipboard-image-png-assisted-write-v1";
/** Direct transport capability for the bounded application-level clipboard protocol. */
export const CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY =
  "clipboard-direct-webrtc-v1";

/** Clipboard capabilities this Chrome client advertises to other devices. */
export const CLIPBOARD_RECEIVE_CAPABILITIES = [
  CLIPBOARD_CAPABILITY,
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
  CLIPBOARD_IMAGE_PNG_ASSISTED_WRITE_V1_CAPABILITY,
  CLIPBOARD_DIRECT_WEBRTC_V1_CAPABILITY,
] as const;

/** Return a safe copy for server metadata that may be malformed at runtime. */
export function validClipboardCapabilities(
  capabilities: unknown,
): string[] | undefined {
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === "string")
  ) {
    return undefined;
  }
  return [...capabilities];
}
