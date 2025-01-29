import { AxiosInstance } from "axios";
import {
  GoogleSignInResponse,
  ILoginIn,
  ISignUp,
} from "../interfaces/auth.interface";

export const getApis = (axiosInstance: AxiosInstance) => ({
  auth: {
    signIn: async (data: ILoginIn) => axiosInstance.post("/auth/sign-in", data),
    signUp: async (data: ISignUp) => axiosInstance.post("/auth/sign-up", data),
    googleSign: async (token: string) =>
      axiosInstance.post<GoogleSignInResponse>("/auth/google-auth", { token }),
  },
});
