export {
  decryptClipboardItem,
  decryptClipboardItemBytes,
  encryptClipboardItem,
  computePairingFingerprint,
  pairingFingerprint,
  signDeviceApproval,
  signSocketChallenge,
  unwrapContentKeyForRecipient,
  verifyClipboardEnvelopeSignature,
  verifyDeviceApproval,
  wrapContentKeyForRecipient,
  signDirectClipboardManifest,
  unwrapDirectClipboardKeyForRecipient,
  verifyDirectClipboardManifestSignature,
  wrapDirectClipboardKeyForRecipient,
  type ClipboardItemEnvelope,
  CryptoProtocolError,
  type DeviceApprovalCertificate,
  type EncryptClipboardItemInput,
  type VerifiedRecipient,
} from "./crypto-core.ts";
export {
  decodeDirectClipboardChunkFrame,
  directClipboardChunkNonce,
  decryptDirectClipboardTransfer,
  isDirectClipboardStartV1,
  prepareDirectClipboardTransfer,
  type DirectClipboardStartV1,
  type PreparedDirectClipboardTransfer,
} from "./direct-clipboard.ts";
export {
  getDeviceIdentity,
  getOrCreateDeviceIdentity,
  clearDeviceIdentity,
  type DeviceIdentity,
} from "./key-store.ts";
export {
  IndexedDBTrustStore,
  DurableTrustStore,
  InMemoryTrustStore,
  type ClientTrustStore,
  type ClientVerifiedDevice,
  type LocalDeviceRecord,
  type LocalTrustState,
  type TrustOrigin,
} from "./trust-store.ts";
export { registerCurrentDevice } from "./device-registration.ts";
export type {
  DeviceRegistrationApi,
  ApproveDeviceRequest,
  DeviceApprovalRequest,
  DeviceRegistrationRequest,
  RegisteredDeviceResponse,
  RegisterCurrentDeviceOptions,
} from "./device-registration.ts";
export {
  buildClipboardEnvelopeSignatureMessage,
  buildDirectClipboardChunkAad,
  buildDirectClipboardManifestMessage,
  buildDirectClipboardWrapContext,
  buildDeviceApprovalMessage,
  buildKeyWrapContext,
  buildPairingFingerprintContext,
  buildPayloadAad,
  buildSocketAuthMessage,
  canonicalIsoExpiry,
} from "./protocol.ts";
export {
  base64ToBytes,
  bytesToBase64,
  isCanonicalBase64Bytes,
  utf8Decode,
  utf8Encode,
} from "./bytes.ts";
