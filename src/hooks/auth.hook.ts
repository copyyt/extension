import { useMutation } from "@tanstack/react-query";
import { useAxios } from "./axios.hook";
import { useUserStore } from "./user-store.hook";
import { useViewStore } from "./view-store.hook";
import { ILoginIn, ILoginResponse, IVerifyEmail } from "@/interfaces/auth.interface";
import { useToastStore } from "./toast-store.hook";
import { isAxiosError } from "axios";
import { APP_TYPE } from "@/utils/constants";
import { sendRuntimeCommand } from "@/runtime/client";
import type { AuthenticatedRuntimeResult } from "@/runtime/messages";

async function runtimeAuth(
  command: Parameters<typeof sendRuntimeCommand>[0],
): Promise<AuthenticatedRuntimeResult> {
  return sendRuntimeCommand<AuthenticatedRuntimeResult>(command);
}

export function useGoogleSignIn() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setCurrentView } = useViewStore();

  return useMutation({
    mutationFn: async (token: string) => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-google", googleToken: token });
      }
      const response = await Api.auth.googleSign(token);
      return response.data;
    },
    onSuccess: (data) => {
      if (APP_TYPE !== "extension" && "accessToken" in data && typeof data.accessToken === "string") {
        localStorage.setItem("accessToken", data.accessToken);
      }
      setUser(data.user);
      setCurrentView("home");
    },
    onError: (error) => {
      console.error(error);
    },
  });
}

export function useRefreshTokens() {
  const Api = useAxios();
  const { setUser } = useUserStore();

  return useMutation({
    mutationFn: async () => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-refresh" });
      }
      const response = await Api.auth.refreshTokens();
      return response.data;
    },
    onSuccess: (data) => {
      if (APP_TYPE !== "extension" && "accessToken" in data && typeof data.accessToken === "string") {
        localStorage.setItem("accessToken", data.accessToken);
      }
      setUser(data.user);
    },
    onError: (error) => {
      console.error(error);
    },
  });
}

export function useSignInPasswordless() {
  const Api = useAxios();
  const { setToast } = useToastStore();
  return useMutation({
    mutationFn: (data: ILoginIn) =>
      APP_TYPE === "extension"
        ? sendRuntimeCommand<ILoginResponse>({
            type: "runtime:auth-passwordless",
            email: data.email,
          })
        : Api.auth.signInPasswordless(data).then((response) => response.data),
    onError: (error) => {
      if (isAxiosError(error)) {
        setToast({ open: true, text: error?.response?.data.message });
      }

      console.error(error);
    },
  });
}

export function useVerifyEmail() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setCurrentView } = useViewStore();

  return useMutation({
    mutationFn: async (data: IVerifyEmail) => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-verify-email", ...data });
      }
      const response = await Api.auth.verifyEmail(data);
      return response.data;
    },
    onSuccess: (data) => {
      if (APP_TYPE !== "extension" && "accessToken" in data && typeof data.accessToken === "string") {
        localStorage.setItem("accessToken", data.accessToken);
      }
      setUser(data.user);
      setCurrentView("home");
    },
    onError: (error) => {
      console.error(error);
    },
  });
}

export function useResendEmaiOtp() {
  const Api = useAxios();
  const { setToast } = useToastStore();
  return useMutation({
    mutationFn: async (email: string) => {
      if (APP_TYPE === "extension") {
        return sendRuntimeCommand<unknown>({ type: "runtime:auth-resend-email-otp", email });
      }
      return Api.auth.resendEmailOtp(email);
    },
    onSuccess: () => {
      setToast({ open: true, text: "OTP sent successfully" });
    },
    onError: (error) => {
      if (isAxiosError(error)) {
        setToast({ open: true, text: error?.response?.data.message });
      }
      console.error(error);
    },
  });
}

export function useLogout() {
  const Api = useAxios();
  const { clearUser } = useUserStore();
  const { setCurrentView } = useViewStore();

  const { mutate } = useMutation({
    mutationFn: async () => {
      if (APP_TYPE === "extension") {
        await sendRuntimeCommand<void>({ type: "runtime:logout" });
      } else {
        await Api.auth.logout();
      }
    },
    onError: (error) => {
      console.error(error);
    },
  });
  const logout = () => {
    clearUser();
    mutate();
    setCurrentView("sign-in");
  };
  return logout;
}
