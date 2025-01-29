import { SOCKET_URL } from "@/utils/constants";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io(SOCKET_URL, {
  extraHeaders: {
    Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
  },
  withCredentials: true,
});

export function useSocket(onMessage: (value: string) => void) {
  const [isConnected, setIsConnected] = useState(socket.connected);
  useEffect(() => {
    function onConnect() {
      setIsConnected(true);
      console.log("connected");
    }

    function onDisconnect() {
      setIsConnected(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("message", onMessage);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("message", onMessage);
    };
  }, [onMessage]);

  return { socket, isConnected };
}
