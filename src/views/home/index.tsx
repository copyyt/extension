import Button from "@/components/button";
import withAuth from "@/hocs/with-auth.hoc";
import { base64ToBytes } from "@/crypto/bytes";
import { sendRuntimeCommand } from "@/runtime/client";
import type {
  PendingAssistedImageCopyResult,
  RecoveryCredentialResult,
  RuntimeStatus,
} from "@/runtime/messages";
import { useRuntimeStatus } from "@/hooks/runtime-status.hook";
import { useLogout } from "@/hooks/auth.hook";
import { writePngToFocusedClipboard } from "@/clipboard/focused-page-writer";
import { useUserStore } from "@/hooks/user-store.hook";
import Logo from "@/vectors/logo";
import LogoutIcon from "@/vectors/logout";
import { useState } from "react";
import {
  clipboardSyncMode,
  syncPreferencesForStatus,
  type ClipboardSyncMode,
} from "./sync-preferences";

const DIRECT_EXPERIMENT_ENABLED = import.meta.env.VITE_EXTENSION_ENV === "dev";

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
  const [syncPreferencesBusy, setSyncPreferencesBusy] = useState(false);
  const [directTargetId, setDirectTargetId] = useState("");
  const [directBusy, setDirectBusy] = useState(false);
  const [confirmedFingerprint, setConfirmedFingerprint] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryCredential, setRecoveryCredential] = useState<string | null>(null);
  const [recoveryCredentialInput, setRecoveryCredentialInput] = useState("");
  const [recovering, setRecovering] = useState(false);

  const sendCurrentClipboard = async () => {
    setSending(true);
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<{
        itemId: string;
        projectionCount?: number;
      }>({
        type: "runtime:send-current-clipboard",
      });
      setMessage(
        result.projectionCount && result.projectionCount > 1
          ? `Encrypted ${result.projectionCount} capability-specific items accepted.`
          : `Encrypted item accepted: ${result.itemId}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send clipboard");
    } finally {
      setSending(false);
      void reload();
    }
  };

  const copyPendingImage = async (itemId: string) => {
    let prepared = false;
    let focusedWriteSucceeded = false;
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<PendingAssistedImageCopyResult>({
        type: "runtime:copy-pending-image",
        itemId,
      });
      prepared = true;
      await writePngToFocusedClipboard(base64ToBytes(result.pngBase64));
      focusedWriteSucceeded = true;
      await sendRuntimeCommand<RuntimeStatus>({
        type: "runtime:complete-pending-image",
        itemId: result.itemId,
      });
      setMessage("Image copied to the native clipboard.");
    } catch (error) {
      if (prepared && !focusedWriteSucceeded) {
        await sendRuntimeCommand<RuntimeStatus>({
          type: "runtime:release-pending-image",
          itemId,
        }).catch(() => undefined);
      }
      setMessage(error instanceof Error ? error.message : "Unable to copy image");
    } finally {
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

  const exportRecoveryCredential = async () => {
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<RecoveryCredentialResult>({
        type: "runtime:export-recovery-credential",
      });
      setRecoveryCredential(
        `${result.format}\nrootDeviceId=${result.rootDeviceId}\nprivateKeyPkcs8Base64=${result.privateKeyPkcs8Base64}`,
      );
      setMessage(
        "Save this recovery credential offline, then confirm below. Until you confirm, you can export it again.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to export recovery credential");
    }
  };

  const confirmRecoveryCredentialSaved = async () => {
    setMessage(null);
    try {
      await sendRuntimeCommand<RuntimeStatus>({
        type: "runtime:confirm-recovery-credential-saved",
      });
      setRecoveryCredential(null);
      setMessage("Recovery credential saved. It has been removed from this device.");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to confirm the recovery credential");
    }
  };

  const recoverDevice = async () => {
    const credential = recoveryCredentialInput.trim();
    if (!credential) {
      setMessage("Paste your offline recovery credential first.");
      return;
    }
    setRecovering(true);
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<RuntimeStatus>({
        type: "runtime:recover-device",
        credential,
      });
      setMessage(
        result.device.recoveryRotationPending
          ? "Device recovered, but the new recovery key is not confirmed yet. Keep your existing offline credential; Copyyt will retry automatically."
          : "Device recovered. Export the new rotated recovery credential now.",
      );
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to recover this device");
    } finally {
      // Never retain the imported old private key in popup state, even after
      // a rejected request.
      setRecoveryCredentialInput("");
      setRecovering(false);
    }
  };

  const updateClipboardSync = async (mode: ClipboardSyncMode) => {
    const preferences = {
      both: { sendEnabled: true, receiveEnabled: true },
      "send-only": { sendEnabled: true, receiveEnabled: false },
      "receive-only": { sendEnabled: false, receiveEnabled: true },
      off: { sendEnabled: false, receiveEnabled: false },
    }[mode];
    setSyncPreferencesBusy(true);
    setMessage(null);
    try {
      await sendRuntimeCommand<RuntimeStatus>({
        type: "runtime:set-sync-preferences",
        ...preferences,
      });
      await reload();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to update clipboard sync preferences",
      );
    } finally {
      setSyncPreferencesBusy(false);
    }
  };

  const startDirectTest = async () => {
    if (!directTargetId) {
      setMessage("Select a trusted Chrome target first.");
      return;
    }
    setDirectBusy(true);
    setMessage(null);
    try {
      const result = await sendRuntimeCommand<{
        transferId: string;
      }>({
        type: "runtime:start-direct-test",
        recipientDeviceId: directTargetId,
      });
      setMessage(`Direct test started: ${result.transferId.slice(0, 8)}…`);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start direct test");
    } finally {
      setDirectBusy(false);
    }
  };

  const localDeviceTrusted =
    status?.device.trustState === "root" || status?.device.trustState === "verified";
  const pairing = status?.onboarding?.pairing;
  const syncPreferences = syncPreferencesForStatus(status);
  const selectedSyncMode = clipboardSyncMode(syncPreferences);
  const syncModes: Array<{ mode: ClipboardSyncMode; label: string }> = [
    { mode: "both", label: "Both" },
    { mode: "send-only", label: "Send only" },
    { mode: "receive-only", label: "Receive only" },
    { mode: "off", label: "Off" },
  ];

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

      <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">Clipboard Sync</span>
          {syncPreferencesBusy ? (
            <span className="text-xs text-[#4B5563]">Updating…</span>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Clipboard Sync">
          {syncModes.map(({ mode, label }) => (
            <Button
              key={mode}
              variant={selectedSyncMode === mode ? "primary" : "outlined"}
              className="!rounded-lg px-2 text-xs"
              onClick={() => void updateClipboardSync(mode)}
              disabled={syncPreferencesBusy || !status}
              aria-checked={selectedSyncMode === mode}
              role="radio"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {(status?.pendingAssistedImages?.length ?? 0) > 0 ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4">
          <p className="text-sm font-semibold">Image received</p>
          {(status?.pendingAssistedImages ?? []).map((image) => (
            <div key={image.itemId} className="mt-3 flex items-center justify-between gap-3 text-xs">
              <div className="min-w-0 text-[#4B5563]">
                <p>From: {image.sourceDeviceName ?? "Copyyt device"}</p>
                <p className="mt-1">Available until {new Date(image.expiresAt).toLocaleTimeString()}</p>
              </div>
              <Button
                variant="primary"
                className="shrink-0 !rounded-lg px-3 text-xs"
                onClick={() => void copyPendingImage(image.itemId)}
              >
                Copy image
              </Button>
            </div>
          ))}
        </div>
      ) : null}

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

      {status?.device.trustState === "root" &&
      status.device.recoveryAvailable &&
      !status.device.recoveryRotationPending &&
      !status.device.recoveryExportedAt ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4 text-xs">
          <p className="text-sm font-semibold">Offline recovery credential</p>
          <p className="mt-2 text-[#4B5563]">
            Export this once and store it offline. Anyone with it can recover the account root,
            so never paste it into chat or upload it to a website.
          </p>
          <Button
            variant="outlined"
            className="mt-3 w-full"
            onClick={() => void exportRecoveryCredential()}
            disabled={Boolean(recoveryCredential)}
          >
            Export recovery credential
          </Button>
          {recoveryCredential ? (
            <>
              <textarea
                className="mt-3 h-28 w-full resize-none rounded border border-[#D1D5DB] p-2 font-mono text-[10px]"
                readOnly
                value={recoveryCredential}
                aria-label="Offline recovery credential"
              />
              <Button
                className="mt-3 w-full"
                onClick={() => void confirmRecoveryCredentialSaved()}
              >
                I have saved it offline
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {status?.device.recoveryRotationPending ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4 text-xs">
          <p className="text-sm font-semibold">Recovery key not confirmed yet</p>
          <p className="mt-2 text-[#4B5563]">
            The server has not confirmed this device&apos;s recovery key yet, so there is nothing
            to export. Copyyt retries automatically each time this device reconnects. Until then,
            keep your existing offline recovery credential.
          </p>
        </div>
      ) : null}

      {status?.device.registration === "registered" &&
      status.device.trustState === "unverified" &&
      status.onboarding.state !== "complete" ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4 text-xs">
          <p className="text-sm font-semibold">Recover this device</p>
          <p className="mt-2 text-[#4B5563]">
            Paste the offline recovery credential from your previous Copyyt root device.
            The credential is used once, rotated immediately, and never stored by this extension.
          </p>
          <textarea
            className="mt-3 h-28 w-full resize-none rounded border border-[#D1D5DB] p-2 font-mono text-[10px]"
            value={recoveryCredentialInput}
            onChange={(event) => setRecoveryCredentialInput(event.target.value)}
            aria-label="Offline recovery credential to import"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="outlined"
            className="mt-3 w-full"
            onClick={() => void recoverDevice()}
            disabled={recovering || !recoveryCredentialInput.trim()}
          >
            {recovering ? "Recovering device…" : "Recover device"}
          </Button>
        </div>
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

      {DIRECT_EXPERIMENT_ENABLED ? (
        <div className="mt-3 rounded-lg border border-[#D1D5DB] p-4 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">Direct transport experiment</span>
            <span className="text-[#4B5563]">development only</span>
          </div>
          <select
            className="mt-3 w-full rounded border border-[#D1D5DB] px-2 py-2"
            value={directTargetId}
            onChange={(event) => setDirectTargetId(event.target.value)}
            aria-label="Direct transport target"
          >
            <option value="">Select trusted Chrome B…</option>
            {(status?.directTargets ?? []).map((target) => (
              <option key={target.deviceId} value={target.deviceId}>
                {target.name} · {target.platform}
              </option>
            ))}
          </select>
          <Button
            variant="outlined"
            className="mt-3 w-full"
            onClick={() => void startDirectTest()}
            disabled={
              directBusy ||
              !directTargetId ||
              !status?.syncReady ||
              !localDeviceTrusted
            }
          >
            {directBusy ? "Starting direct test…" : "Send 2 MiB test"}
          </Button>
          {(status?.directTransfers ?? []).slice(0, 1).map((transfer) => (
            <div key={transfer.transferId} className="mt-3 text-[#4B5563]">
              <p>Transfer: {transfer.transferId.slice(0, 8)}…</p>
              <p className="mt-1">State: {transfer.state}</p>
              {transfer.byteLength ? (
                <p className="mt-1">
                  Bytes: {transfer.bytesReceived ?? transfer.bytesSent ?? 0} / {transfer.byteLength}
                </p>
              ) : null}
              {transfer.error ? <p className="mt-1 text-[#FF2635]">{transfer.error}</p> : null}
            </div>
          ))}
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
        disabled={
          sending ||
          !status?.signedIn ||
          !localDeviceTrusted ||
          !syncPreferences.sendEnabled
        }
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
