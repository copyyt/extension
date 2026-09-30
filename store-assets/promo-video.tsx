/* eslint-disable react-refresh/only-export-components -- standalone capture page, not hot-reloaded UI */
/**
 * Promo video (1920x1080). Every frame is a pure function of time `t`, so
 * capture-video.mjs can seek frame by frame. Open promo-video.html in the dev
 * server to watch it play; add ?t=12.5 to freeze on a moment.
 */
import React from "react";
import "@/index.css";
import Logo from "@/vectors/logo";
import { Alert, Card, CardTitle, Muted, UiButton } from "@/components/ui";
import { AppHome, BrowserWindow, Cursor, DocLines, Notification, Phone, Popup, SyncCard, Tabs, ZoomedPopup, blink, easeInOut, easeOut, lerp, mountVideo, prog } from "./promo-parts";

export const DURATION = 44.5;

// ---- Timing helpers --------------------------------------------------------

/** Opacity/blur/scale envelope for a scene living in [start, end). */
function envelope(t: number, start: number, end: number, fadeIn = 0.45, fadeOut = 0.35) {
  const i = easeOut(prog(t, start, start + fadeIn));
  const o = 1 - easeInOut(prog(t, end - fadeOut, end));
  const v = Math.min(i, o);
  return {
    opacity: v,
    filter: `blur(${(1 - v) * 14}px)`,
    transform: `scale(${lerp(0.97, 1, v)})`,
  };
}

/** Rise-in for a single element starting at `at`. */
function rise(t: number, at: number, d = 0.5, dist = 24): React.CSSProperties {
  const p = easeOut(prog(t, at, at + d));
  return { opacity: p, transform: `translateY(${(1 - p) * dist}px)`, filter: `blur(${(1 - p) * 6}px)` };
}

// ---- Shared pieces -----------------------------------------------------------

function Background({ t }: { t: number }) {
  const drift = Math.sin(t / 6) * 60;
  return (
    <div className="absolute inset-0 overflow-hidden bg-page">
      <div
        className="absolute h-[900px] w-[900px] rounded-full bg-soft blur-3xl"
        style={{ top: -420 + drift, right: -260 - drift }}
      />
      <div
        className="absolute h-[700px] w-[700px] rounded-full bg-soft opacity-70 blur-3xl"
        style={{ bottom: -380 - drift, left: -220 + drift }}
      />
    </div>
  );
}

function Keys({ keys, t, at }: { keys: string[]; t: number; at: number }) {
  const show = easeOut(prog(t, at - 0.35, at));
  const hide = 1 - prog(t, at + 0.9, at + 1.2);
  const pressed = t >= at && t < at + 0.25;
  return (
    <div
      className="absolute bottom-8 left-1/2 z-40 flex gap-3"
      style={{ opacity: Math.min(show, hide), transform: `translate(-50%, ${(1 - show) * 20}px)` }}
    >
      {keys.map((key) => (
        <span
          key={key}
          className="font-sora flex h-[72px] min-w-[72px] items-center justify-center rounded-2xl border border-line bg-surface px-5 text-[30px] font-semibold text-ink"
          style={{
            boxShadow: pressed ? "0 1px 0 #d5e3e9" : "0 6px 0 #d5e3e9, 0 16px 30px rgba(15,52,73,0.12)",
            transform: `translateY(${pressed ? 5 : 0}px)`,
          }}
        >
          {key}
        </span>
      ))}
    </div>
  );
}

function DeviceTag({ label, t, at }: { label: string; t: number; at: number }) {
  return (
    <div className="font-work absolute -top-14 left-0 flex items-center gap-2 text-xl font-semibold text-muted" style={rise(t, at)}>
      <span className="h-2.5 w-2.5 rounded-full bg-success" />
      {label}
    </div>
  );
}

// ---- Scene scaffolding -------------------------------------------------------

const FEATURES = 6;

function Feature({
  t,
  start,
  end,
  index,
  title,
  sub,
  chip,
  children,
}: {
  t: number;
  start: number;
  end: number;
  index: number;
  title: React.ReactNode;
  sub: string;
  chip: string;
  children: React.ReactNode;
}) {
  if (t < start || t >= end) return null;
  const within = prog(t, start + 0.3, end - 0.3);
  return (
    <div className="absolute inset-0 flex items-center px-[110px]" style={envelope(t, start, end)}>
      <div className="w-[520px] shrink-0">
        <h2 className="font-sora text-[76px] leading-[1.02] font-bold tracking-[-0.03em] text-ink" style={rise(t, start + 0.1)}>
          {title}
        </h2>
        <p className="font-work mt-6 text-[26px] leading-9 text-muted" style={rise(t, start + 0.25)}>
          {sub}
        </p>
        <span
          className="mt-8 inline-flex rounded-xl border border-line bg-surface px-4 py-2 font-mono text-[20px] font-semibold text-ink shadow-sm"
          style={rise(t, start + 0.4)}
        >
          {chip}
        </span>
        <div className="mt-16 flex gap-2.5" style={rise(t, start + 0.4)}>
          {Array.from({ length: FEATURES }, (_, i) => (
            <span key={i} className="h-1.5 w-14 overflow-hidden rounded-full bg-line">
              <span
                className="block h-full rounded-full bg-brand"
                style={{ width: `${i < index ? 100 : i === index ? within * 100 : 0}%` }}
              />
            </span>
          ))}
        </div>
      </div>
      <div className="relative flex h-[800px] flex-1 items-center justify-center">{children}</div>
    </div>
  );
}

function Center({ t, start, end, children }: { t: number; start: number; end: number; children: React.ReactNode }) {
  if (t < start || t >= end) return null;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={envelope(t, start, end)}>
      {children}
    </div>
  );
}

// ---- Scenes --------------------------------------------------------------------

const T = {
  intro: [0, 2.6],
  hook: [2.6, 5.0],
  origin: [5.0, 8.6],
  copy: [8.6, 13.6],
  paste: [13.6, 17.8],
  phone: [17.8, 23.8],
  send: [23.8, 28.8],
  images: [28.8, 33.0],
  devices: [33.0, 37.6],
  privacy: [37.6, 40.8],
  outro: [40.8, DURATION + 1],
} as const;

const SNIPPET = "Café Nero, 14 Market St · 3 pm";

function Intro({ t }: { t: number }) {
  const [, e] = T.intro;
  if (t >= e) return null;
  const pop = easeOut(prog(t, 0.1, 0.8));
  const slide = easeInOut(prog(t, 1.0, 1.6));
  const word = easeOut(prog(t, 1.25, 1.9));
  const out = 1 - easeInOut(prog(t, e - 0.4, e));
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ opacity: out, filter: `blur(${(1 - out) * 12}px)` }}>
      <div className="flex items-center" style={{ gap: lerp(0, 36, slide) }}>
        <div
          className="flex h-[180px] w-[180px] items-center justify-center rounded-[44px] bg-surface shadow-[0_30px_80px_rgba(15,52,73,0.18)]"
          style={{ transform: `scale(${lerp(0.6, 1, pop)})`, opacity: pop }}
        >
          <Logo width={120} height={120} />
        </div>
        <div className="overflow-hidden" style={{ width: lerp(0, 420, slide) }}>
          <span
            className="font-sora block text-[120px] leading-none font-bold tracking-[-0.03em] whitespace-nowrap text-ink"
            style={{ opacity: word, transform: `translateX(${(1 - word) * -30}px)` }}
          >
            Copyyt
          </span>
        </div>
      </div>
    </div>
  );
}

function Hook({ t }: { t: number }) {
  const [s, e] = T.hook;
  return (
    <Center t={t} start={s} end={e}>
      <h1 className="font-sora text-[128px] leading-none font-bold tracking-[-0.04em] text-ink">
        {["Stop", "emailing", "yourself"].map((w, i) => (
          <span key={w} className={`inline-block ${i < 2 ? "mr-[0.25em]" : ""}`} style={rise(t, s + 0.1 + i * 0.14, 0.5, 40)}>
            {w}
          </span>
        ))}
        <span className="inline-block text-brand" style={rise(t, s + 0.55, 0.5, 40)}>
          .
        </span>
      </h1>
    </Center>
  );
}

function Origin({ t }: { t: number }) {
  const [s, e] = T.origin;
  return (
    <Center t={t} start={s} end={e}>
      <p className="font-work text-[34px] text-muted" style={rise(t, s + 0.1)}>
        iPhone and Mac have shared a clipboard for years.
      </p>
      <h1 className="font-sora mt-8 text-[104px] leading-[1.05] font-bold tracking-[-0.04em] text-ink">
        <span className="block" style={rise(t, s + 0.8, 0.55, 40)}>
          Now Android and
        </span>
        <span className="block text-primary" style={rise(t, s + 1.05, 0.55, 40)}>
          every laptop do too.
        </span>
      </h1>
    </Center>
  );
}

function SceneCopy({ t }: { t: number }) {
  const [s, e] = T.copy;
  const sel = easeInOut(prog(t, s + 1.3, s + 2.2));
  const selChars = Math.round(SNIPPET.length * sel);
  const keyAt = s + 2.8;
  const pulse = prog(t, keyAt + 0.2, keyAt + 1.0);
  const cx = lerp(80, 80 + 17 * SNIPPET.length, sel);
  return (
    <Feature t={t} start={s} end={e} index={0} title={<>Copy on your laptop</>} sub="Just copy like you always do. Nothing new to learn." chip="⌘ C  /  Ctrl C">
      <div className="relative" style={rise(t, s + 0.2, 0.6, 40)}>
        <DeviceTag label="Work MacBook" t={t} at={s + 0.5} />
        <BrowserWindow url="docs.example.com/team-lunch" iconPulse={pulse}>
          <div className="p-14">
            <div className="font-sora mb-8 text-[34px] font-bold text-ink">Team lunch 🍝</div>
            <p className="font-work mb-8 text-[30px] text-ink">
              <span className="bg-selection text-on-selection">{SNIPPET.slice(0, selChars)}</span>
              {SNIPPET.slice(selChars)}
            </p>
            <DocLines widths={[92, 84, 88, 60, 80]} />
          </div>
          <Cursor x={cx} y={250} />
        </BrowserWindow>
        <Keys keys={["⌘", "C"]} t={t} at={keyAt} />
      </div>
    </Feature>
  );
}

function ScenePaste({ t }: { t: number }) {
  const [s, e] = T.paste;
  const keyAt = s + 1.6;
  const pasted = t >= keyAt + 0.1;
  return (
    <Feature t={t} start={s} end={e} index={1} title={<>Paste on your other laptop</>} sub="Windows, Mac, Linux or a Chromebook. If it runs Chrome, it works." chip="Ctrl V">
      <div className="relative" style={rise(t, s + 0.2, 0.6, 40)}>
        <DeviceTag label="Home PC" t={t} at={s + 0.5} />
        <BrowserWindow url="mail.example.com/compose">
          <div className="font-work space-y-5 p-12 text-[24px]">
            <div className="flex gap-4 border-b border-line pb-4 text-muted">
              <span>To</span>
              <span className="text-ink">sam@example.com</span>
            </div>
            <div className="flex gap-4 border-b border-line pb-4 text-muted">
              <span>Subject</span>
              <span className="text-ink">Lunch today</span>
            </div>
            <div className="min-h-[200px] pt-2 text-[30px] text-ink">
              See you at{" "}
              <span style={{ background: pasted ? `rgba(169,216,242,${1 - prog(t, keyAt + 0.3, keyAt + 1.2)})` : undefined }}>
                {pasted ? SNIPPET : ""}
              </span>
              <span className="ml-0.5 inline-block h-9 w-[3px] translate-y-1.5 bg-ink" style={{ opacity: blink(t) }} />
            </div>
          </div>
        </BrowserWindow>
        <Keys keys={["Ctrl", "V"]} t={t} at={keyAt} />
      </div>
    </Feature>
  );
}

function ScenePhone({ t }: { t: number }) {
  const [s, e] = T.phone;
  const notifAt = s + 0.9;
  const pressAt = s + 2.9;
  const menu = easeOut(prog(t, pressAt + 0.5, pressAt + 0.75));
  const tapAt = pressAt + 1.0;
  const pasted = t >= tapAt + 0.1;
  const touch = (at: number, d = 0.5) => (t >= at && t < at + d ? prog(t, at, at + d) : 0);
  return (
    <Feature t={t} start={s} end={e} index={2} title={<>It&apos;s on your phone too</>} sub="Lands on your Android clipboard automatically. Just paste." chip="Android">
      <div className="relative flex items-center" style={rise(t, s + 0.2, 0.6, 40)}>
        <Phone>
          <Notification t={t} at={notifAt} title="Copied from Work MacBook" body={`${SNIPPET.length} characters are on your clipboard`} />
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
          {touch(tapAt, 0.4) > 0 ? (
            <span className="absolute h-12 w-12 rounded-full bg-brand/30" style={{ left: 38, top: 226, opacity: 1 - touch(tapAt, 0.4) }} />
          ) : null}
        </Phone>
      </div>
    </Feature>
  );
}

function SceneSend({ t }: { t: number }) {
  const [s, e] = T.send;
  const tapAt = s + 1.8;
  return (
    <Feature t={t} start={s} end={e} index={3} title={<>Send from your phone</>} sub="One tap in the app, the Share menu, or a Quick Settings tile." chip="Send my clipboard">
      <div className="relative" style={rise(t, s + 0.2, 0.6, 40)}>
        <Phone>
          <AppHome t={t} tapAt={tapAt} />
        </Phone>
      </div>
    </Feature>
  );
}

function SceneImages({ t }: { t: number }) {
  const [s, e] = T.images;
  const clickAt = s + 2.0;
  const copied = t >= clickAt + 0.15;
  const move = easeInOut(prog(t, s + 0.9, clickAt - 0.1));
  const cx = lerp(250, 348, move);
  const cy = lerp(420, 168, move);
  return (
    <Feature t={t} start={s} end={e} index={4} title={<>Images too</>} sub="Screenshots and photos arrive in the popup, one click to copy." chip="Copy image">
      <div className="relative" style={rise(t, s + 0.2, 0.6, 40)}>
        <BrowserWindow url="mail.example.com/compose" width={900} height={600}>
          <div className="space-y-4 p-10 opacity-60">
            <div className="h-6 w-1/3 rounded bg-line" />
            <DocLines widths={[50, 44, 38, 46, 30]} />
          </div>
        </BrowserWindow>
        <ZoomedPopup>
            <Popup>
              <Tabs active="Home" />
              <Card tone="accent">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Image from Android phone</CardTitle>
                    <Muted>Available until 3:42:10 PM</Muted>
                  </div>
                  <UiButton>Copy image</UiButton>
                </div>
              </Card>
              <SyncCard mode="both" />
              {copied ? (
                <div style={rise(t, clickAt + 0.15, 0.35, 10)}>
                  <Alert tone="success">Image copied. Paste it anywhere.</Alert>
                </div>
              ) : null}
            </Popup>
          <Cursor x={cx} y={cy} click={t >= clickAt ? prog(t, clickAt, clickAt + 0.5) : 0} />
        </ZoomedPopup>
      </div>
    </Feature>
  );
}

function SceneDevices({ t }: { t: number }) {
  const [s, e] = T.devices;
  const toHome = s + 2.2;
  const clickAt = s + 3.3;
  const mode = t >= clickAt + 0.1 ? "receive-only" : "both";
  const onHome = t >= toHome;
  const devices = [
    { badge: "WEB", name: "Work MacBook", meta: "Chrome · This device", current: true },
    { badge: "WEB", name: "Home PC", meta: "Chrome" },
    { badge: "AND", name: "Android phone", meta: "Android" },
  ];
  const move = easeInOut(prog(t, toHome, clickAt - 0.1));
  const cx = onHome ? lerp(330, 128, move) : 330;
  const cy = onHome ? lerp(380, 238, move) : 380;
  return (
    <Feature t={t} start={s} end={e} index={5} title={<>Every device, your rules</>} sub="See every device, remove one in a click, and choose what each one sends or receives." chip="Send & receive · Receive only · Paused">
      <div className="relative" style={rise(t, s + 0.2, 0.6, 40)}>
        <BrowserWindow url="notes.example.com/today" width={900} height={600}>
          <div className="space-y-4 p-10 opacity-60">
            <div className="h-6 w-1/3 rounded bg-line" />
            <DocLines widths={[50, 44, 38, 46, 30]} />
          </div>
        </BrowserWindow>
        <ZoomedPopup>
            {onHome ? (
              <Popup>
                <Tabs active="Home" />
                <SyncCard mode={mode} />
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
                      <li key={d.name} className="flex items-center justify-between gap-3 py-2.5" style={rise(t, s + 0.6 + i * 0.18, 0.4, 10)}>
                        <div className="flex items-center gap-3">
                          <span className="font-sora flex h-9 w-9 items-center justify-center rounded-xl bg-soft text-xs font-bold text-primary">
                            {d.badge}
                          </span>
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
          <Cursor x={cx} y={cy} click={t >= clickAt ? prog(t, clickAt, clickAt + 0.5) : 0} />
        </ZoomedPopup>
      </div>
    </Feature>
  );
}

function Privacy({ t }: { t: number }) {
  const [s, e] = T.privacy;
  return (
    <Center t={t} start={s} end={e}>
      <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-ink" style={rise(t, s + 0.1)}>
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" fill="#fff" stroke="none" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <h1 className="font-sora mt-10 text-[100px] leading-[1.05] font-bold tracking-[-0.04em] text-ink">
        <span className="block" style={rise(t, s + 0.3, 0.55, 40)}>
          Designed to protect
        </span>
        <span className="block" style={rise(t, s + 0.45, 0.55, 40)}>
          your privacy<span className="text-brand">.</span>
        </span>
      </h1>
      <p className="font-work mt-8 text-[30px] leading-[1.5] text-muted" style={rise(t, s + 0.6)}>
        End-to-end encrypted. The server can&apos;t read your clipboard.
        <br />
        No clipboard history. Nothing is kept.
      </p>
    </Center>
  );
}

function Outro({ t }: { t: number }) {
  const [s] = T.outro;
  if (t < s) return null;
  const v = easeOut(prog(t, s, s + 0.5));
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ opacity: v, filter: `blur(${(1 - v) * 14}px)` }}>
      <div className="flex items-center gap-8" style={rise(t, s + 0.1, 0.6, 30)}>
        <div className="flex h-[150px] w-[150px] items-center justify-center rounded-[38px] bg-surface shadow-[0_30px_80px_rgba(15,52,73,0.18)]">
          <Logo width={100} height={100} />
        </div>
        <span className="font-sora text-[120px] leading-none font-bold tracking-[-0.03em] text-ink">Copyyt</span>
      </div>
      <p className="font-sora mt-10 text-[40px] font-semibold text-ink" style={rise(t, s + 0.5)}>
        Copy on one device. <span className="text-primary">Paste on another.</span>
      </p>
      <p className="font-work mt-10 text-[34px] font-semibold text-brand" style={rise(t, s + 0.8)}>
        copyyt.com
      </p>
      <p className="font-work mt-3 text-[22px] text-muted" style={rise(t, s + 0.95)}>
        Chrome extension · Android app
      </p>
    </div>
  );
}

function Frame({ t }: { t: number }) {
  return (
    <main className="relative h-[1080px] w-[1920px] overflow-hidden text-ink">
      <Background t={t} />
      <Intro t={t} />
      <Hook t={t} />
      <Origin t={t} />
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
