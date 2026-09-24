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
import {
  clearWebAccessToken,
  setWebAccessToken,
} from "./web-session";

function authErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const payload = error.response?.data as
      | { message?: unknown }
      | undefined;
    const message = payload?.message;
    if (typeof message === "string" && message.trim()) return message;
    if (message && typeof message === "object") {
      const description = (message as { description?: unknown }).description;
      if (typeof description === "string" && description.trim()) {
        return description;
      }
    }
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function runtimeAuth(
  command: Parameters<typeof sendRuntimeCommand>[0],
): Promise<AuthenticatedRuntimeResult> {
  return sendRuntimeCommand<AuthenticatedRuntimeResult>(command);
}

function saveWebAccessToken(data: unknown): void {
  if (APP_TYPE === "extension" || !data || typeof data !== "object") return;
  const accessToken = (data as { accessToken?: unknown }).accessToken;
  if (typeof accessToken === "string" && accessToken.trim()) {
    setWebAccessToken(accessToken);
  }
}

export function useGoogleSignIn() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setCurrentView } = useViewStore();
  const { setToast } = useToastStore();

  return useMutation({
    mutationFn: async (token: string) => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-google", googleToken: token });
      }
      const response = await Api.auth.googleSign(token);
      return response.data;
    },
    onSuccess: (data) => {
      saveWebAccessToken(data);
      setUser(data.user);
      setCurrentView("home");
    },
    onError: (error) => {
      setToast({
        open: true,
        text: authErrorMessage(error, "Google sign-in failed. Please try again."),
      });
    },
  });
}

export function useRefreshTokens() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setToast } = useToastStore();

  return useMutation({
    mutationFn: async () => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-refresh" });
      }
      const response = await Api.auth.refreshTokens();
      return response.data;
    },
    onSuccess: (data) => {
      saveWebAccessToken(data);
      setUser(data.user);
    },
    onError: (error) => {
      setToast({
        open: true,
        text: authErrorMessage(error, "Your Copyyt session could not be restored."),
      });
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
      setToast({
        open: true,
        text: authErrorMessage(
          error,
          "We could not send the verification email. Please try again.",
        ),
      });
    },
  });
}

export function useVerifyEmail() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setCurrentView } = useViewStore();
  const { setToast } = useToastStore();

  return useMutation({
    mutationFn: async (data: IVerifyEmail) => {
      if (APP_TYPE === "extension") {
        return runtimeAuth({ type: "runtime:auth-verify-email", ...data });
      }
      const response = await Api.auth.verifyEmail(data);
      return response.data;
    },
    onSuccess: (data) => {
      saveWebAccessToken(data);
      setUser(data.user);
      setCurrentView("home");
    },
    onError: (error) => {
      setToast({
        open: true,
        text: authErrorMessage(
          error,
          "The verification code is invalid or has expired.",
        ),
      });
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
      setToast({
        open: true,
        text: authErrorMessage(
          error,
          "We could not resend the verification email. Please try again.",
        ),
      });
    },
  });
}

export function useLogout() {
  const Api = useAxios();
  const { clearUser } = useUserStore();
  const { setCurrentView } = useViewStore();
  const { setToast } = useToastStore();

  const { mutate } = useMutation({
    mutationFn: async () => {
      if (APP_TYPE === "extension") {
        await sendRuntimeCommand<void>({ type: "runtime:logout" });
      } else {
        await Api.auth.logout();
      }
    },
    onError: (error) => {
      setToast({
        open: true,
        text: authErrorMessage(error, "Sign out failed. Please try again."),
      });
    },
  });
  const logout = () => {
    clearUser();
    if (APP_TYPE !== "extension") {
      clearWebAccessToken();
    }
    mutate();
    setCurrentView("sign-in");
  };
  return logout;
}
