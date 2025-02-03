import { AxiosInstance } from "axios";
import {
  SignInResponse,
  ILoginIn,
  IVerifyEmail,
  ILoginResponse,
} from "../interfaces/auth.interface";

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
  },
  user: {
    lastMessage: async () => axiosInstance.get("/user/last-message"),
  },
});
