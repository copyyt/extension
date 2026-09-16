import { useCallback, useEffect, useState } from "react";
import { getRuntimeStatus, isRuntimeStatusBroadcast } from "@/runtime/client";
import type { RuntimeStatus } from "@/runtime/messages";

export function useRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const reload = useCallback(async () => {
    const next = await getRuntimeStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void reload();
    const onMessage = (message: unknown) => {
      if (isRuntimeStatusBroadcast(message)) setStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [reload]);

  return { status, reload };
}
