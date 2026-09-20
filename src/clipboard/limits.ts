// The backend counts decoded ciphertext separately from the nonce.
export const MAX_CLIPBOARD_CIPHERTEXT_BYTES = 1024 * 1024;
export const AES_GCM_TAG_BYTES = 16;
export const MAX_CLIPBOARD_PLAINTEXT_BYTES =
  MAX_CLIPBOARD_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES;

/**
 * Local-only ceiling for decoded PNG bytes crossing the extension's
 * offscreen/service-worker boundary. This is deliberately independent from
 * the relay plaintext limit: a valid local image may be larger than a
 * bundle-v1 item that can currently be encrypted for the network.
 */
export const MAX_LOCAL_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

/** Maximum canonical bundle size for the bounded direct clipboard protocol. */
export const DIRECT_CLIPBOARD_MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
