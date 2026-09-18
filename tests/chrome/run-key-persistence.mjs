import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

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

const vite = spawn("yarn", ["vite", "--host", "127.0.0.1", "--port", "5174"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const chromeProcess = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=9223",
    `--user-data-dir=/private/tmp/copyyt-chrome-${process.pid}`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

async function waitForJsonTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:9223/json/list");
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chrome DevTools Protocol");
}

function connectDevTools(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    }
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

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch("http://127.0.0.1:5174/tests/chrome/key-persistence.html");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const devTools = connectDevTools(await waitForJsonTarget());
  await devTools.command("Runtime.enable");
  await devTools.command("Page.enable");
  await devTools.command("Page.navigate", {
    url: "http://127.0.0.1:5174/tests/chrome/key-persistence.html",
  });
  let status = "RUNNING";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const evaluation = await devTools.command("Runtime.evaluate", {
      expression: "document.querySelector('#output')?.textContent || 'MISSING'",
      returnByValue: true,
    });
    status = evaluation.result?.value || "MISSING";
    if (status.startsWith("PASS") || status.startsWith("FAIL")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const domResult = await devTools.command("Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
    returnByValue: true,
  });
  process.stdout.write(domResult.result?.value || status);
  devTools.close();
  if (!status.startsWith("PASS")) {
    process.exitCode = 1;
  }
} finally {
  vite.kill("SIGTERM");
  chromeProcess.kill("SIGTERM");
}
