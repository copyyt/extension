import { AxiosInstance } from "axios";
import {
  SignInResponse,
  ILoginIn,
  IVerifyEmail,
  ILoginResponse,
} from "../interfaces/auth.interface";
import type {
  DeviceRegistrationRequest,
  DeviceRecoveryRequest,
  ApproveDeviceRequest,
  RegisteredDeviceResponse,
  RegisteredDeviceListResponse,
} from "../crypto/device-registration";

export const getApis = (axiosInstance: AxiosInstance) => ({
  auth: {
    signInPasswordless: async (data: ILoginIn) =>
      axiosInstance.post<ILoginResponse>("/auth/sign-in-passwordless", data),
    googleSign: async (token: string) =>
      axiosInstance.post<SignInResponse>(
        "/auth/google-auth",
        { token },
        { withCredentials: true },
      ),
    verifyEmail: async (data: IVerifyEmail) =>
      axiosInstance.post<SignInResponse>("/auth/verify-email", data, {
        withCredentials: true,
      }),
    refreshTokens: async (refreshToken?: string) =>
      axiosInstance.post<SignInResponse>(
        "/auth/refresh-tokens",
        refreshToken === undefined ? {} : { refreshToken },
        {
          withCredentials: true,
        },
      ),
    logout: async (refreshToken?: string) =>
      axiosInstance.post(
        "/auth/logout",
        refreshToken === undefined ? {} : { refreshToken },
        {
          withCredentials: true,
        },
      ),
    resendEmailOtp: async (email: string) =>
      axiosInstance.post("/auth/resend-email-otp", { email }),
  },
  devices: {
    registerDevice: async (data: DeviceRegistrationRequest) =>
      axiosInstance.post<RegisteredDeviceResponse>("/devices", data),
    listDevices: async () =>
      axiosInstance.get<RegisteredDeviceListResponse>("/devices"),
    listPendingDevices: async () =>
      axiosInstance.get<RegisteredDeviceListResponse>("/devices/pending"),
    approveDevice: async (data: ApproveDeviceRequest) =>
      axiosInstance.post<RegisteredDeviceResponse>("/devices/approve", data),
    recoverDevice: async (data: DeviceRecoveryRequest) =>
      axiosInstance.post<RegisteredDeviceResponse>("/devices/recover", data),
  },
});
