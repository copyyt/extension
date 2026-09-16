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
      return status.syncReady ? "Ready" : "Connected; pairing required";
    case "device-authenticating":
      return "Authenticating device";
    case "connecting":
      return "Connecting";
    case "account-authenticated":
      return "Signed in; connecting device";
    case "error":
      return status.lastConnectionError?.message ?? status.lastSyncError?.message ?? "Connection error";
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
  const [pairingBusy, setPairingBusy] = useState(false);
  const [confirmedFingerprint, setConfirmedFingerprint] = useState("");
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

  const refreshOnboarding = async () => {
    setPairingBusy(true);
    setMessage(null);
    try {
      await sendRuntimeCommand<RuntimeStatus>({ type: "runtime:refresh-onboarding" });
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to refresh pairing state");
    } finally {
      setPairingBusy(false);
    }
  };

  const completePairing = async () => {
    const pairing = status?.onboarding?.pairing;
    if (!pairing || !confirmedFingerprint.trim()) {
      setMessage("Enter the fingerprint shown on both devices.");
      return;
    }
    setPairingBusy(true);
    setMessage(null);
    try {
      if (pairing.role === "approver") {
        await sendRuntimeCommand<RuntimeStatus>({
          type: "runtime:approve-pending-device",
          pendingDeviceId: pairing.pendingDeviceId,
          confirmedFingerprint: confirmedFingerprint.trim().toUpperCase(),
        });
        setMessage("Device approved. Confirm the same fingerprint on the other device.");
      } else {
        await sendRuntimeCommand<RuntimeStatus>({
          type: "runtime:confirm-paired-approver",
          approverDeviceId: pairing.approverDeviceId,
          confirmedFingerprint: confirmedFingerprint.trim().toUpperCase(),
        });
        setMessage("Pairing confirmation recorded.");
      }
      setConfirmedFingerprint("");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to complete pairing");
    } finally {
      setPairingBusy(false);
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
  const pairing = status?.onboarding?.pairing;

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

      {status?.onboarding?.bootstrapEligible === true ? (
        <Button
          variant="outlined"
          className="mt-3 w-full"
          onClick={trustThisDevice}
          disabled={trusting}
        >
          {trusting ? "Trusting device…" : "Trust this device (first setup)"}
        </Button>
      ) : null}

      {status?.onboarding?.state === "pairing-required" ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-3 text-xs">
          <p className="font-semibold">Pair this device with an existing Copyyt device.</p>
          <p className="mt-2 text-[#4B5563]">
            {status.onboarding.error?.message ??
              (status.device.trustState === "verified"
                ? "New device approval is waiting on your account root device."
                : "Confirm the account root fingerprint on this device to continue.")}
          </p>
          <Button variant="outlined" className="mt-3 w-full" onClick={refreshOnboarding} disabled={pairingBusy}>
            {pairingBusy ? "Refreshing…" : "Refresh pairing"}
          </Button>
        </div>
      ) : null}

      {pairing ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-3 text-xs">
          <p className="font-semibold">
            {pairing.role === "approver" ? "Approve a pending device" : "Confirm this device pairing"}
          </p>
          <p className="mt-2 text-[#4B5563]">
            {pairing.pendingDeviceName ?? "Pending device"}
            {pairing.pendingPlatform ? ` · ${pairing.pendingPlatform}` : ""}
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-[#4B5563]">
            Device ID: {pairing.pendingDeviceId}
          </p>
          <p className="mt-2 break-all font-mono text-sm tracking-wide">{pairing.fingerprint}</p>
          {status.onboarding.state === "waiting-for-approval" ? (
            <p className="mt-2 text-[#4B5563]">Waiting for approval on the other device.</p>
          ) : (
            <>
              <input
                className="mt-3 w-full rounded border border-[#D1D5DB] px-2 py-2 font-mono text-xs uppercase"
                value={confirmedFingerprint}
                onChange={(event) => setConfirmedFingerprint(event.target.value)}
                placeholder="XXXX-XXXX-…"
                aria-label="Confirmed pairing fingerprint"
              />
              <Button variant="outlined" className="mt-3 w-full" onClick={completePairing} disabled={pairingBusy}>
                {pairingBusy ? "Working…" : pairing.role === "approver" ? "Approve device" : "Confirm and pair"}
              </Button>
            </>
          )}
          <Button variant="outlined" className="mt-2 w-full" onClick={refreshOnboarding} disabled={pairingBusy}>
            Refresh pairing
          </Button>
        </div>
      ) : null}

      {!pairing && status?.signedIn ? (
        <Button variant="outlined" className="mt-3 w-full" onClick={refreshOnboarding} disabled={pairingBusy}>
          {pairingBusy ? "Refreshing…" : "Refresh onboarding"}
        </Button>
      ) : null}

      <Button
        variant="primary"
        className="mt-3 w-full"
        onClick={sendCurrentClipboard}
        disabled={sending || status?.connectionState !== "ready" || !status?.syncReady || !localDeviceTrusted}
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
