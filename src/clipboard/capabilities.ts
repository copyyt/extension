export const CLIPBOARD_CAPABILITY = "clipboard";
export const CLIPBOARD_BUNDLE_V1_CAPABILITY = "clipboard-bundle-v1";

/** Receive support only; outgoing clipboard items remain legacy text/plain. */
export const CLIPBOARD_RECEIVE_CAPABILITIES = [
  CLIPBOARD_CAPABILITY,
  CLIPBOARD_BUNDLE_V1_CAPABILITY,
] as const;
