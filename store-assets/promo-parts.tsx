/* eslint-disable react-refresh/only-export-components -- shared by standalone capture pages */
/**
 * Pieces shared by the promo videos: timing helpers, the extension popup built
 * from the real UI components, a pointer, and the seek/playback harness that
 * capture-video.mjs drives.
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Logo from "@/vectors/logo";
import CloseIcon from "@/vectors/close";
import { Card, CardTitle, Muted, StatusPill } from "@/components/ui";

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
export const typed = (text: string, t: number, start: number, cps = 28) =>
  text.slice(0, Math.max(0, Math.floor((t - start) * cps)));
export const blink = (t: number) => (Math.floor(t * 2) % 2 === 0 ? 1 : 0);

export function Cursor({ x, y, click = 0 }: { x: number; y: number; click?: number }) {
  // click: 0..1 progress of a click ripple
  return (
    <div className="absolute z-50" style={{ left: x, top: y, pointerEvents: "none" }}>
      {click > 0 && click < 1 ? (
        <span
          className="absolute rounded-full border-2 border-brand"
          style={{
            left: -22 * (0.4 + click),
            top: -22 * (0.4 + click),
            width: 44 * (0.4 + click),
            height: 44 * (0.4 + click),
            opacity: 1 - click,
          }}
        />
      ) : null}
      <svg width="28" height="34" viewBox="0 0 28 34" style={{ transform: `scale(${click > 0 && click < 0.3 ? 0.88 : 1})` }}>
        <path d="M2 2 L2 27 L8.5 21 L13 31.5 L17.5 29.5 L13 19.5 L22 19.5 Z" fill="#0f3449" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ---- Extension popup (mirrors store-assets/screenshots.tsx) -----------------

export function Popup({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      className="relative w-[430px] rounded-2xl border border-line bg-surface p-6 pt-10 text-ink shadow-[0_24px_70px_rgba(15,52,73,0.22)]"
      style={style}
    >
      <CloseIcon className="absolute top-2 right-2 text-muted" />
      <header className="flex items-center justify-between gap-3">
        <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
          <Logo /> Copyyt
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone="ok">Connected</StatusPill>
          <div className="font-sora flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary">
            A
          </div>
        </div>
      </header>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export function Tabs({ active }: { active: "Home" | "Devices" | "Settings" }) {
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

export const MODES = [
  { id: "both", label: "Send & receive", help: "Copies here reach your devices, and theirs land here." },
  { id: "send-only", label: "Send only", help: "Copies here reach your devices; nothing arrives here." },
  { id: "receive-only", label: "Receive only", help: "Copies from your devices land here; nothing is sent." },
  { id: "off", label: "Paused", help: "Nothing is sent or received on this device." },
];

export function SyncCard({ mode }: { mode: string }) {
  return (
    <Card>
      <CardTitle>Clipboard sync</CardTitle>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {MODES.map((item) => (
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
      <Muted className="mt-2">{MODES.find((item) => item.id === mode)?.help}</Muted>
    </Card>
  );
}

// ---- Browser window, Android phone and app screens ------------------------------

export function BrowserWindow({
  url,
  children,
  iconPulse = 0,
  width = 1120,
  height = 690,
}: {
  url: string;
  children: React.ReactNode;
  iconPulse?: number;
  width?: number;
  height?: number;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(15,52,73,0.16)]"
      style={{ width, height }}
    >
      <div className="flex items-center gap-4 border-b border-line bg-page px-5 py-3.5">
        <div className="flex gap-2">
          <span className="h-3.5 w-3.5 rounded-full bg-[#ff6159]" />
          <span className="h-3.5 w-3.5 rounded-full bg-[#ffbd2e]" />
          <span className="h-3.5 w-3.5 rounded-full bg-[#28c941]" />
        </div>
        <div className="font-work flex-1 rounded-full bg-surface px-5 py-2 text-base text-muted">{url}</div>
        <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-soft">
          {iconPulse > 0 && iconPulse < 1 ? (
            <span
              className="absolute rounded-xl border-2 border-brand"
              style={{ inset: -10 * iconPulse, opacity: 1 - iconPulse }}
            />
          ) : null}
          <Logo width={24} height={24} />
        </span>
      </div>
      <div className="relative h-full">{children}</div>
    </div>
  );
}

// ---- Android phone (mirrors the Compose UI in the Play screenshots) ---------

export function Phone({ children, scale = 1 }: { children: React.ReactNode; scale?: number }) {
  return (
    <div style={{ width: 414 * scale, height: 868 * scale }}>
      <div
        className="relative overflow-hidden rounded-[58px] bg-[#10212b] p-3 shadow-[0_30px_80px_rgba(15,52,73,0.25)]"
        style={{ width: 414, height: 868, transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        <div className="relative h-full w-full overflow-hidden rounded-[46px] bg-[#f5f3ef]">
          <div className="font-work flex items-center justify-between px-7 pt-4 pb-2 text-[15px] text-[#0f3449]">
            <span>9:41</span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rotate-45 bg-[#0f3449]" style={{ clipPath: "polygon(0 0,100% 0,0 100%)" }} />
              <span className="h-3 w-3 rotate-45 bg-[#0f3449]" style={{ clipPath: "polygon(0 0,100% 0,0 100%)" }} />
              <span className="h-3.5 w-2 rounded-sm bg-[#0f3449]" />
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Notification({ t, at, title, body }: { t: number; at: number; title: string; body: string }) {
  const inP = easeOut(prog(t, at, at + 0.45));
  const outP = easeInOut(prog(t, at + 2.2, at + 2.6));
  const y = lerp(-140, 14, inP) - outP * 160;
  return (
    <div
      className="absolute right-3 left-3 z-30 flex items-start gap-3 rounded-3xl bg-white p-4 shadow-[0_12px_30px_rgba(15,52,73,0.18)]"
      style={{ top: y, opacity: inP }}
    >
      <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-soft">
        <Logo width={22} height={22} />
      </span>
      <div className="font-work min-w-0 flex-1">
        <p className="text-[13px] text-muted">Copyyt · now</p>
        <p className="text-[16px] font-semibold text-ink">{title}</p>
        <p className="text-[14px] text-muted">{body}</p>
      </div>
    </div>
  );
}

export function DocLines({ widths }: { widths: number[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <div key={i} className="mb-4 h-3.5 rounded bg-line/70" style={{ width: `${w}%` }} />
      ))}
    </>
  );
}

export function AppHome({ t, tapAt }: { t: number; tapAt: number }) {
  const sending = t >= tapAt && t < tapAt + 0.7;
  const sent = t >= tapAt + 0.7;
  const snack = easeOut(prog(t, tapAt + 0.7, tapAt + 1.0)) * (1 - prog(t, tapAt + 3.2, tapAt + 3.5));
  const ripple = t >= tapAt && t < tapAt + 0.5 ? prog(t, tapAt, tapAt + 0.5) : 0;
  return (
    <div className="font-work relative h-full px-6 pt-4 text-[#0f3449]">
      <div className="flex items-center justify-between">
        <div className="font-sora flex items-center gap-2 text-[22px] font-semibold">
          <Logo width={28} height={28} /> Copyyt
        </div>
        <span className="text-2xl text-muted">↻</span>
      </div>
      <p className="mt-7 flex items-center gap-2 text-[15px] text-success">
        <span className="h-2.5 w-2.5 rounded-full bg-success" /> Connected
      </p>
      <p className="font-sora mt-3 text-[28px] leading-tight font-semibold">Copy here, paste anywhere</p>
      <p className="mt-3 text-[16px] leading-6 text-muted">What you copy on your other devices lands on this phone&apos;s clipboard automatically.</p>
      <div className="mt-5 rounded-2xl border border-line bg-white p-4">
        <p className="font-sora text-[18px] font-semibold">On this phone</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[16px] font-semibold">
          <span className="rounded-xl border border-primary bg-soft py-2.5">Receive</span>
          <span className="rounded-xl border border-line py-2.5 text-muted">Paused</span>
        </div>
      </div>
      <div className="my-6 h-px bg-line" />
      <p className="font-sora text-[20px] font-semibold">Send to your devices</p>
      <p className="mt-2 text-[14px] leading-5 text-muted">Android only lets apps read the clipboard while they&apos;re open, so sending is a tap away.</p>
      <div className="relative mt-4 overflow-hidden rounded-2xl bg-primary py-4 text-center text-[18px] font-semibold text-on-primary">
        {ripple > 0 ? (
          <span
            className="absolute rounded-full bg-white/30"
            style={{ left: `calc(50% - ${ripple * 220}px)`, top: -ripple * 200 + 28, width: ripple * 440, height: ripple * 440, opacity: 1 - ripple }}
          />
        ) : null}
        <span className="relative">{sending ? "Sending…" : "➤  Send my clipboard"}</span>
      </div>
      <p className="mt-3 text-[14px] leading-5 text-muted">Also: Share → Copyyt from any app, or add the “Send clipboard” quick-settings tile.</p>
      <div
        className="absolute right-4 bottom-8 left-4 rounded-xl bg-[#2b3a42] px-5 py-4 text-[16px] text-white"
        style={{ opacity: snack, transform: `translateY(${(1 - snack) * 20}px)` }}
      >
        {sent ? "Sent to 2 device(s)" : ""}
      </div>
    </div>
  );
}

/** The real popup, enlarged so it reads on a phone screen, floating over the browser. */
export function ZoomedPopup({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute top-[-40px] right-[-60px]" style={{ transform: "scale(1.45)", transformOrigin: "top right" }}>
      <div className="relative">{children}</div>
    </div>
  );
}

// ---- Playback / capture harness -----------------------------------------------

declare global {
  interface Window {
    __seek?: (t: number) => Promise<boolean>;
    __duration?: number;
  }
}

function Player({ Frame, duration }: { Frame: React.FC<{ t: number }>; duration: number }) {
  const params = new URLSearchParams(location.search);
  const fixed = params.get("t");
  const capture = params.has("capture");
  const [t, setT] = useState(fixed ? Number(fixed) : 0);

  useEffect(() => {
    window.__duration = duration;
    window.__seek = async (next: number) => {
      await document.fonts.ready;
      flushSync(() => setT(next));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    };
    if (fixed || capture) return;
    let raf = 0;
    const began = performance.now();
    const tick = (now: number) => {
      setT(((now - began) / 1000) % duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fixed, capture, duration]);

  return <Frame t={t} />;
}

/** Mounts a video whose frames are a pure function of time. */
export function mountVideo(Frame: React.FC<{ t: number }>, duration: number) {
  document.body.style.margin = "0";
  createRoot(document.getElementById("root")!).render(<Player Frame={Frame} duration={duration} />);
}
