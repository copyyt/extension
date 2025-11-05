import { SOCKET_URL } from "@/utils/constants";
import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

export function useSocket(onMessage: (value: string) => void) {
  const socket = useMemo(() => {
    return io(SOCKET_URL, {
      extraHeaders: {
        Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
      },
      withCredentials: true,
      autoConnect: false,
    });
  }, []);

  const [isConnected, setIsConnected] = useState(socket.connected);
  useEffect(() => {
    socket.connect();
    function onConnect() {
      setIsConnected(true);
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
      socket.disconnect();
    };
  }, []); // eslint-disable-line

  return { socket, isConnected };
}
