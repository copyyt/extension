import { AxiosInstance } from "axios";
import {
  SignInResponse,
  ILoginIn,
  IVerifyEmail,
  ILoginResponse,
} from "../interfaces/auth.interface";
import type {
  DeviceRegistrationRequest,
  DeviceApprovalRequest,
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
      axiosInstance.post<SignInResponse>("/auth/verify-email", data),
    refreshTokens: async () =>
      axiosInstance.post<SignInResponse>("/auth/refresh-tokens", null, {
        withCredentials: true,
      }),
    logout: async () =>
      axiosInstance.post("/auth/logout", null, {
        withCredentials: true,
      }),
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
    approveDevice: async (data: DeviceApprovalRequest) =>
      axiosInstance.post<RegisteredDeviceResponse>("/devices/approve", data),
  },
});
