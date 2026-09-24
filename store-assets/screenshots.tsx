/* eslint-disable react-refresh/only-export-components -- standalone capture page, not hot-reloaded UI */
/**
 * Chrome Web Store screenshots (1280x800). Popups are composed from the real
 * popup components and theme so they match the shipped UI. Open
 * screenshots.html?shot=1..5 in the dev server, or run capture.mjs.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import Logo from "@/vectors/logo";
import CloseIcon from "@/vectors/close";
import { Alert, Card, CardTitle, Fingerprint, Muted, StatusPill, TextInput, UiButton } from "@/components/ui";

const FINGERPRINT = "7F3A-91C2-04BE-D85F-2A6E-C13B";

// ---- Popup pieces (mirroring src/views/home) ----------------------------

function Popup({
  pill,
  children,
  className = "",
}: {
  pill: { tone: "ok" | "wait"; label: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`relative w-[430px] rounded-2xl border border-line bg-surface p-6 pt-10 text-ink shadow-[0_24px_70px_rgba(15,52,73,0.22)] ${className}`}>
      <CloseIcon className="absolute top-2 right-2 text-muted" />
      <header className="flex items-center justify-between gap-3">
        <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
          <Logo /> Copyyt
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          <div className="font-sora flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary">
            A
          </div>
        </div>
      </header>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

const CONNECTED = { tone: "ok", label: "Connected" } as const;

function Tabs({ active }: { active: "Home" | "Devices" | "Settings" }) {
  return (
    <nav className="grid grid-cols-3 gap-1 rounded-xl bg-soft p-1">
      {(["Home", "Devices", "Settings"] as const).map((label) => (
        <span
          key={label}
          className={`font-work rounded-lg py-1.5 text-center text-sm font-semibold ${
            active === label ? "bg-surface text-ink shadow-sm" : "text-muted"
          }`}
        >
          {label}
        </span>
      ))}
    </nav>
  );
}

const modes = [
  { id: "both", label: "Send & receive", help: "Copies here reach your devices, and theirs land here." },
  { id: "send-only", label: "Send only", help: "Copies here reach your devices; nothing arrives here." },
  { id: "receive-only", label: "Receive only", help: "Copies from your devices land here; nothing is sent." },
  { id: "off", label: "Paused", help: "Nothing is sent or received on this device." },
];

function SyncCard({ mode = "both" }: { mode?: string }) {
  return (
    <Card>
      <CardTitle>Clipboard sync</CardTitle>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {modes.map((item) => (
          <span
            key={item.id}
            className={`font-work rounded-lg border px-2 py-2 text-center text-xs font-semibold ${
              mode === item.id ? "border-primary bg-soft text-ink" : "border-line bg-surface text-muted"
            }`}
          >
            {item.label}
          </span>
        ))}
      </div>
      <Muted className="mt-2">{modes.find((item) => item.id === mode)?.help}</Muted>
    </Card>
  );
}

function SendButton() {
  return (
    <>
      <UiButton size="lg" className="w-full">
        Send current clipboard
      </UiButton>
      <Muted className="text-center">Copies are sent automatically. Use this to resend what&apos;s on your clipboard.</Muted>
    </>
  );
}

function DeviceList() {
  const devices = [
    { name: "Work MacBook", meta: "Chrome · Root" },
    { name: "Home PC", meta: "Chrome · This device", current: true },
    { name: "Studio Chromebook", meta: "Chrome" },
  ];
  return (
    <Card>
      <CardTitle>Your devices</CardTitle>
      <ul className="mt-2 divide-y divide-line">
        {devices.map((device) => (
          <li key={device.name} className="flex items-center justify-between gap-3 py-2.5">
            <div className="flex items-center gap-3">
              <span className="font-sora flex h-9 w-9 items-center justify-center rounded-xl bg-soft text-xs font-bold text-primary">
                WEB
              </span>
              <div>
                <p className="font-work text-sm font-semibold text-ink">{device.name}</p>
                <p className="font-work text-xs text-muted">{device.meta}</p>
              </div>
            </div>
            {device.current ? null : (
              <UiButton tone="danger-outline" className="!px-2.5 !py-1 text-xs">
                Remove
              </UiButton>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- Scene framing -------------------------------------------------------

function Browser({ children, url = "docs.example.com/q3-plan" }: { children: React.ReactNode; url?: string }) {
  return (
    <div className="relative h-[660px] w-[680px] overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_18px_60px_rgba(15,52,73,0.12)]">
      <div className="flex items-center gap-3 border-b border-line bg-page px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#ff6159]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c941]" />
        </div>
        <div className="font-work flex-1 rounded-full bg-surface px-4 py-1.5 text-sm text-muted">{url}</div>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-soft">
          <Logo width={20} height={20} />
        </span>
      </div>
      <div className="space-y-4 p-8 opacity-60">
        <div className="h-6 w-2/3 rounded bg-line" />
        {[92, 84, 88, 70, 90, 60, 86, 78, 82, 64].map((width, index) => (
          <div key={index} className="h-3 rounded bg-line/70" style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="absolute top-[58px] right-4">{children}</div>
    </div>
  );
}

function Scene({
  eyebrow,
  title,
  body,
  points,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  body: string;
  points?: string[];
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex h-[800px] w-[1280px] items-center gap-12 overflow-hidden bg-page px-16">
      <div className="absolute -top-40 -right-40 h-[620px] w-[620px] rounded-full bg-soft blur-3xl" />
      <div className="relative w-[460px] shrink-0">
        <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
          <Logo /> Copyyt
        </div>
        <p className="font-work mt-10 text-sm font-semibold tracking-[0.18em] text-brand uppercase">{eyebrow}</p>
        <h1 className="font-sora mt-3 text-[42px] leading-[1.12] font-bold tracking-tight text-ink">{title}</h1>
        <p className="font-work mt-5 text-lg leading-8 text-muted">{body}</p>
        {points ? (
          <ul className="font-work mt-6 space-y-3 text-base text-ink">
            {points.map((point) => (
              <li key={point} className="flex items-start gap-3">
                <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-xs font-bold text-on-success-soft">
                  ✓
                </span>
                {point}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="relative flex flex-1 justify-center">{children}</div>
    </main>
  );
}

// ---- Shots -------------------------------------------------------------

function ShotHero() {
  return (
    <Scene
      eyebrow="Clipboard sync for Chrome"
      title={
        <>
          Copy on one device.
          <br />
          <span className="text-primary">Paste on another.</span>
        </>
      }
      body="Copyyt keeps your clipboard in sync across the computers you trust. Just copy as usual; it's ready to paste on your other devices."
      points={["Works in the background", "End-to-end encrypted", "Text, rich text and images"]}
    >
      <Browser>
        <Popup pill={CONNECTED}>
          <Tabs active="Home" />
          <div className="mt-4 space-y-3">
            <SyncCard />
            <SendButton />
          </div>
        </Popup>
      </Browser>
    </Scene>
  );
}

function ShotSecurity() {
  return (
    <Scene
      eyebrow="Private by design"
      title="Only your devices can read your clipboard"
      body="Everything is encrypted on your device before it leaves. The Copyyt server relays data it cannot decrypt."
      points={[
        "Private keys never leave your device",
        "Items expire from the relay in 60 seconds",
        "No clipboard history, ads or tracking",
      ]}
    >
      <Browser>
        <Popup pill={CONNECTED}>
          <Tabs active="Settings" />
          <div className="mt-4 space-y-3">
            <Card>
              <CardTitle>Account</CardTitle>
              <Muted className="mt-1">Ada Obi · ada@example.com</Muted>
              <Muted className="mt-1">
                This device is your account root. Clipboard content is end-to-end encrypted; the server never sees it.
              </Muted>
            </Card>
            <Card>
              <CardTitle>Recovery credential</CardTitle>
              <Muted className="mt-1">
                Saved on 24/09/2026 and removed from this device. Keep your offline copy safe.
              </Muted>
            </Card>
            <UiButton tone="ghost" className="w-full text-xs">
              Lost your root device or recovery credential?
            </UiButton>
            <UiButton tone="danger-outline" className="w-full">
              Sign out
            </UiButton>
          </div>
        </Popup>
      </Browser>
    </Scene>
  );
}

function ShotPairing() {
  return (
    <main className="relative flex h-[800px] w-[1280px] flex-col items-center overflow-hidden bg-page px-16 pt-14">
      <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-soft blur-3xl" />
      <div className="relative text-center">
        <p className="font-work text-sm font-semibold tracking-[0.18em] text-brand uppercase">Trusted pairing</p>
        <h1 className="font-sora mt-3 text-[42px] leading-tight font-bold tracking-tight text-ink">
          Add a device by matching a code
        </h1>
        <p className="font-work mx-auto mt-3 max-w-2xl text-lg leading-8 text-muted">
          A new device joins only after you approve it on a device you already trust, so no one else can slip in.
        </p>
      </div>
      <div className="relative mt-10 flex items-start gap-10">
        <div>
          <p className="font-work mb-3 text-center text-sm font-semibold text-muted">New laptop</p>
          <Popup pill={{ tone: "wait", label: "Needs pairing" }}>
            <Card>
              <p className="font-sora text-lg font-bold text-ink">Pair this device</p>
              <Muted className="mt-2">
                Now approve this device on your root device: open Copyyt there, go to Devices, and type this code.
              </Muted>
              <div className="mt-3">
                <Fingerprint value={FINGERPRINT} />
              </div>
              <Muted className="mt-3 text-center">Waiting for approval… this updates by itself.</Muted>
            </Card>
          </Popup>
        </div>
        <div className="font-sora mt-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-xl text-on-primary shadow-copyt">
          →
        </div>
        <div>
          <p className="font-work mb-3 text-center text-sm font-semibold text-muted">Your root device</p>
          <Popup pill={CONNECTED}>
            <Tabs active="Devices" />
            <Card tone="accent">
              <CardTitle>Approve New laptop</CardTitle>
              <Muted className="mt-1">
                That device shows the code below. Check they match, then type the code from that device to approve it.
              </Muted>
              <div className="mt-2">
                <Fingerprint value={FINGERPRINT} />
              </div>
              <TextInput className="mt-3 font-mono uppercase" readOnly value={FINGERPRINT} aria-label="Pairing code" />
              <UiButton className="mt-3 w-full">Approve device</UiButton>
            </Card>
          </Popup>
        </div>
      </div>
    </main>
  );
}

function ShotImages() {
  return (
    <Scene
      eyebrow="More than plain text"
      title="Text, formatting and images"
      body="Copy a link, a formatted paragraph or a screenshot. Text lands on your clipboard automatically; images are one click away."
      points={["Keeps bold, lists and links", "Images arrive ready to copy", "Larger items go direct on the same network"]}
    >
      <Browser url="mail.example.com/compose">
        <Popup pill={CONNECTED}>
          <Tabs active="Home" />
          <div className="mt-4 space-y-3">
            <Card tone="accent">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>Image from Work MacBook</CardTitle>
                  <Muted>Available until 3:42:10 PM</Muted>
                </div>
                <UiButton>Copy image</UiButton>
              </div>
            </Card>
            <SyncCard />
            <SendButton />
            <Alert tone="success">Image copied. Paste it anywhere.</Alert>
          </div>
        </Popup>
      </Browser>
    </Scene>
  );
}

function ShotDevices() {
  return (
    <Scene
      eyebrow="You are in control"
      title="Every device, your rules"
      body="See every device on your account, remove one in a click, and choose how each device takes part."
      points={["Send & receive, send only, receive only or paused", "Remove lost devices instantly", "Recover your account with an offline credential"]}
    >
      <Browser url="notes.example.com/today">
        <Popup pill={CONNECTED}>
          <Tabs active="Devices" />
          <div className="mt-4 space-y-3">
            <UiButton tone="secondary" className="w-full">
              Check for new devices
            </UiButton>
            <DeviceList />
            <Muted className="text-center">
              To add a device, install Copyyt on it and sign in with the same account, then check for new devices here.
            </Muted>
          </div>
        </Popup>
      </Browser>
    </Scene>
  );
}

// ---- Promo tiles -------------------------------------------------------

function TileSmall() {
  return (
    <main className="relative flex h-[280px] w-[440px] flex-col justify-center overflow-hidden bg-page px-9">
      <div className="absolute -top-24 -right-24 h-[280px] w-[280px] rounded-full bg-soft blur-2xl" />
      <div className="relative">
        <div className="font-sora flex items-center gap-2.5 text-2xl font-bold text-ink">
          <Logo width={40} height={40} /> Copyyt
        </div>
        <h1 className="font-sora mt-5 text-[30px] leading-[1.15] font-bold tracking-tight text-ink">
          Copy on one device.
          <br />
          <span className="text-primary">Paste on another.</span>
        </h1>
        <p className="font-work mt-3 text-sm font-semibold text-muted">End-to-end encrypted clipboard sync</p>
      </div>
    </main>
  );
}

function TileMarquee() {
  return (
    <main className="relative flex h-[560px] w-[1400px] items-center gap-16 overflow-hidden bg-page pr-20 pl-24">
      <div className="absolute -top-48 -right-32 h-[720px] w-[720px] rounded-full bg-soft blur-3xl" />
      <div className="relative w-[600px] shrink-0">
        <div className="font-sora flex items-center gap-3 text-3xl font-bold text-ink">
          <Logo width={48} height={48} /> Copyyt
        </div>
        <h1 className="font-sora mt-8 text-[56px] leading-[1.08] font-bold tracking-tight text-ink">
          Copy on one device.
          <br />
          <span className="text-primary">Paste on another.</span>
        </h1>
        <p className="font-work mt-6 text-xl leading-8 text-muted">
          End-to-end encrypted clipboard sync between the computers you trust. Text, rich text and images.
        </p>
      </div>
      <div className="relative flex flex-1 justify-center">
        <Popup pill={CONNECTED}>
          <Tabs active="Home" />
          <div className="mt-4 space-y-3">
            <SyncCard />
            <UiButton size="lg" className="w-full">
              Send current clipboard
            </UiButton>
          </div>
        </Popup>
      </div>
    </main>
  );
}

const shots = [ShotHero, ShotSecurity, ShotPairing, ShotImages, ShotDevices, TileSmall, TileMarquee];
const index = Math.min(Math.max(Number(new URLSearchParams(location.search).get("shot") ?? "1"), 1), shots.length) - 1;
const Shot = shots[index];

document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<Shot />);
