export {
  decryptClipboardItem,
  encryptClipboardItem,
  computePairingFingerprint,
  pairingFingerprint,
  signDeviceApproval,
  signSocketChallenge,
  unwrapContentKeyForRecipient,
  verifyClipboardEnvelopeSignature,
  verifyDeviceApproval,
  wrapContentKeyForRecipient,
  type ClipboardItemEnvelope,
  CryptoProtocolError,
  type DeviceApprovalCertificate,
  type EncryptClipboardItemInput,
  type VerifiedRecipient,
} from "./crypto-core";
export {
  getDeviceIdentity,
  getOrCreateDeviceIdentity,
  clearDeviceIdentity,
  type DeviceIdentity,
} from "./key-store";
export {
  IndexedDBTrustStore,
  DurableTrustStore,
  InMemoryTrustStore,
  type ClientTrustStore,
  type ClientVerifiedDevice,
  type LocalDeviceRecord,
  type LocalTrustState,
} from "./trust-store";
export { registerCurrentDevice } from "./device-registration";
export type {
  DeviceRegistrationApi,
  DeviceRegistrationRequest,
  RegisteredDeviceResponse,
  RegisterCurrentDeviceOptions,
} from "./device-registration";
export {
  buildClipboardEnvelopeSignatureMessage,
  buildDeviceApprovalMessage,
  buildKeyWrapContext,
  buildPairingFingerprintContext,
  buildPayloadAad,
  buildSocketAuthMessage,
} from "./protocol";
export {
  base64ToBytes,
  bytesToBase64,
  isCanonicalBase64Bytes,
  utf8Decode,
  utf8Encode,
} from "./bytes";
