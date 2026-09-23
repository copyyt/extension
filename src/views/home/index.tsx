import withAuth from "@/hocs/with-auth.hoc";
import { base64ToBytes } from "@/crypto/bytes";
import { sendRuntimeCommand } from "@/runtime/client";
import type {
  ManagedDevice,
  PendingAssistedImageCopyResult,
  RecoveryCredentialResult,
  RuntimeStatus,
} from "@/runtime/messages";
import { useRuntimeStatus } from "@/hooks/runtime-status.hook";
import { useLogout } from "@/hooks/auth.hook";
import { writePngToFocusedClipboard } from "@/clipboard/focused-page-writer";
import { useUserStore } from "@/hooks/user-store.hook";
import Logo from "@/vectors/logo";
import { useEffect, useState } from "react";
import {
  Alert,
  Card,
  CardTitle,
  Fingerprint,
  Muted,
  StatusPill,
  TextArea,
  TextInput,
  UiButton,
} from "@/components/ui";
import {
  clipboardSyncMode,
  syncPreferencesForStatus,
  type ClipboardSyncMode,
} from "./sync-preferences";

type Feedback = { tone: "info" | "error" | "success"; text: string } | null;
type Tab = "home" | "devices" | "settings";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function connection(status: RuntimeStatus | null): { tone: "ok" | "wait" | "bad"; label: string } {
  if (!status) return { tone: "wait", label: "Loading" };
  if (status.device.removed) return { tone: "bad", label: "Removed" };
  if (status.onboarding?.bootstrapEligible) return { tone: "wait", label: "Setup" };
  if (status.connectionState === "ready" && status.syncReady) return { tone: "ok", label: "Connected" };
  if (status.connectionState === "error") return { tone: "bad", label: "Offline" };
  if (status.connectionState === "ready") return { tone: "wait", label: "Needs pairing" };
  return { tone: "wait", label: "Connecting" };
}

function Home() {
  const { user } = useUserStore();
  const logout = useLogout();
  const { status, reload } = useRuntimeStatus();
  const [tab, setTab] = useState<Tab>("home");
  const [feedback, setFeedback] = useState<Feedback>(null);

  const run = async (
    action: () => Promise<unknown>,
    fallback: string,
    success?: string,
  ): Promise<boolean> => {
    setFeedback(null);
    try {
      await action();
      if (success) setFeedback({ tone: "success", text: success });
      await reload();
      return true;
    } catch (error) {
      setFeedback({ tone: "error", text: errorText(error, fallback) });
      void reload();
      return false;
    }
  };

  const account = user ?? status?.user;
  const trusted = status?.device.trustState === "root" || status?.device.trustState === "verified";

  // Devices waiting for approval are only discovered by a trust refresh, so
  // check once each time the popup opens on a set-up device.
  const [checkedOnOpen, setCheckedOnOpen] = useState(false);
  useEffect(() => {
    if (!trusted || checkedOnOpen) return;
    setCheckedOnOpen(true);
    void sendRuntimeCommand({ type: "runtime:refresh-onboarding" }).then(reload, () => undefined);
  }, [trusted, checkedOnOpen, reload]);
  const pairing = status?.onboarding?.pairing;
  const approverPairing = trusted && pairing?.role === "approver" ? pairing : undefined;
  const pill = connection(status);

  let body: React.ReactNode;
  if (!status) {
    body = <Muted className="mt-6 text-center">Loading…</Muted>;
  } else if (status.device.removed) {
    body = <RemovedScreen run={run} />;
  } else if (status.onboarding?.bootstrapEligible === true) {
    body = <FirstSetupScreen run={run} />;
  } else if (!trusted) {
    body = <PairingScreen status={status} run={run} reload={reload} />;
  } else {
    body = (
      <>
        <Tabs tab={tab} setTab={setTab} devicesBadge={Boolean(approverPairing)} />
        <div className="mt-4 space-y-3">
          {tab === "home" ? (
            <HomeTab status={status} run={run} goTo={setTab} setFeedback={setFeedback} />
          ) : tab === "devices" ? (
            <DevicesTab status={status} run={run} reload={reload} />
          ) : (
            <SettingsTab status={status} run={run} onReset={reload} onSignOut={logout} />
          )}
        </div>
      </>
    );
  }

  return (
    <section className="flex flex-col">
      <header className="flex items-center justify-between gap-3">
        <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
          <Logo /> Copyyt
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          <div
            title={account?.email ?? ""}
            className="font-sora flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary uppercase"
          >
            {(account?.name ?? account?.email ?? "C").slice(0, 1)}
          </div>
        </div>
      </header>
      <div className="mt-4 space-y-3">
        {body}
        {feedback ? <Alert tone={feedback.tone}>{feedback.text}</Alert> : null}
        {status?.lastSyncError && trusted ? (
          <Alert tone="error">{status.lastSyncError.message}</Alert>
        ) : null}
      </div>
    </section>
  );
}

type Run = (action: () => Promise<unknown>, fallback: string, success?: string) => Promise<boolean>;

function Tabs({ tab, setTab, devicesBadge }: { tab: Tab; setTab: (tab: Tab) => void; devicesBadge: boolean }) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "home", label: "Home" },
    { id: "devices", label: "Devices" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="grid grid-cols-3 gap-1 rounded-xl bg-soft p-1" role="tablist">
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          onClick={() => setTab(item.id)}
          className={`font-work relative cursor-pointer rounded-lg py-1.5 text-sm font-semibold transition-colors ${
            tab === item.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {item.label}
          {item.id === "devices" && devicesBadge ? (
            <span className="absolute top-1.5 right-4 h-2 w-2 rounded-full bg-danger" />
          ) : null}
        </button>
      ))}
    </nav>
  );
}

// ---- Tabs --------------------------------------------------------------

const syncModes: Array<{ mode: ClipboardSyncMode; label: string; help: string }> = [
  { mode: "both", label: "Send & receive", help: "Copies here reach your devices, and theirs land here." },
  { mode: "send-only", label: "Send only", help: "Copies here reach your devices; nothing arrives here." },
  { mode: "receive-only", label: "Receive only", help: "Copies from your devices land here; nothing is sent." },
  { mode: "off", label: "Paused", help: "Nothing is sent or received on this device." },
];

function HomeTab({
  status,
  run,
  goTo,
  setFeedback,
}: {
  status: RuntimeStatus;
  run: Run;
  goTo: (tab: Tab) => void;
  setFeedback: (feedback: Feedback) => void;
}) {
  const [sending, setSending] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const preferences = syncPreferencesForStatus(status);
  const mode = clipboardSyncMode(preferences);
  const approverPairing = status.onboarding?.pairing?.role === "approver" ? status.onboarding.pairing : undefined;
  const recoveryToSave =
    status.device.trustState === "root" &&
    status.device.recoveryAvailable &&
    !status.device.recoveryRotationPending &&
    !status.device.recoveryExportedAt;

  const setMode = async (next: ClipboardSyncMode) => {
    const preferencesFor = {
      both: { sendEnabled: true, receiveEnabled: true },
      "send-only": { sendEnabled: true, receiveEnabled: false },
      "receive-only": { sendEnabled: false, receiveEnabled: true },
      off: { sendEnabled: false, receiveEnabled: false },
    }[next];
    setModeBusy(true);
    await run(
      () => sendRuntimeCommand({ type: "runtime:set-sync-preferences", ...preferencesFor }),
      "Unable to change clipboard sync",
    );
    setModeBusy(false);
  };

  const send = async () => {
    setSending(true);
    await run(
      () => sendRuntimeCommand({ type: "runtime:send-current-clipboard" }),
      "Unable to send your clipboard",
      "Sent to your devices.",
    );
    setSending(false);
  };

  const copyImage = async (itemId: string) => {
    let prepared = false;
    let written = false;
    setFeedback(null);
    try {
      const result = await sendRuntimeCommand<PendingAssistedImageCopyResult>({
        type: "runtime:copy-pending-image",
        itemId,
      });
      prepared = true;
      await writePngToFocusedClipboard(base64ToBytes(result.pngBase64));
      written = true;
      await sendRuntimeCommand({ type: "runtime:complete-pending-image", itemId: result.itemId });
      setFeedback({ tone: "success", text: "Image copied. Paste it anywhere." });
    } catch (error) {
      if (prepared && !written) {
        await sendRuntimeCommand({ type: "runtime:release-pending-image", itemId }).catch(() => undefined);
      }
      setFeedback({ tone: "error", text: errorText(error, "Unable to copy the image") });
    }
  };

  return (
    <>
      {approverPairing ? (
        <Card tone="accent">
          <CardTitle>{approverPairing.pendingDeviceName ?? "A new device"} wants to join</CardTitle>
          <Muted className="mt-1">Approve it on the Devices tab by typing the code it shows.</Muted>
          <UiButton className="mt-3 w-full" onClick={() => goTo("devices")}>Review</UiButton>
        </Card>
      ) : null}
      {status.onboarding?.rootMissing ? (
        <Card tone="accent">
          <CardTitle>Your account root was removed</CardTitle>
          <Muted className="mt-1">Syncing still works, but new devices can&apos;t join until a device becomes the root.</Muted>
          <UiButton tone="secondary" className="mt-3 w-full" onClick={() => goTo("settings")}>Fix this</UiButton>
        </Card>
      ) : null}
      {recoveryToSave ? (
        <Card tone="accent">
          <CardTitle>Save your recovery credential</CardTitle>
          <Muted className="mt-1">It lets you recover your account if you lose this device.</Muted>
          <UiButton tone="secondary" className="mt-3 w-full" onClick={() => goTo("settings")}>Save it now</UiButton>
        </Card>
      ) : null}

      {(status.pendingAssistedImages ?? []).map((image) => (
        <Card key={image.itemId} tone="accent">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Image from {image.sourceDeviceName ?? "your device"}</CardTitle>
              <Muted>Available until {new Date(image.expiresAt).toLocaleTimeString()}</Muted>
            </div>
            <UiButton onClick={() => void copyImage(image.itemId)}>Copy image</UiButton>
          </div>
        </Card>
      ))}

      <Card>
        <CardTitle>Clipboard sync</CardTitle>
        <div className="mt-3 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Clipboard sync">
          {syncModes.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="radio"
              aria-checked={mode === item.mode}
              disabled={modeBusy}
              onClick={() => void setMode(item.mode)}
              className={`font-work cursor-pointer rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:cursor-wait ${
                mode === item.mode
                  ? "border-primary bg-soft text-ink"
                  : "border-line bg-surface text-muted hover:border-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Muted className="mt-2">{syncModes.find((item) => item.mode === mode)?.help}</Muted>
      </Card>

      <UiButton
        size="lg"
        className="w-full"
        onClick={() => void send()}
        disabled={sending || !status.syncReady || !preferences.sendEnabled}
      >
        {sending ? "Sending…" : "Send current clipboard"}
      </UiButton>
      <Muted className="text-center">
        {preferences.sendEnabled
          ? "Copies are sent automatically. Use this to resend what's on your clipboard."
          : "Sending is off for this device."}
      </Muted>
    </>
  );
}

function DevicesTab({ status, run, reload }: { status: RuntimeStatus; run: Run; reload: () => Promise<unknown> }) {
  const pairing = status.onboarding?.pairing?.role === "approver" ? status.onboarding.pairing : undefined;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const checkForDevices = async () => {
    setChecking(true);
    await run(
      () => sendRuntimeCommand({ type: "runtime:refresh-onboarding" }),
      "Unable to check for new devices",
    );
    await reload();
    setListVersion((version) => version + 1);
    setChecking(false);
  };
  const approve = async () => {
    if (!pairing) return;
    setBusy(true);
    const ok = await run(
      () =>
        sendRuntimeCommand({
          type: "runtime:approve-pending-device",
          pendingDeviceId: pairing.pendingDeviceId,
          confirmedFingerprint: code.trim().toUpperCase(),
        }),
      "Unable to approve the device",
      "Device approved. It will finish pairing on its own.",
    );
    if (ok) {
      setCode("");
      setListVersion((version) => version + 1);
    }
    setBusy(false);
  };
  return (
    <>
      <UiButton tone="secondary" className="w-full" disabled={checking} onClick={() => void checkForDevices()}>
        {checking ? "Checking…" : "Check for new devices"}
      </UiButton>
      {pairing ? (
        <Card tone="accent">
          <CardTitle>Approve {pairing.pendingDeviceName ?? "new device"}</CardTitle>
          <Muted className="mt-1">
            That device shows the code below. Check they match, then type the code from that device to approve it.
          </Muted>
          <div className="mt-2">
            <Fingerprint value={pairing.fingerprint} />
          </div>
          <TextInput
            className="mt-3 font-mono uppercase"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Type the code from the other device"
            aria-label="Pairing code"
          />
          <UiButton className="mt-3 w-full" disabled={busy || !code.trim()} onClick={() => void approve()}>
            {busy ? "Approving…" : "Approve device"}
          </UiButton>
        </Card>
      ) : null}
      <DeviceManager key={listVersion} />
      <Muted className="text-center">
        To add a device, install Copyyt on it and sign in with the same account, then check for new devices here.
      </Muted>
    </>
  );
}

function SettingsTab({
  status,
  run,
  onReset,
  onSignOut,
}: {
  status: RuntimeStatus;
  run: Run;
  onReset: () => Promise<unknown>;
  onSignOut: () => void;
}) {
  const account = status.user;
  return (
    <>
      <Card>
        <CardTitle>Account</CardTitle>
        <Muted className="mt-1">
          {account?.name ? `${account.name} · ` : ""}
          {account?.email ?? "Signed in"}
        </Muted>
        <Muted className="mt-1">
          This device is {status.device.trustState === "root" ? "your account root" : "a paired device"}.
          Clipboard content is end-to-end encrypted; the server never sees it.
        </Muted>
      </Card>
      {status.onboarding?.rootMissing && status.device.trustState === "verified" ? (
        <RecoveryImport
          title="Make this device the root"
          body="Your account root was removed. Paste your offline recovery credential to make this device the new root. It's used once and replaced with a new credential."
          action="Make this device the root"
          run={run}
        />
      ) : null}
      <RecoveryExport status={status} run={run} />
      <AccountReset onReset={onReset} />
      <UiButton tone="danger-outline" className="w-full" onClick={onSignOut}>
        Sign out
      </UiButton>
    </>
  );
}

// ---- Setup screens -----------------------------------------------------

function FirstSetupScreen({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <p className="font-sora text-xl font-bold text-ink">Welcome to Copyyt</p>
      <Muted className="mt-2">
        This is the first device on your account, so it becomes your account root: the device that approves every
        other device you add. You&apos;ll save a recovery credential next, in case you lose it.
      </Muted>
      <UiButton
        size="lg"
        className="mt-4 w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await run(() => sendRuntimeCommand({ type: "runtime:bootstrap-trust-anchor" }), "Unable to set up this device");
          setBusy(false);
        }}
      >
        {busy ? "Setting up…" : "Set up this device"}
      </UiButton>
    </Card>
  );
}

function PairingScreen({ status, run, reload }: { status: RuntimeStatus; run: Run; reload: () => Promise<unknown> }) {
  const pairing = status.onboarding?.pairing;
  const waiting = status.onboarding?.state === "waiting-for-approval";
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    // The root approves on another device; poll gently until it does.
    const timer = setInterval(() => {
      void sendRuntimeCommand({ type: "runtime:refresh-onboarding" }).then(reload, () => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  return (
    <>
      <Card>
        <p className="font-sora text-lg font-bold text-ink">Pair this device</p>
        {pairing ? (
          <>
            <Muted className="mt-2">
              {waiting
                ? "Now approve this device on your root device: open Copyyt there, go to Devices, and type this code."
                : "Open Copyyt on your root device. It shows a code for this device; check it's exactly the one below."}
            </Muted>
            <div className="mt-3">
              <Fingerprint value={pairing.fingerprint} />
            </div>
            {waiting ? (
              <Muted className="mt-3 text-center">Waiting for approval… this updates by itself.</Muted>
            ) : (
              <>
                <Muted className="mt-3">
                  Only continue if both codes match. A different code means something is intercepting the
                  pairing: stop, and don&apos;t approve it.
                </Muted>
                <UiButton
                  className="mt-3 w-full"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await run(
                      () =>
                        sendRuntimeCommand({
                          type: "runtime:confirm-paired-approver",
                          approverDeviceId: pairing.approverDeviceId,
                          confirmedFingerprint: pairing.fingerprint,
                        }),
                      "Unable to confirm pairing",
                    );
                    setBusy(false);
                  }}
                >
                  {busy ? "Confirming…" : "The codes match"}
                </UiButton>
              </>
            )}
          </>
        ) : (
          <Muted className="mt-2">
            {status.onboarding?.error?.message ??
              "Waiting for your account root. Make sure Copyyt is open on your root device, then check again."}
          </Muted>
        )}
        <UiButton
          tone="ghost"
          className="mt-2 w-full"
          disabled={busy}
          onClick={() => void run(() => sendRuntimeCommand({ type: "runtime:refresh-onboarding" }), "Unable to check pairing")}
        >
          Check again
        </UiButton>
      </Card>
      <Collapsible label="Have a recovery credential?">
        <RecoveryImport
          title="Recover with your credential"
          body="If your root device was removed, paste the recovery credential you saved from it to make this device the new root."
          action="Recover this device"
          run={run}
        />
      </Collapsible>
      <AccountReset onReset={reload} />
    </>
  );
}

function RemovedScreen({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card tone="danger">
      <p className="font-sora text-lg font-bold text-ink">This device was removed</p>
      <Muted className="mt-2">
        It was removed from your account and can&apos;t sync. Setting it up again creates a new device that your root
        device must approve, like a fresh install.
      </Muted>
      <UiButton
        size="lg"
        className="mt-4 w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await run(() => sendRuntimeCommand({ type: "runtime:reset-device" }), "Unable to set this device up again");
          setBusy(false);
        }}
      >
        {busy ? "Setting up…" : "Set up this device again"}
      </UiButton>
    </Card>
  );
}

// ---- Recovery ----------------------------------------------------------

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <>{children}</>
  ) : (
    <UiButton tone="ghost" className="w-full" onClick={() => setOpen(true)}>
      {label}
    </UiButton>
  );
}

function RecoveryImport({ title, body, action, run }: { title: string; body: string; action: string; run: Run }) {
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <Muted className="mt-1">{body}</Muted>
      <TextArea
        className="mt-3"
        value={credential}
        onChange={(event) => setCredential(event.target.value)}
        placeholder={"copyyt-recovery-v1\nrootDeviceId=…\nprivateKeyPkcs8Base64=…"}
        aria-label="Offline recovery credential"
      />
      <UiButton
        className="mt-3 w-full"
        disabled={busy || !credential.trim()}
        onClick={async () => {
          setBusy(true);
          await run(
            () => sendRuntimeCommand({ type: "runtime:recover-device", credential: credential.trim() }),
            "Unable to recover this device",
            "This device is now your account root. Save the new recovery credential in Settings.",
          );
          // Never keep the old private key in popup state, even on failure.
          setCredential("");
          setBusy(false);
        }}
      >
        {busy ? "Working…" : action}
      </UiButton>
    </Card>
  );
}

function RecoveryExport({ status, run }: { status: RuntimeStatus; run: Run }) {
  const [credential, setCredential] = useState<string | null>(null);
  if (status.device.trustState !== "root") return null;
  if (status.device.recoveryRotationPending) {
    return (
      <Card>
        <CardTitle>Recovery credential</CardTitle>
        <Muted className="mt-1">
          Not confirmed by the server yet. Copyyt retries each time this device reconnects; keep your existing
          credential until then.
        </Muted>
      </Card>
    );
  }
  if (status.device.recoveryExportedAt) {
    return (
      <Card>
        <CardTitle>Recovery credential</CardTitle>
        <Muted className="mt-1">Saved on {new Date(status.device.recoveryExportedAt).toLocaleDateString()} and removed from this device. Keep your offline copy safe.</Muted>
      </Card>
    );
  }
  if (!status.device.recoveryAvailable) return null;
  return (
    <Card tone="accent">
      <CardTitle>Recovery credential</CardTitle>
      <Muted className="mt-1">
        If you lose this device, this credential lets another device become your root. Store it offline, for example
        in a password manager. Anyone with it can take over your devices.
      </Muted>
      {credential ? (
        <>
          <TextArea className="mt-3" readOnly value={credential} aria-label="Offline recovery credential" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <UiButton tone="secondary" onClick={() => void navigator.clipboard.writeText(credential)}>
              Copy
            </UiButton>
            <UiButton
              onClick={async () => {
                const ok = await run(
                  () => sendRuntimeCommand({ type: "runtime:confirm-recovery-credential-saved" }),
                  "Unable to confirm",
                  "Saved. The credential was removed from this device.",
                );
                if (ok) setCredential(null);
              }}
            >
              I&apos;ve saved it
            </UiButton>
          </div>
          <Muted className="mt-2">Until you confirm, you can show it again.</Muted>
        </>
      ) : (
        <UiButton
          className="mt-3 w-full"
          onClick={async () => {
            await run(async () => {
              const result = await sendRuntimeCommand<RecoveryCredentialResult>({
                type: "runtime:export-recovery-credential",
              });
              setCredential(
                `${result.format}\nrootDeviceId=${result.rootDeviceId}\nprivateKeyPkcs8Base64=${result.privateKeyPkcs8Base64}`,
              );
            }, "Unable to show the recovery credential");
          }}
        >
          Show recovery credential
        </UiButton>
      )}
    </Card>
  );
}

/**
 * Last resort when the root or the recovery credential is lost. Confirmed
 * with a code emailed to the account, not with a device.
 */
function AccountReset({ onReset }: { onReset: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Feedback>(null);

  const requestCode = async () => {
    const confirmed = window.confirm(
      "Reset your Copyyt account?\n\n" +
        "Every device is removed, including this one, and your recovery credential stops working. " +
        "This device becomes the new root; each other device must be set up and paired again.\n\n" +
        "We'll email you a code to confirm.",
    );
    if (!confirmed) return;
    setBusy(true);
    setNote(null);
    try {
      await sendRuntimeCommand({ type: "runtime:request-account-reset-code" });
      setCodeSent(true);
      setNote({ tone: "info", text: "Check your email for the 6-digit reset code." });
    } catch (error) {
      setNote({ tone: "error", text: errorText(error, "Unable to send the reset code") });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setNote(null);
    try {
      await sendRuntimeCommand({ type: "runtime:reset-account", code: Number(code) });
      setOpen(false);
      setCodeSent(false);
      setCode("");
      await onReset();
    } catch (error) {
      setNote({ tone: "error", text: errorText(error, "Unable to reset the account") });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <UiButton tone="ghost" className="w-full text-xs" onClick={() => setOpen(true)}>
        Lost your root device or recovery credential?
      </UiButton>
    );
  }
  return (
    <Card tone="danger">
      <CardTitle>Reset account</CardTitle>
      <Muted className="mt-1">
        Prefer recovery if you still have your credential. A reset removes every device and makes this one the new
        root; the others must be set up and paired again.
      </Muted>
      {codeSent ? (
        <>
          <TextInput
            className="mt-3 font-mono text-base tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            aria-label="Account reset code"
          />
          <UiButton tone="danger" className="mt-3 w-full" disabled={busy || code.length !== 6} onClick={() => void reset()}>
            {busy ? "Resetting…" : "Reset and remove all devices"}
          </UiButton>
        </>
      ) : (
        <UiButton tone="danger-outline" className="mt-3 w-full" disabled={busy} onClick={() => void requestCode()}>
          {busy ? "Sending code…" : "Email me a reset code"}
        </UiButton>
      )}
      {note ? <div className="mt-2"><Alert tone={note.tone}>{note.text}</Alert></div> : null}
      <UiButton
        tone="ghost"
        className="mt-1 w-full"
        onClick={() => {
          setOpen(false);
          setCodeSent(false);
          setCode("");
          setNote(null);
        }}
      >
        Cancel
      </UiButton>
    </Card>
  );
}

// ---- Devices -----------------------------------------------------------

function platformLabel(platform: string): string {
  return platform === "android" ? "Android" : platform === "chrome" ? "Chrome" : platform;
}

/**
 * Lists the account's devices and lets this trusted device remove others.
 * Removal is signed by this device; the server rejects unsigned requests.
 */
function DeviceManager() {
  const [devices, setDevices] = useState<ManagedDevice[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setDevices(await sendRuntimeCommand<ManagedDevice[]>({ type: "runtime:list-devices" }));
    } catch (loadError) {
      setError(errorText(loadError, "Unable to load devices"));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async (device: ManagedDevice) => {
    const confirmed = window.confirm(
      device.root
        ? `"${device.name}" is your account root. Remove it only if it's lost or you no longer use it.\n\n` +
            "Your other devices keep syncing, but no new device can be paired until one of them becomes " +
            "the root using your offline recovery credential. Remove it?"
        : `Remove "${device.name}"? It stops syncing immediately and can't be re-added without signing in and pairing again.`,
    );
    if (!confirmed) return;
    setBusyId(device.deviceId);
    setError(null);
    try {
      setDevices(
        await sendRuntimeCommand<ManagedDevice[]>({
          type: "runtime:revoke-device",
          deviceId: device.deviceId,
        }),
      );
    } catch (removeError) {
      setError(errorText(removeError, "Unable to remove device"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardTitle>Your devices</CardTitle>
      {devices === null && !error ? <Muted className="mt-2">Loading…</Muted> : null}
      <ul className="mt-2 divide-y divide-line">
        {devices?.map((device) => (
          <li key={device.deviceId} className="flex items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="font-sora flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-soft text-xs font-bold text-primary">
                {device.platform === "android" ? "AND" : "WEB"}
              </span>
              <div className="min-w-0">
                <p className="font-work truncate text-sm font-semibold text-ink">{device.name}</p>
                <p className="font-work text-xs text-muted">
                  {[
                    platformLabel(device.platform),
                    device.current ? "This device" : null,
                    device.root ? "Root" : null,
                    device.state === "pending" ? "Waiting for approval" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
            {device.current ? null : (
              <UiButton
                tone="danger-outline"
                className="shrink-0 !px-2.5 !py-1 text-xs"
                disabled={busyId !== null}
                onClick={() => void remove(device)}
              >
                {busyId === device.deviceId ? "Removing…" : "Remove"}
              </UiButton>
            )}
          </li>
        ))}
      </ul>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Card>
  );
}

const HomeWithAuth = withAuth(Home);

export default HomeWithAuth;
