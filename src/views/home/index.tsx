import Button from "@/components/button";
import withAuth from "@/hocs/with-auth.hoc";
import { sendRuntimeCommand } from "@/runtime/client";
import type { RuntimeStatus } from "@/runtime/messages";
import { useRuntimeStatus } from "@/hooks/runtime-status.hook";
import { useLogout } from "@/hooks/auth.hook";
import { useUserStore } from "@/hooks/user-store.hook";
import Logo from "@/vectors/logo";
import LogoutIcon from "@/vectors/logout";
import { useState } from "react";

function statusLabel(status: RuntimeStatus): string {
  switch (status.connectionState) {
    case "ready":
      return "Ready";
    case "device-authenticating":
      return "Authenticating device";
    case "connecting":
      return "Connecting";
    case "account-authenticated":
      return "Signed in; connecting device";
    case "error":
      return status.lastSyncError?.message ?? "Connection error";
    default:
      return "Signed out";
  }
}

function Home() {
  const { user } = useUserStore();
  const logout = useLogout();
  const { status, reload } = useRuntimeStatus();
  const [sending, setSending] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const sendCurrentClipboard = async () => {
    setSending(true);
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<{ itemId: string }>({
        type: "runtime:send-current-clipboard",
      });
      setMessage(`Encrypted item accepted: ${result.itemId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send clipboard");
    } finally {
      setSending(false);
      void reload();
    }
  };

  const trustThisDevice = async () => {
    setTrusting(true);
    setMessage(null);
    try {
      await sendRuntimeCommand<RuntimeStatus>({ type: "runtime:bootstrap-trust-anchor" });
      setMessage("This device is now locally trusted.");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to trust this device");
    } finally {
      setTrusting(false);
    }
  };

  const localDeviceTrusted =
    status?.device.trustState === "root" || status?.device.trustState === "verified";

  return (
    <section className="flex h-full flex-col sm:block">
      <div className="flex items-center justify-between">
        <div className="font-sora flex items-center gap-2 font-bold">
          <Logo /> Copyyt
        </div>
        <div className="flex items-center gap-5">
          <Button
            variant="outlined"
            className="flex items-center gap-2 !border-[#FF2635] !text-[#FF2635]"
            onClick={logout}
          >
            <LogoutIcon />
            Logout
          </Button>
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[#1E6892] font-semibold text-white uppercase">
            {(user?.name ?? status?.user?.name ?? "o").slice(0, 1)}
          </div>
        </div>
      </div>

      <p className="font-work mt-4 text-sm text-[#4B5563]">
        Copyyt sends clipboard text as an encrypted device-to-device envelope.
        The server never receives the plaintext.
      </p>

      <div className="mt-7 space-y-3 rounded-lg border border-[#D1D5DB] p-4 text-xs">
        <div className="flex justify-between gap-4">
          <span className="text-[#4B5563]">Account</span>
          <span>{status?.signedIn ? "Signed in" : "Signed out"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#4B5563]">Device</span>
          <span>{status?.device.registration ?? "unknown"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#4B5563]">Local trust</span>
          <span>{status?.device.trustState ?? "unknown"}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#4B5563]">Socket</span>
          <span>{status ? statusLabel(status) : "Loading"}</span>
        </div>
      </div>

      {!localDeviceTrusted && status?.device.registration === "registered" ? (
        <Button
          variant="outlined"
          className="mt-3 w-full"
          onClick={trustThisDevice}
          disabled={trusting}
        >
          {trusting ? "Trusting device…" : "Trust this device (first setup)"}
        </Button>
      ) : null}

      <Button
        variant="primary"
        className="mt-3 w-full"
        onClick={sendCurrentClipboard}
        disabled={sending || status?.connectionState !== "ready" || !localDeviceTrusted}
      >
        {sending ? "Encrypting and sending…" : "Send current clipboard"}
      </Button>

      {status?.lastSyncError ? (
        <p className="mt-3 text-xs text-[#FF2635]">{status.lastSyncError.message}</p>
      ) : null}
      {message ? <p className="mt-3 break-all text-xs text-[#4B5563]">{message}</p> : null}
    </section>
  );
}

const HomeWithAuth = withAuth(Home);

export default HomeWithAuth;
