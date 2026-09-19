export const CLIPBOARD_CAPABILITY = "clipboard";
export const CLIPBOARD_BUNDLE_V1_CAPABILITY = "clipboard-bundle-v1";
export const CLIPBOARD_HTML_V1_CAPABILITY = "clipboard-html-v1";

/** Clipboard formats supported by this client when receiving and sending. */
export const CLIPBOARD_RECEIVE_CAPABILITIES = [
  CLIPBOARD_CAPABILITY,
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
  CLIPBOARD_HTML_V1_CAPABILITY,
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
