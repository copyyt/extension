// Records store-assets/promo-video.html frame by frame with headless Chrome.
// 1. node_modules/.bin/vite build --config store-assets/vite.promo.config.ts --outDir <build>
// 2. node store-assets/capture-video.mjs <build>/promo-video.html out.mp4 [--fps 30] [--scheme dark] [--stills 1.5,8,20 --dir shots]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [page, out] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const fps = Number(flag("--fps", "30"));
const stills = flag("--stills", null)?.split(",").map(Number);
const stillsDir = flag("--dir", "shots");
const scheme = flag("--scheme", "light");
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(path.join(tmpdir(), "copyyt-capture-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--hide-scrollbars",
  "--allow-file-access-from-files",
  "--force-device-scale-factor=1",
  "--window-size=1920,1080",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;
for (let i = 0; i < 100 && !port; i++) {
  try {
    port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  } catch {
    await sleep(100);
  }
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 0;
const pending = new Map();
const listeners = new Map();
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method && listeners.has(msg.method)) {
    listeners.get(msg.method)(msg.params);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
const loaded = new Promise((r) => listeners.set("Page.loadEventFired", r));
await send("Page.navigate", { url: `${pathToFileURL(path.resolve(page)).href}?capture` });
await loaded;
while (!(await evaluate("typeof window.__seek === 'function'"))) await sleep(100);
await evaluate("document.fonts.ready.then(() => true)");
await sleep(500);

const shot = async (t, format) => {
  await evaluate(`window.__seek(${t})`);
  const { data } = await send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 94 } : {}) });
  return Buffer.from(data, "base64");
};

if (stills) {
  mkdirSync(stillsDir, { recursive: true });
  for (const t of stills) {
    const file = path.join(stillsDir, `t${t}.png`);
    writeFileSync(file, await shot(t, "png"));
    console.log(file);
  }
} else {
  const duration = await evaluate("window.__duration");
  const frames = Math.round(duration * fps);
  const ffmpeg = spawn("ffmpeg", [
    "-v", "error", "-y",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < frames; i++) {
    const buf = await shot(i / fps, "jpeg");
    if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % fps === 0) process.stdout.write(`\r${(i / fps).toFixed(0)}s / ${duration}s`);
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on("close", r));
  console.log(`\n${out}`);
}

ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
