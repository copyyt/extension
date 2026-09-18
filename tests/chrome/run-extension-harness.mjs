import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const keyPersistence = spawnSync("yarn", ["test:chrome:keys"], { stdio: "inherit" });
const keyPersistenceFailed = keyPersistence.status !== 0;
if (keyPersistenceFailed) {
  console.error(
    "Chrome key-persistence harness did not complete; this is separate from clipboard evidence, so the extension harness will still run.",
  );
}

const build = spawnSync("yarn", ["build"], {
  env: { ...process.env, VITE_APP_TYPE: "extension" },
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error("Chrome 137+ is required. Set CHROME_BIN to the browser executable.");
  process.exit(1);
}

const port = 9224;
const extensionPath = resolve("build-extension");
const headless = process.env.COPYYT_CHROME_HEADLESS !== "0";
const chromeProcess = spawn(
  chrome,
  [
    ...(headless ? ["--headless=new"] : []),
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-logging=stderr",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/private/tmp/copyyt-runtime-chrome-${process.pid}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let chromeStderr = "";
chromeProcess.stderr?.on("data", (chunk) => { chromeStderr += chunk.toString(); });

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function waitForTargets() {
  let lastTargets = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const value = await targets();
      lastTargets = value;
      const page = value.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return { page };
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for a Chrome page: ${JSON.stringify(lastTargets)}${chromeStderr ? `\nChrome: ${chromeStderr}` : ""}`);
}

function extensionId() {
  const manifest = JSON.parse(readFileSync(`${extensionPath}/manifest.json`, "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  return digest.slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

function connectDevTools(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const command = async (method, params = {}) => {
    await opened;
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  };
  return { command, close: () => socket.close() };
}

let devTools;
let browserDevTools;
try {
  const { page } = await waitForTargets();
  const id = extensionId();
  devTools = connectDevTools(page.webSocketDebuggerUrl);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browserDevTools = connectDevTools(version.webSocketDebuggerUrl);
  await devTools.command("Runtime.enable");
  await devTools.command("Page.enable");
  const navigation = await devTools.command("Page.navigate", {
    url: `chrome-extension://${id}/runtime-harness.html`,
  });
  if (navigation.errorText) {
    throw new Error(
      `Extension harness navigation failed: ${navigation.errorText}. Chrome did not expose the unpacked extension page; this is a browser/launch limitation, not a clipboard result.`,
    );
  }
  let status = "RUNNING";
  let pageUrl = "unknown";
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const evaluation = await devTools.command("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, output: document.querySelector('#output')?.textContent || 'MISSING'})",
      returnByValue: true,
    });
    const state = JSON.parse(evaluation.result?.value || '{"output":"MISSING"}');
    pageUrl = state.url;
    status = state.output;
    if (status.startsWith("PASS") || status.startsWith("FAIL")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.stdout.write(`${status}${status === "MISSING" ? `\npage=${pageUrl}` : ""}\n`);
  if (status.startsWith("PASS")) {
    const targetState = await browserDevTools.command("Target.getTargets");
    const worker = targetState.targetInfos.find(
      (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`),
    );
    if (!worker) throw new Error("The Copyyt service worker was not discoverable after the clipboard test");
    await browserDevTools.command("Target.closeTarget", { targetId: worker.targetId });
    const restarted = await devTools.command("Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage({source: "popup", target: "service-worker", requestId: crypto.randomUUID(), command: {type: "runtime:test-clipboard", marker: "copyyt-restart-harness"}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!restarted.result?.value?.ok || !restarted.result.value.data?.readText) {
      throw new Error("The clipboard adapter did not reconstruct after service-worker restart");
    }
  } else {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  devTools?.close();
  browserDevTools?.close();
  chromeProcess.kill("SIGTERM");
}

if (keyPersistenceFailed && process.exitCode === undefined) process.exitCode = keyPersistence.status ?? 1;
