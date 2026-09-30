/* eslint-disable react-refresh/only-export-components -- standalone capture page, not hot-reloaded UI */
/**
 * "Device lineup" promo (1920x1080, Harbor Dark). Two laptops and an Android
 * phone stay on stage the whole time while a camera moves between them;
 * copied items fly across as cards that are scrambled while in transit.
 * Capture with: capture-video.mjs <build>/promo-lineup.html out.mp4 --scheme dark
 */
import React from "react";
import "@/index.css";
import Logo from "@/vectors/logo";
import { Alert, Card, CardTitle, Muted, UiButton } from "@/components/ui";
import { Cursor, Popup, SyncCard, Tabs, blink, clamp, easeInOut, easeOut, lerp, mountVideo, prog } from "./promo-parts";

const DURATION = 40;
const VIEW_W = 1920;
const VIEW_H = 860; // stage above the caption strip

// ---- World layout (stage coordinates before the camera) -----------------------

const MAC = { x: 110, y: 190, w: 620, h: 388 }; // laptop screens
const PC = { x: 810, y: 190, w: 620, h: 388 };
const PHONE = { x: 1540, y: 150, w: 280, h: 580 };
const RELAY = { x: 810, y: 8, w: 300, h: 96 };

const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Camera keyframes: [time, world x, world y, zoom]
const SHOTS: [number, number, number, number][] = [
  [0, 965, 440, 1.08],
  [7.0, 965, 440, 1.08],
  [8.0, 420, 400, 1.75],
  [9.9, 420, 400, 1.75],
  [10.7, 960, 400, 0.98],
  [11.1, 960, 400, 0.98],
  [11.9, 1120, 400, 1.75],
  [13.4, 1120, 400, 1.75],
  [14.3, 1680, 440, 1.4],
  [19.4, 1680, 440, 1.4],
  [20.2, 960, 430, 1],
  [21.8, 960, 430, 1],
  [22.6, 420, 400, 1.75],
  [24.3, 420, 400, 1.75],
  [25.1, 960, 380, 0.9],
  [30.8, 960, 380, 0.9],
  [31.6, 1680, 440, 1.4],
  [34.6, 1680, 440, 1.4],
  [35.4, 960, 430, 1],
];

function camera(t: number) {
  let i = 0;
  while (i < SHOTS.length - 1 && t >= SHOTS[i + 1][0]) i++;
  const a = SHOTS[i];
  const b = SHOTS[Math.min(i + 1, SHOTS.length - 1)];
  const x = b === a ? 1 : easeInOut(prog(t, a[0], b[0]));
  return { cx: lerp(a[1], b[1], x), cy: lerp(a[2], b[2], x), zoom: lerp(a[3], b[3], x) };
}

// ---- Timeline ----------------------------------------------------------------------

const SNIPPET = "Hotel Lumen, 22 Harbour Rd";
const AT = {
  select: 8.4,
  copy: 9.6,
  launch: 9.8,
  land: 11.3,
  phonePress: 15.4,
  phonePaste: 16.3,
  appOpen: 18.6,
  send: 19.8,
  imgLaunch: 20.1,
  imgLand: 21.7,
  copyImage: 23.4,
  relayLaunch: 25.6,
  relayIn: 27.2,
  relayOut: 28.9,
  relayLand: 30.3,
  pause: 32.3,
  outro: 35.4,
};

const CAPTIONS: [number, string][] = [
  [0.6, "Two laptops. One Android phone."],
  [3.3, "Apple devices share one clipboard."],
  [5.2, "Now yours can too."],
  [7.3, "Copy on one laptop…"],
  [11.2, "…and it's already on the other."],
  [13.6, "Your phone gets it too. Just paste."],
  [18.6, "Send from your phone. Images too."],
  [24.8, "Locked on your device before it leaves."],
  [27.9, "In between, it's just gibberish."],
  [31.1, "Pause any device, whenever you like."],
  [AT.outro, ""],
];

// ---- Scramble ----------------------------------------------------------------------

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&@*+=/";
function scramble(text: string, t: number, amount: number) {
  const tick = Math.floor(t * 24);
  return text
    .split("")
    .map((ch, i) => {
      if (ch === " ") return ch;
      const threshold = ((i * 37) % 100) / 100;
      return amount > threshold ? GLYPHS[(i * 31 + tick * 17) % GLYPHS.length] : ch;
    })
    .join("");
}

// ---- Devices -------------------------------------------------------------------------

function Reveal({ t, at, children }: { t: number; at: number; children: React.ReactNode }) {
  const p = easeOut(prog(t, at, at + 0.9));
  return <div style={{ clipPath: `inset(${(1 - p) * 100}% 0 0 0)`, opacity: prog(t, at, at + 0.3) }}>{children}</div>;
}

function Label({ name, dim = false }: { name: string; dim?: boolean }) {
  return (
    <div className="font-work mt-4 flex items-center justify-center gap-2.5 text-[22px] font-semibold text-muted">
      <span className={`h-2.5 w-2.5 rounded-full ${dim ? "bg-muted" : "bg-success"}`} />
      {name}
    </div>
  );
}

function Laptop({ box, name, t, at, children }: { box: typeof MAC; name: string; t: number; at: number; children: React.ReactNode }) {
  return (
    <div className="absolute" style={{ left: box.x - 30, top: box.y }}>
      <Reveal t={t} at={at}>
        <div className="flex flex-col items-center" style={{ width: box.w + 60 }}>
          <div className="relative overflow-hidden rounded-t-[22px] border-[12px] border-b-[14px] border-[#1c2f3b] bg-page" style={{ width: box.w + 24, height: box.h + 26 }}>
            {children}
          </div>
          <div className="h-[20px] w-full rounded-b-[18px] bg-[#2a3f4c]">
            <div className="mx-auto h-[7px] w-[110px] rounded-b-lg bg-[#1c2f3b]" />
          </div>
          <Label name={name} />
        </div>
      </Reveal>
    </div>
  );
}

function PhoneBody({ t, at, dim, children }: { t: number; at: number; dim: boolean; children: React.ReactNode }) {
  return (
    <div className="absolute" style={{ left: PHONE.x, top: PHONE.y }}>
      <Reveal t={t} at={at}>
        <div className="relative overflow-hidden rounded-[44px] border-[10px] border-[#1c2f3b] bg-page" style={{ width: PHONE.w, height: PHONE.h }}>
          <div className="font-work flex justify-between px-6 pt-3 text-[12px] text-ink">
            <span>9:41</span>
            <span>▾ ▮</span>
          </div>
          {children}
        </div>
        <Label name="Android phone" dim={dim} />
      </Reveal>
    </div>
  );
}

function BrowserBar({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff6159]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c941]" />
      </div>
      <div className="font-work flex-1 rounded-full bg-page px-3 py-1 text-[13px] text-muted">{url}</div>
      <Logo width={18} height={18} />
    </div>
  );
}

function Lines({ widths }: { widths: number[] }) {
  return (
    <div className="mt-5 space-y-3">
      {widths.map((w, i) => (
        <div key={i} className="h-2.5 rounded bg-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function MacScreen({ t }: { t: number }) {
  const sel = easeInOut(prog(t, AT.select, AT.select + 0.8));
  const chars = Math.round(SNIPPET.length * sel);
  const keys = t >= AT.copy - 0.2 && t < AT.copy + 0.9;
  const popupIn = easeOut(prog(t, AT.imgLand + 0.2, AT.imgLand + 0.6));
  const copied = t >= AT.copyImage + 0.1;
  const cx = lerp(250, 345, easeInOut(prog(t, 22.6, AT.copyImage - 0.1)));
  const cy = lerp(300, 160, easeInOut(prog(t, 22.6, AT.copyImage - 0.1)));
  return (
    <>
      <BrowserBar url="docs.example.com/weekend-trip" />
      <div className="font-work p-7 text-ink">
        <p className="font-sora text-[24px] font-bold">Weekend trip</p>
        <p className="mt-4 text-[20px]">
          Stay: <span className="bg-selection text-on-selection">{SNIPPET.slice(0, chars)}</span>
          {SNIPPET.slice(chars)}
        </p>
        <Lines widths={[88, 72, 80, 54]} />
      </div>
      {keys ? (
        <div className="font-sora absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-2 text-[18px] font-semibold">
          {["⌘", "C"].map((k) => (
            <span key={k} className={`rounded-lg border px-3 py-1.5 ${t >= AT.copy && t < AT.copy + 0.3 ? "border-brand bg-brand text-page" : "border-line bg-surface text-ink"}`}>
              {k}
            </span>
          ))}
        </div>
      ) : null}
      {popupIn > 0 ? (
        <div className="absolute top-2 right-2" style={{ opacity: popupIn, transform: `scale(${0.78 * lerp(0.94, 1, popupIn)})`, transformOrigin: "top right" }}>
          <div className="relative">
            <Popup>
              <Tabs active="Home" />
              <Card tone="accent">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Image from Android phone</CardTitle>
                    <Muted>Available until 6:42:10 PM</Muted>
                  </div>
                  <UiButton>Copy image</UiButton>
                </div>
              </Card>
              {copied ? <Alert tone="success">Image copied. Paste it anywhere.</Alert> : <SyncCard mode="both" />}
            </Popup>
            {t >= 22.6 && t < 24.6 ? <Cursor x={cx} y={cy} click={t >= AT.copyImage ? prog(t, AT.copyImage, AT.copyImage + 0.5) : 0} /> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function PcScreen({ t }: { t: number }) {
  const pasted = t >= AT.land + 0.15;
  const flash = 1 - prog(t, AT.land + 0.3, AT.land + 1.4);
  const imageIn = easeOut(prog(t, AT.imgLand + 0.1, AT.imgLand + 0.5));
  return (
    <>
      <BrowserBar url="maps.example.com" />
      <div className="font-work p-7 text-ink">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[20px]">
          <span className="text-muted">⌕</span>
          {pasted ? (
            <span style={{ background: `rgba(45,156,219,${0.45 * flash})` }}>{SNIPPET}</span>
          ) : (
            <span className="text-muted">Search for a place</span>
          )}
          <span className="inline-block h-6 w-[2px] bg-ink" style={{ opacity: pasted ? blink(t) : 0 }} />
        </div>
        <div className="mt-5 h-[190px] rounded-xl bg-soft" style={{ opacity: pasted ? 1 : 0.5 }}>
          {pasted ? (
            <div className="flex h-full items-center justify-center">
              <span className="h-6 w-6 rounded-full border-4 border-brand bg-page" />
            </div>
          ) : null}
        </div>
      </div>
      {imageIn > 0 ? (
        <div
          className="font-work absolute right-4 bottom-4 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[15px] text-ink shadow-copyt"
          style={{ opacity: imageIn * (1 - prog(t, 24.2, 24.6)), transform: `translateY(${(1 - imageIn) * 12}px)` }}
        >
          <Logo width={20} height={20} /> Image from Android phone
        </div>
      ) : null}
    </>
  );
}

function PhoneScreen({ t }: { t: number }) {
  const inApp = t >= AT.appOpen;
  const notif = easeOut(prog(t, AT.land + 0.1, AT.land + 0.5)) * (1 - easeInOut(prog(t, AT.phonePress - 0.6, AT.phonePress - 0.2)));
  const menu = t >= AT.phonePress + 0.4 && t < AT.phonePaste;
  const pasted = t >= AT.phonePaste;
  if (!inApp) {
    return (
      <div className="font-work relative h-full px-5 pt-5 text-ink">
        <div className="absolute right-3 left-3 z-10 rounded-2xl bg-surface p-3 shadow-copyt" style={{ top: lerp(-90, 30, notif), opacity: notif }}>
          <div className="flex items-start gap-2.5">
            <Logo width={20} height={20} />
            <div>
              <p className="text-[11px] text-muted">Copyyt · now</p>
              <p className="text-[13px] font-semibold">Copied from Work MacBook</p>
              <p className="text-[12px] text-muted">{SNIPPET.length} characters are on your clipboard</p>
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-between text-[18px]">
          <span>←</span>
          <span>✓</span>
        </div>
        <p className="mt-4 text-[22px] text-muted">Title</p>
        <div className="relative mt-4 text-[16px] leading-6">
          {pasted ? SNIPPET : <span className="text-muted">Start typing</span>}
          {menu ? (
            <div className="absolute -top-12 left-0 flex gap-4 rounded-xl bg-surface px-4 py-2 text-[14px] shadow-copyt">
              <span className="font-semibold">Paste</span>
              <span>Select all</span>
            </div>
          ) : null}
          {t >= AT.phonePress && t < AT.phonePress + 0.6 ? (
            <span className="absolute -top-2 left-2 h-10 w-10 rounded-full bg-brand/30" style={{ transform: `scale(${0.5 + prog(t, AT.phonePress, AT.phonePress + 0.6)})` }} />
          ) : null}
        </div>
      </div>
    );
  }
  const sending = t >= AT.send && t < AT.send + 0.5;
  const snack = easeOut(prog(t, AT.send + 0.5, AT.send + 0.8)) * (1 - prog(t, AT.send + 2.6, AT.send + 3));
  const paused = t >= AT.pause + 0.1;
  const tapRing = (at: number) => (t >= at && t < at + 0.45 ? prog(t, at, at + 0.45) : 0);
  return (
    <div className="font-work relative h-full px-5 pt-4 text-ink" style={{ opacity: easeOut(prog(t, AT.appOpen, AT.appOpen + 0.4)) }}>
      <div className="font-sora flex items-center gap-2 text-[17px] font-semibold">
        <Logo width={22} height={22} /> Copyyt
      </div>
      <p className={`mt-4 flex items-center gap-1.5 text-[12px] ${paused ? "text-muted" : "text-success"}`}>
        <span className={`h-2 w-2 rounded-full ${paused ? "bg-muted" : "bg-success"}`} /> {paused ? "Paused" : "Connected"}
      </p>
      <p className="font-sora mt-2 text-[20px] leading-tight font-semibold">Copy here, paste anywhere</p>
      <div className="relative mt-4 rounded-xl border border-line bg-surface p-3">
        <p className="font-sora text-[14px] font-semibold">On this phone</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-center text-[13px] font-semibold">
          <span className={`rounded-lg border py-1.5 ${paused ? "border-line text-muted" : "border-primary bg-soft"}`}>Receive</span>
          <span className={`rounded-lg border py-1.5 ${paused ? "border-primary bg-soft" : "border-line text-muted"}`}>Paused</span>
        </div>
        {tapRing(AT.pause) > 0 ? (
          <span className="absolute h-10 w-10 rounded-full bg-brand/40" style={{ right: 50, bottom: 8, opacity: 1 - tapRing(AT.pause) }} />
        ) : null}
      </div>
      <p className="font-sora mt-5 text-[15px] font-semibold">Send to your devices</p>
      <div className="relative mt-2 overflow-hidden rounded-xl bg-primary py-3 text-center text-[14px] font-semibold text-on-primary">
        {tapRing(AT.send) > 0 ? (
          <span className="absolute rounded-full bg-white/30" style={{ left: "50%", top: "50%", width: 300 * tapRing(AT.send), height: 300 * tapRing(AT.send), transform: "translate(-50%,-50%)", opacity: 1 - tapRing(AT.send) }} />
        ) : null}
        <span className="relative">{sending ? "Sending…" : "➤  Send my clipboard"}</span>
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-surface p-2.5">
        <div className="h-12 w-12 rounded-lg" style={{ background: "linear-gradient(135deg,#2d9cdb,#75c7b0)" }} />
        <div className="text-[12px] text-muted">
          On your clipboard
          <br />
          <span className="text-ink">Screenshot · PNG</span>
        </div>
      </div>
      <div className="absolute right-3 bottom-4 left-3 rounded-lg bg-[#e2eef5] px-3 py-2.5 text-[13px] text-[#08141c]" style={{ opacity: snack }}>
        Sent to 2 device(s)
      </div>
    </div>
  );
}

// ---- Packets ---------------------------------------------------------------------------

type Point = { x: number; y: number };

function bezier(a: Point, c: Point, b: Point, p: number): Point {
  const q = 1 - p;
  return { x: q * q * a.x + 2 * q * p * c.x + p * p * b.x, y: q * q * a.y + 2 * q * p * c.y + p * p * b.y };
}

function Packet({ t, from, to, start, end, lift = 220, image = false, via, sealedStart = false, sealedEnd = false }: { t: number; from: Point; to: Point; start: number; end: number; lift?: number; image?: boolean; via?: Point; sealedStart?: boolean; sealedEnd?: boolean }) {
  if (t < start || t > end + 0.35) return null;
  const p = easeInOut(prog(t, start, end));
  const control = via ?? { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift };
  const pos = bezier(from, control, to, p);
  // Scrambled for the middle of the trip, readable only at each end.
  // A leg that starts or ends at the server stays scrambled at that end.
  const amount = clamp(Math.min(sealedStart ? 1 : p / 0.18, sealedEnd ? 1 : (1 - p) / 0.18));
  const pop = easeOut(prog(t, start, start + 0.25)) * (1 - prog(t, end, end + 0.35));
  const text = image ? "Screenshot.png" : SNIPPET;
  return (
    <div
      className="absolute z-20 flex items-center gap-2.5 rounded-2xl border border-brand/60 bg-surface px-4 py-3 whitespace-nowrap shadow-[0_0_40px_rgba(45,156,219,0.35)]"
      style={{ left: pos.x, top: pos.y, transform: `translate(-50%,-50%) scale(${lerp(0.6, 1, pop)})`, opacity: pop }}
    >
      {amount > 0.5 ? <LockGlyph /> : image ? <span className="h-6 w-6 rounded-md" style={{ background: "linear-gradient(135deg,#2d9cdb,#75c7b0)" }} /> : <Logo width={22} height={22} />}
      <span className={`text-[18px] ${amount > 0.05 ? "font-mono text-brand" : "font-work text-ink"}`}>{scramble(text, t, amount)}</span>
    </div>
  );
}

function LockGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#2d9cdb" strokeWidth="2.2" strokeLinecap="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" fill="#2d9cdb" stroke="none" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Relay({ t }: { t: number }) {
  const show = easeOut(prog(t, 25.0, 25.6)) * (1 - prog(t, 31.0, 31.6));
  if (show <= 0) return null;
  const holding = t >= AT.relayIn && t < AT.relayOut;
  const mac = center(MAC);
  const pc = center(PC);
  return (
    <>
      <svg className="absolute inset-0 z-0" width={VIEW_W} height={VIEW_H} style={{ opacity: show * 0.6, overflow: "visible" }}>
        <path d={`M ${mac.x} ${MAC.y} Q ${mac.x} 56 ${RELAY.x} 56`} stroke="#2b4a5c" strokeWidth="3" strokeDasharray="8 10" fill="none" />
        <path d={`M ${RELAY.x + RELAY.w} 56 Q ${pc.x} 56 ${pc.x} ${PC.y}`} stroke="#2b4a5c" strokeWidth="3" strokeDasharray="8 10" fill="none" />
      </svg>
      <div className="absolute z-10 rounded-2xl border border-line bg-surface px-5 py-3" style={{ left: RELAY.x, top: RELAY.y, width: RELAY.w, opacity: show }}>
        <p className="font-work text-[14px] font-semibold tracking-[0.14em] text-muted uppercase">Copyyt server</p>
        <p className={`mt-1 truncate text-[18px] ${holding ? "font-mono text-brand" : "font-work text-muted"}`}>
          {holding ? scramble(SNIPPET, t, 1) : "waiting…"}
        </p>
      </div>
    </>
  );
}

// ---- Caption strip ---------------------------------------------------------------------

function Captions({ t }: { t: number }) {
  let i = -1;
  while (i < CAPTIONS.length - 1 && t >= CAPTIONS[i + 1][0]) i++;
  const hide = prog(t, AT.outro - 0.2, AT.outro + 0.3);
  const devices = t >= AT.pause + 0.1 && t < AT.outro ? "2 receiving · 1 paused" : "3 devices connected";
  return (
    <div className="absolute right-0 bottom-0 left-0 flex h-[220px] items-center justify-between border-t border-line px-[120px]" style={{ opacity: 1 - hide }}>
      <div className="relative h-[80px] flex-1 overflow-hidden">
        {[i - 1, i].map((k) => {
          if (k < 0 || !CAPTIONS[k][1]) return null;
          const p = easeOut(prog(t, CAPTIONS[k][0], CAPTIONS[k][0] + 0.45));
          const y = k === i ? (1 - p) * 80 : -easeOut(prog(t, CAPTIONS[i][0], CAPTIONS[i][0] + 0.45)) * 80;
          return (
            <p key={k} className="font-sora absolute top-0 left-0 text-[60px] leading-[80px] font-semibold tracking-[-0.02em] whitespace-nowrap text-ink" style={{ transform: `translateY(${y}px)` }}>
              {CAPTIONS[k][1]}
            </p>
          );
        })}
      </div>
      <p className="font-work flex items-center gap-3 text-[22px] text-muted" style={{ opacity: prog(t, 1.2, 1.8) }}>
        <span className={`h-3 w-3 rounded-full ${devices.includes("paused") ? "bg-warning" : "bg-success"}`} />
        {devices}
      </p>
    </div>
  );
}

// ---- Outro: the card becomes the logo -------------------------------------------------

function Outro({ t }: { t: number }) {
  const s = AT.outro;
  if (t < s) return null;
  const fly = easeInOut(prog(t, s, s + 0.9));
  const split = easeInOut(prog(t, s + 0.9, s + 1.5));
  const swap = prog(t, s + 1.5, s + 1.8);
  const from = center(PHONE);
  const pos = { x: lerp(from.x, 960, fly), y: lerp(from.y, 400, fly) };
  const size = lerp(60, 150, fly);
  return (
    <div className="absolute inset-0 z-30">
      <div className="absolute" style={{ left: pos.x, top: pos.y, transform: "translate(-50%,-50%)", opacity: 1 - swap }}>
        <div className="relative" style={{ width: size * 1.3, height: size * 1.3 }}>
          <div className="absolute rounded-[28%] bg-brand/40" style={{ width: size, height: size, left: split * size * 0.3, top: 0 }} />
          <div className="absolute rounded-[28%] bg-brand" style={{ width: size, height: size, left: 0, top: split * size * 0.3 }} />
        </div>
      </div>
      <div className="absolute flex flex-col items-center" style={{ left: 960, top: 400, transform: "translate(-50%,-50%)", opacity: swap }}>
        <Logo width={200} height={200} />
      </div>
      <div className="absolute right-0 left-0 flex flex-col items-center" style={{ top: 560, opacity: easeOut(prog(t, s + 1.8, s + 2.4)) }}>
        <p className="font-sora text-[96px] leading-none font-bold tracking-[-0.03em] text-ink">Copyyt</p>
        <p className="font-work mt-6 text-[30px] text-muted">One clipboard for your Android phone and every laptop.</p>
      </div>
      <div className="absolute right-0 left-0 flex justify-center gap-4" style={{ top: 860, opacity: easeOut(prog(t, s + 2.5, s + 3)) }}>
        <span className="font-work rounded-full bg-primary px-8 py-3.5 text-[28px] font-semibold text-on-primary">copyyt.com</span>
        <span className="font-work rounded-full border border-line px-8 py-3.5 text-[24px] text-muted">Chrome extension · Android app</span>
      </div>
    </div>
  );
}

// ---- Frame ---------------------------------------------------------------------------------

function Frame({ t }: { t: number }) {
  const { cx, cy, zoom } = camera(t);
  const stageFade = 1 - 0.93 * easeInOut(prog(t, AT.outro, AT.outro + 0.8));
  const mac = center(MAC);
  const pc = center(PC);
  const phone = center(PHONE);
  return (
    <main className="relative h-[1080px] w-[1920px] overflow-hidden bg-page text-ink">
      <div className="absolute h-[900px] w-[900px] rounded-full bg-soft opacity-50 blur-3xl" style={{ left: 510 + Math.sin(t / 5) * 80, top: -300 }} />
      <div className="absolute top-0 left-0 overflow-hidden" style={{ width: VIEW_W, height: VIEW_H }}>
        <div
          className="absolute top-0 left-0"
          style={{
            width: VIEW_W,
            height: VIEW_H,
            transformOrigin: "0 0",
            transform: `translate(${VIEW_W / 2 - cx * zoom}px, ${VIEW_H / 2 - cy * zoom}px) scale(${zoom})`,
            opacity: stageFade,
          }}
        >
          <Relay t={t} />
          <Laptop box={MAC} name="Work MacBook" t={t} at={0.2}>
            <MacScreen t={t} />
          </Laptop>
          <Laptop box={PC} name="Home PC" t={t} at={0.5}>
            <PcScreen t={t} />
          </Laptop>
          <PhoneBody t={t} at={0.8} dim={t >= AT.pause + 0.1}>
            <PhoneScreen t={t} />
          </PhoneBody>
          <Packet t={t} from={{ x: mac.x, y: MAC.y + 120 }} to={{ x: pc.x, y: PC.y + 120 }} start={AT.launch} end={AT.land} />
          <Packet t={t} from={{ x: mac.x, y: MAC.y + 120 }} to={{ x: phone.x, y: PHONE.y + 120 }} start={AT.launch} end={AT.land} lift={300} />
          <Packet t={t} image from={{ x: phone.x, y: PHONE.y + 200 }} to={{ x: mac.x, y: MAC.y + 90 }} start={AT.imgLaunch} end={AT.imgLand} lift={320} />
          <Packet t={t} image from={{ x: phone.x, y: PHONE.y + 200 }} to={{ x: pc.x, y: PC.y + 90 }} start={AT.imgLaunch} end={AT.imgLand} lift={200} />
          <Packet t={t} from={{ x: mac.x, y: MAC.y + 60 }} to={{ x: RELAY.x + RELAY.w / 2, y: RELAY.y + 48 }} via={{ x: mac.x, y: 40 }} start={AT.relayLaunch} end={AT.relayIn} sealedEnd />
          <Packet t={t} from={{ x: RELAY.x + RELAY.w / 2, y: RELAY.y + 48 }} to={{ x: pc.x, y: PC.y + 60 }} via={{ x: pc.x, y: 40 }} start={AT.relayOut} end={AT.relayLand} sealedStart />
        </div>
      </div>
      <Captions t={t} />
      <Outro t={t} />
    </main>
  );
}

mountVideo(Frame, DURATION);
