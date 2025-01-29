import { useMutation } from "@tanstack/react-query";
import { useAxios } from "./axios.hook";
import { useUserStore } from "./user-store.hook";
import { useViewStore } from "./view-store.hook";

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
