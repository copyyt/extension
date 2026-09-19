// The backend counts decoded ciphertext separately from the nonce.
export const MAX_CLIPBOARD_CIPHERTEXT_BYTES = 1024 * 1024;
export const AES_GCM_TAG_BYTES = 16;
export const MAX_CLIPBOARD_PLAINTEXT_BYTES =
  MAX_CLIPBOARD_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES;
