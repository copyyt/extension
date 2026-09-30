/* eslint-disable react-refresh/only-export-components -- standalone capture page, not hot-reloaded UI */
/**
 * "Showcase" promo (1920x1080, white). Opens on the email-yourself problem and
 * the iPhone/Mac origin, then demos each feature with the app on a grey panel
 * at left and the story at right. Scenes slide sideways.
 * Capture with: capture-video.mjs <build>/promo-showcase.html out.mp4
 */
import React from "react";
import "@/index.css";
import Logo from "@/vectors/logo";
import { Alert, Card, CardTitle, Muted, UiButton } from "@/components/ui";
import {
  AppHome,
  BrowserWindow,
  Cursor,
  DocLines,
  Notification,
  Phone,
  Popup,
  SyncCard,
  Tabs,
  blink,
  easeInOut,
  easeOut,
  lerp,
  mountVideo,
  prog,
  typed,
} from "./promo-parts";

const DURATION = 47.5;

const T = {
  problem: [0, 5.6],
  origin: [5.6, 10.6],
  copy: [10.6, 15.4],
  paste: [15.4, 19.6],
  phone: [19.6, 25.2],
  send: [25.2, 30.0],
  images: [30.0, 34.2],
  devices: [34.2, 38.8],
  privacy: [38.8, 43.2],
  outro: [43.2, DURATION + 1],
} as const;

const SNIPPET = "Nori House, 8 Elm St · 7:30 pm";

// ---- Motion ------------------------------------------------------------------------

/** Sideways slide for a scene: in from the right, out to the left. */
function slide(t: number, start: number, end: number, delay = 0, dist = 140): React.CSSProperties {
  const i = easeOut(prog(t, start + delay, start + delay + 0.55));
  const o = easeInOut(prog(t, end - 0.4, end));
  return { opacity: Math.min(i, 1 - o), transform: `translateX(${(1 - i) * dist - o * dist}px)` };
}

function appear(t: number, at: number, d = 0.45): React.CSSProperties {
  const p = easeOut(prog(t, at, at + d));
  return { opacity: p, transform: `translateY(${(1 - p) * 16}px)` };
}

const live = (t: number, [s, e]: readonly [number, number]) => t >= s && t < e;

// ---- Shared layout -------------------------------------------------------------------

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-work text-[20px] font-semibold tracking-[0.2em] text-brand uppercase">{children}</p>;
}

/** Grey rounded panel that holds the app; it stays put while scenes change inside it. */
function Panel({ t }: { t: number }) {
  const s = T.copy[0];
  const e = T.devices[1];
  if (t < s - 0.2 || t >= e + 0.2) return null;
  const i = easeOut(prog(t, s - 0.2, s + 0.4));
  const o = easeInOut(prog(t, e - 0.3, e + 0.2));
  return (
    <div
      className="absolute rounded-[48px] bg-[#f1f4f7]"
      style={{ left: 90, top: 90, width: 1080, height: 900, opacity: i * (1 - o), transform: `scale(${lerp(0.96, 1, i)})` }}
    />
  );
}

function Feature({
  t,
  span,
  eyebrow,
  title,
  sub,
  children,
}: {
  t: number;
  span: readonly [number, number];
  eyebrow: string;
  title: React.ReactNode;
  sub: string;
  children: React.ReactNode;
}) {
  if (!live(t, span)) return null;
  const [s, e] = span;
  return (
    <>
      <div className="absolute flex items-center justify-center" style={{ left: 90, top: 90, width: 1080, height: 900, ...slide(t, s, e, 0.05, 120) }}>
        {children}
      </div>
      <div className="absolute flex flex-col justify-center" style={{ left: 1260, top: 90, width: 580, height: 900, ...slide(t, s, e, 0.18, 70) }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="font-sora mt-5 text-[68px] leading-[1.05] font-bold tracking-[-0.03em] text-ink">{title}</h2>
        <p className="font-work mt-6 text-[26px] leading-[1.45] text-muted">{sub}</p>
      </div>
    </>
  );
}

function KeyHint({ keys, t, at }: { keys: string[]; t: number; at: number }) {
  const show = easeOut(prog(t, at - 0.4, at - 0.1)) * (1 - prog(t, at + 1.0, at + 1.3));
  const pressed = t >= at && t < at + 0.3;
  return (
    <div className="absolute bottom-[70px] left-1/2 flex -translate-x-1/2 items-center gap-2" style={{ opacity: show }}>
      {keys.map((k) => (
        <span
          key={k}
          className={`font-sora rounded-xl px-5 py-2.5 text-[26px] font-semibold text-white transition-none ${pressed ? "bg-brand" : "bg-ink"}`}
          style={{ transform: `scale(${pressed ? 0.94 : 1})` }}
        >
          {k}
        </span>
      ))}
    </div>
  );
}

// ---- Opening: the problem ---------------------------------------------------------------

function Problem({ t }: { t: number }) {
  const [s, e] = T.problem;
  if (!live(t, T.problem)) return null;
  const out = easeInOut(prog(t, e - 0.45, e));
  const strike = easeInOut(prog(t, 3.7, 4.1));
  const line = (text: string, at: number, className: string) => {
    const shown = typed(text, t, at, 42);
    const typing = t >= at && shown.length < text.length;
    return t < at ? null : (
      <p className={`font-sora relative w-fit text-[76px] leading-[1.15] font-bold tracking-[-0.03em] ${className}`}>
        {shown}
        {typing ? <span className="ml-1 inline-block h-[64px] w-[5px] translate-y-2 bg-brand" /> : null}
      </p>
    );
  };
  return (
    <div className="absolute inset-0 flex flex-col justify-center pl-[180px]" style={{ opacity: 1 - out, transform: `translateX(${-out * 140}px)` }}>
      {line("You copy something on your laptop.", s + 0.3, "text-ink")}
      {line("You need it on your phone.", s + 1.5, "text-ink")}
      <div className="relative w-fit">
        {line("So you email it to yourself.", s + 2.6, "text-muted")}
        <span className="absolute top-1/2 left-0 h-[7px] rounded-full bg-brand" style={{ width: `${strike * 100}%` }} />
      </div>
      <p className="font-sora mt-6 text-[96px] leading-none font-bold tracking-[-0.04em] text-brand" style={appear(t, s + 4.3, 0.4)}>
        Not anymore.
      </p>
    </div>
  );
}

// ---- Origin: Apple has it, everyone else didn't -----------------------------------

function PhoneGlyph() {
  return (
    <svg width="46" height="72" viewBox="0 0 46 72" fill="none" stroke="currentColor" strokeWidth="4">
      <rect x="3" y="3" width="40" height="66" rx="9" />
      <path d="M18 60h10" strokeLinecap="round" />
    </svg>
  );
}

function LaptopGlyph() {
  return (
    <svg width="110" height="72" viewBox="0 0 110 72" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round">
      <rect x="15" y="3" width="80" height="54" rx="6" />
      <path d="M3 66h104l-6-8H9z" />
    </svg>
  );
}

function OriginCard({ t, at, label, children, active = false }: { t: number; at: number; label: string; children: React.ReactNode; active?: boolean }) {
  return (
    <div
      className={`relative flex h-[380px] w-[640px] flex-col justify-between rounded-[36px] border-2 bg-white p-10 ${active ? "border-brand shadow-[0_30px_80px_rgba(45,156,219,0.18)]" : "border-line"}`}
      style={appear(t, at, 0.5)}
    >
      <div className="flex items-end gap-5 text-muted">
        <PhoneGlyph />
        <LaptopGlyph />
      </div>
      <p className="font-sora text-[34px] leading-tight font-semibold text-ink">{label}</p>
      {children}
    </div>
  );
}

function Origin({ t }: { t: number }) {
  const [s, e] = T.origin;
  if (!live(t, T.origin)) return null;
  const turn = t >= s + 2.6;
  const logo = easeOut(prog(t, s + 2.6, s + 3.0));
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={slide(t, s, e, 0, 140)}>
      <div className="relative h-[70px] w-full text-center">
        <p className="font-sora absolute inset-x-0 text-[56px] font-bold tracking-[-0.03em] text-ink" style={{ opacity: 1 - prog(t, s + 2.9, s + 3.2) }}>
          iPhone and Mac have done this for years.
        </p>
        <p className="font-sora absolute inset-x-0 text-[56px] font-bold tracking-[-0.03em] text-ink" style={appear(t, s + 3.2, 0.4)}>
          Now Android and <span className="text-brand">every laptop</span> can too.
        </p>
      </div>
      <div className="mt-20 flex gap-16">
        <OriginCard t={t} at={s + 0.4} label="iPhone + Mac">
          <p className="font-work text-[26px] font-semibold text-success">✓ Copy on one, paste on the other</p>
        </OriginCard>
        <OriginCard t={t} at={s + 0.9} label="Android + Windows, Mac, Linux or Chromebook" active={turn}>
          {turn ? (
            <p className="font-work flex items-center gap-3 text-[26px] font-semibold text-success" style={appear(t, s + 2.6, 0.35)}>
              ✓ Now there&apos;s Copyyt
            </p>
          ) : (
            <p className="font-work text-[26px] font-semibold text-muted">✕ Nothing built in</p>
          )}
          {logo > 0 ? (
            <div
              className="absolute top-8 right-8 flex items-center gap-3 rounded-2xl bg-soft px-4 py-3"
              style={{ opacity: logo, transform: `scale(${lerp(0.6, 1, logo)})` }}
            >
              <Logo width={44} height={44} />
              <span className="font-sora text-[30px] font-bold text-ink">Copyyt</span>
            </div>
          ) : null}
        </OriginCard>
      </div>
    </div>
  );
}

// ---- Feature scenes -----------------------------------------------------------------

function SceneCopy({ t }: { t: number }) {
  const [s] = T.copy;
  const sel = easeInOut(prog(t, s + 1.3, s + 2.2));
  const chars = Math.round(SNIPPET.length * sel);
  const keyAt = s + 2.8;
  const pulse = prog(t, keyAt + 0.2, keyAt + 1.0);
  return (
    <Feature t={t} span={T.copy} eyebrow="Work MacBook" title="Copy like you always do." sub="Select anything and press copy. Copyyt quietly sends it to your other devices.">
      <BrowserWindow url="docs.example.com/friday-plans" iconPulse={pulse} width={960} height={620}>
        <div className="p-14">
          <div className="font-sora mb-8 text-[34px] font-bold text-ink">Friday plans</div>
          <p className="font-work mb-8 text-[30px] text-ink">
            <span className="bg-selection text-on-selection">{SNIPPET.slice(0, chars)}</span>
            {SNIPPET.slice(chars)}
          </p>
          <DocLines widths={[90, 82, 86, 58]} />
        </div>
        <Cursor x={lerp(70, 70 + 16.5 * SNIPPET.length, sel)} y={250} />
      </BrowserWindow>
      <KeyHint keys={["⌘", "C"]} t={t} at={keyAt} />
    </Feature>
  );
}

function ScenePaste({ t }: { t: number }) {
  const [s] = T.paste;
  const keyAt = s + 1.6;
  const pasted = t >= keyAt + 0.1;
  return (
    <Feature t={t} span={T.paste} eyebrow="Home PC" title="It's already on your other laptop." sub="Windows, Mac, Linux or a Chromebook. If it runs Chrome, just paste.">
      <BrowserWindow url="chat.example.com/sam" width={960} height={620}>
        <div className="font-work flex h-[540px] flex-col justify-end gap-4 p-10 text-[26px]">
          <div className="max-w-[70%] rounded-3xl rounded-bl-md bg-page px-6 py-4 text-ink">Where are we eating Friday?</div>
          <div className="flex items-center gap-3 rounded-2xl border border-line px-5 py-4 text-ink">
            {pasted ? (
              <span style={{ background: `rgba(169,216,242,${1 - prog(t, keyAt + 0.3, keyAt + 1.2)})` }}>{SNIPPET}</span>
            ) : (
              <span className="text-muted">Message</span>
            )}
            <span className="inline-block h-8 w-[3px] bg-ink" style={{ opacity: blink(t) }} />
          </div>
        </div>
      </BrowserWindow>
      <KeyHint keys={["Ctrl", "V"]} t={t} at={keyAt} />
    </Feature>
  );
}

function ScenePhone({ t }: { t: number }) {
  const [s] = T.phone;
  const pressAt = s + 2.9;
  const menu = easeOut(prog(t, pressAt + 0.5, pressAt + 0.75));
  const tapAt = pressAt + 1.0;
  const pasted = t >= tapAt + 0.1;
  const touch = (at: number, d: number) => (t >= at && t < at + d ? prog(t, at, at + d) : 0);
  return (
    <Feature t={t} span={T.phone} eyebrow="Android phone" title="And on your phone." sub="It lands on your Android clipboard by itself. A notification says where it came from.">
      <Phone scale={0.95}>
        <Notification t={t} at={s + 0.9} title="Copied from Work MacBook" body={`${SNIPPET.length} characters are on your clipboard`} />
        <div className="font-work px-7 pt-6">
          <div className="mb-6 flex items-center justify-between text-[#0f3449]">
            <span className="text-2xl">←</span>
            <span className="text-2xl">✓</span>
          </div>
          <p className="text-[30px] text-[#9aa7ae]">Title</p>
          <p className="mt-2 text-[14px] text-[#9aa7ae]">Today · {pasted ? SNIPPET.length : 0} characters</p>
          <div className="relative mt-6 text-[22px] leading-8 text-ink">
            {pasted ? SNIPPET : <span className="text-[#9aa7ae]">Start typing</span>}
            {menu > 0 && !pasted ? (
              <div
                className="absolute -top-16 left-0 flex gap-6 rounded-2xl bg-white px-5 py-3 text-[18px] text-ink shadow-[0_8px_24px_rgba(15,52,73,0.18)]"
                style={{ opacity: menu, transform: `scale(${lerp(0.9, 1, menu)})` }}
              >
                <span className="font-semibold">Paste</span>
                <span>Select all</span>
              </div>
            ) : null}
          </div>
        </div>
        {touch(pressAt, 0.8) > 0 ? (
          <span
            className="absolute rounded-full bg-brand/30"
            style={{ left: 60 - 30 * touch(pressAt, 0.8), top: 300 - 30 * touch(pressAt, 0.8), width: 60 * touch(pressAt, 0.8) + 20, height: 60 * touch(pressAt, 0.8) + 20 }}
          />
        ) : null}
        {touch(tapAt, 0.4) > 0 ? <span className="absolute h-12 w-12 rounded-full bg-brand/30" style={{ left: 38, top: 226, opacity: 1 - touch(tapAt, 0.4) }} /> : null}
      </Phone>
    </Feature>
  );
}

function SceneSend({ t }: { t: number }) {
  return (
    <Feature t={t} span={T.send} eyebrow="Android phone" title="Send the other way in one tap." sub="Tap Send in the app, use Share → Copyyt, or add the Quick Settings tile.">
      <Phone scale={0.95}>
        <AppHome t={t} tapAt={T.send[0] + 1.8} />
      </Phone>
    </Feature>
  );
}

function PopupStage({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div className="relative" style={{ width: 960, height: 640 }}>
      <BrowserWindow url={url} width={760} height={560}>
        <div className="space-y-4 p-10 opacity-60">
          <div className="h-6 w-1/3 rounded bg-line" />
          <DocLines widths={[60, 52, 46, 56, 40]} />
        </div>
      </BrowserWindow>
      <div className="absolute top-[40px] right-0" style={{ transform: "scale(1.38)", transformOrigin: "top right" }}>
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}

function SceneImages({ t }: { t: number }) {
  const [s] = T.images;
  const clickAt = s + 2.0;
  const move = easeInOut(prog(t, s + 0.9, clickAt - 0.1));
  return (
    <Feature t={t} span={T.images} eyebrow="Chrome extension" title="Photos and screenshots too." sub="Images wait in the Copyyt popup. One click puts them on your clipboard.">
      <PopupStage url="mail.example.com/compose">
        <Popup>
          <Tabs active="Home" />
          <Card tone="accent">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Image from Android phone</CardTitle>
                <Muted>Available until 7:42:10 PM</Muted>
              </div>
              <UiButton>Copy image</UiButton>
            </div>
          </Card>
          <SyncCard mode="both" />
          {t >= clickAt + 0.15 ? (
            <div style={appear(t, clickAt + 0.15, 0.35)}>
              <Alert tone="success">Image copied. Paste it anywhere.</Alert>
            </div>
          ) : null}
        </Popup>
        <Cursor x={lerp(250, 348, move)} y={lerp(420, 168, move)} click={t >= clickAt ? prog(t, clickAt, clickAt + 0.5) : 0} />
      </PopupStage>
    </Feature>
  );
}

function SceneDevices({ t }: { t: number }) {
  const [s] = T.devices;
  const toHome = s + 2.2;
  const clickAt = s + 3.3;
  const onHome = t >= toHome;
  const move = easeInOut(prog(t, toHome, clickAt - 0.1));
  const devices = [
    { badge: "WEB", name: "Work MacBook", meta: "Chrome · This device", current: true },
    { badge: "WEB", name: "Home PC", meta: "Chrome" },
    { badge: "AND", name: "Android phone", meta: "Android" },
  ];
  return (
    <Feature t={t} span={T.devices} eyebrow="Every device" title="You decide what goes where." sub="See every device, remove one in a click, and set each to send, receive or pause.">
      <PopupStage url="notes.example.com/today">
        {onHome ? (
          <Popup>
            <Tabs active="Home" />
            <SyncCard mode={t >= clickAt + 0.1 ? "receive-only" : "both"} />
            <UiButton size="lg" className="w-full">
              Send current clipboard
            </UiButton>
          </Popup>
        ) : (
          <Popup>
            <Tabs active="Devices" />
            <UiButton tone="secondary" className="w-full">
              Check for new devices
            </UiButton>
            <Card>
              <CardTitle>Your devices</CardTitle>
              <ul className="mt-2 divide-y divide-line">
                {devices.map((d, i) => (
                  <li key={d.name} className="flex items-center justify-between gap-3 py-2.5" style={appear(t, s + 0.6 + i * 0.18, 0.4)}>
                    <div className="flex items-center gap-3">
                      <span className="font-sora flex h-9 w-9 items-center justify-center rounded-xl bg-soft text-xs font-bold text-primary">{d.badge}</span>
                      <div>
                        <p className="font-work text-sm font-semibold text-ink">{d.name}</p>
                        <p className="font-work text-xs text-muted">{d.meta}</p>
                      </div>
                    </div>
                    {d.current ? null : (
                      <UiButton tone="danger-outline" className="!px-2.5 !py-1 text-xs">
                        Remove
                      </UiButton>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </Popup>
        )}
        <Cursor x={onHome ? lerp(330, 128, move) : 330} y={onHome ? lerp(380, 238, move) : 380} click={t >= clickAt ? prog(t, clickAt, clickAt + 0.5) : 0} />
      </PopupStage>
    </Feature>
  );
}

// ---- Privacy ------------------------------------------------------------------------------

function Icon({ d }: { d: string }) {
  return (
    <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-soft">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1e6892" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

const PRIVACY = [
  { icon: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z", title: "Encrypted on your device", body: "Everything is locked before it leaves your laptop or phone." },
  { icon: "M3 3l18 18M10.6 5.1A10 10 0 0 1 21 12a10.5 10.5 0 0 1-2.6 3.5M6.2 6.3A10.5 10.5 0 0 0 3 12a10 10 0 0 0 13.9 5.6", title: "The server can't read it", body: "It only passes along scrambled data it can't open." },
  { icon: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", title: "Nothing is kept", body: "No clipboard history. Items expire from the relay in 60 seconds." },
];

function Privacy({ t }: { t: number }) {
  const [s, e] = T.privacy;
  if (!live(t, T.privacy)) return null;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={slide(t, s, e, 0, 140)}>
      <h2 className="font-sora text-[84px] font-bold tracking-[-0.035em] text-ink" style={appear(t, s + 0.15, 0.5)}>
        Designed to protect your privacy<span className="text-brand">.</span>
      </h2>
      <div className="mt-20 flex gap-10">
        {PRIVACY.map((item, i) => (
          <div key={item.title} className="w-[480px] rounded-[32px] border border-line bg-white p-10 shadow-[0_24px_60px_rgba(15,52,73,0.08)]" style={appear(t, s + 0.7 + i * 0.25, 0.5)}>
            <Icon d={item.icon} />
            <p className="font-sora mt-8 text-[32px] font-semibold text-ink">{item.title}</p>
            <p className="font-work mt-3 text-[22px] leading-[1.5] text-muted">{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Outro ------------------------------------------------------------------------------------

function Outro({ t }: { t: number }) {
  const [s] = T.outro;
  if (t < s) return null;
  return (
    <div className="absolute inset-0 flex items-center">
      <div className="flex w-1/2 flex-col justify-center pl-[180px]" style={slide(t, s, DURATION + 5, 0, 120)}>
        <p className="font-sora text-[130px] leading-[1.02] font-bold tracking-[-0.045em] text-ink">Copy here.</p>
        <p className="font-sora text-[130px] leading-[1.02] font-bold tracking-[-0.045em] text-brand" style={appear(t, s + 0.35, 0.5)}>
          Paste there.
        </p>
      </div>
      <div className="h-[520px] w-px bg-line" style={{ opacity: prog(t, s + 0.4, s + 0.8) }} />
      <div className="flex w-1/2 flex-col items-start justify-center pl-[140px]" style={slide(t, s, DURATION + 5, 0.3, 80)}>
        <div className="flex items-center gap-5">
          <Logo width={96} height={96} />
          <span className="font-sora text-[84px] font-bold tracking-[-0.03em] text-ink">Copyyt</span>
        </div>
        <span className="font-work mt-12 rounded-full bg-primary px-9 py-4 text-[34px] font-semibold text-on-primary" style={appear(t, s + 0.9)}>
          copyyt.com
        </span>
        <div className="mt-8 flex gap-4" style={appear(t, s + 1.15)}>
          {["Chrome extension", "Android app"].map((b) => (
            <span key={b} className="font-work rounded-full border-2 border-line px-6 py-2.5 text-[24px] font-semibold text-muted">
              {b}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Frame({ t }: { t: number }) {
  return (
    <main className="relative h-[1080px] w-[1920px] overflow-hidden bg-white text-ink">
      <Problem t={t} />
      <Origin t={t} />
      <Panel t={t} />
      <SceneCopy t={t} />
      <ScenePaste t={t} />
      <ScenePhone t={t} />
      <SceneSend t={t} />
      <SceneImages t={t} />
      <SceneDevices t={t} />
      <Privacy t={t} />
      <Outro t={t} />
    </main>
  );
}

mountVideo(Frame, DURATION);
