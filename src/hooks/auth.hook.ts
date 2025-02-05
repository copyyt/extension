import { useMutation } from "@tanstack/react-query";
import { useAxios } from "./axios.hook";
import { useUserStore } from "./user-store.hook";
import { useViewStore } from "./view-store.hook";
import { ILoginIn, IVerifyEmail } from "@/interfaces/auth.interface";
import { useToastStore } from "./toast-store.hook";
import { isAxiosError } from "axios";

export function useGoogleSignIn() {
  const Api = useAxios();
  const { setUser } = useUserStore();
  const { setCurrentView } = useViewStore();

  return useMutation({
    mutationFn: (token: string) => Api.auth.googleSign(token),
    onSuccess: (data) => {
      localStorage.setItem("accessToken", data.data.accessToken);
      setUser(data.data.user);
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
    mutationFn: () => Api.auth.refreshTokens(),
    onSuccess: (data) => {
      localStorage.setItem("accessToken", data.data.accessToken);
      setUser(data.data.user);
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
    mutationFn: (data: ILoginIn) => Api.auth.signInPasswordless(data),
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
    mutationFn: (data: IVerifyEmail) => Api.auth.verifyEmail(data),
    onSuccess: (data) => {
      localStorage.setItem("accessToken", data.data.accessToken);
      setUser(data.data.user);
      setCurrentView("home");
    },
    onError: (error) => {
      console.error(error);
    },
  });
}

export function useLogout() {
  const { clearUser } = useUserStore();
  const { setCurrentView } = useViewStore();
  const logout = () => {
    localStorage.removeItem("accessToken");
    clearUser();
    setCurrentView("sign-in");
  };
  return logout;
}
