export const RUNTIME_ERROR_CODES = [
  "AUTH_REQUIRED",
  "GOOGLE_AUTH_FAILED",
  "GOOGLE_SUBJECT_CONFLICT",
  "OTP_INVALID",
  "EMAIL_DELIVERY_FAILED",
  "DEVICE_NOT_REGISTERED",
  "DEVICE_AUTH_FAILED",
  "DEVICE_NOT_LOCALLY_TRUSTED",
  "SOCKET_NOT_READY",
  "NO_VERIFIED_RECIPIENTS",
  "CLIPBOARD_READ_FAILED",
  "CLIPBOARD_WRITE_FAILED",
  "ENCRYPTION_FAILED",
  "DECRYPTION_FAILED",
  "SOURCE_UNTRUSTED",
  "SOCKET_PUBLISH_FAILED",
  "PAIRING_FAILED",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export function asRuntimeError(
  error: unknown,
  fallbackCode: RuntimeErrorCode,
  fallbackMessage: string,
): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  return new RuntimeError(fallbackCode, fallbackMessage);
}
