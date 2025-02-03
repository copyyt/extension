import { useQuery } from "@tanstack/react-query";
import { useAuthAxios } from "./axios.hook";

export function useGetLastMessage() {
  const Api = useAuthAxios();

  return useQuery({
    queryFn: () => Api.user.lastMessage(),
    queryKey: ["lastMessage"],
  });
}
