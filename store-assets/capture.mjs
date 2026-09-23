// Captures the Chrome Web Store screenshots (1280x800 PNG) and promo tiles with headless Chrome.
// Start the dev server first: node_modules/.bin/vite --port 5175
// Then: node store-assets/capture.mjs [baseUrl]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const baseUrl = process.argv[2] ?? "http://localhost:5175";
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const names = ["1-sync", "2-security", "3-pairing", "4-images", "5-devices"];

// Chromium's preferredColorScheme: 0 = dark, 1 = light.
for (const [theme, scheme] of [["light", 1], ["dark", 0]]) {
  const outDir = path.resolve("store-assets/screenshots", theme);
  mkdirSync(outDir, { recursive: true });
  names.forEach((name, index) => {
  const file = path.join(outDir, `${name}.png`);
  execFileSync(chrome, [
    "--headless=new",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1280,800",
    "--virtual-time-budget=5000",
    `--blink-settings=preferredColorScheme=${scheme}`,
    `--screenshot=${file}`,
    `${baseUrl}/store-assets/screenshots.html?shot=${index + 1}`,
  ], { stdio: "ignore" });
  console.log(file);
  });
}

// Promo tiles use the light palette only.
const tilesDir = path.resolve("store-assets/promo");
mkdirSync(tilesDir, { recursive: true });
for (const [shot, name, size] of [[6, "small-tile-440x280", "440,280"], [7, "marquee-1400x560", "1400,560"]]) {
  const file = path.join(tilesDir, `${name}.png`);
  execFileSync(chrome, [
    "--headless=new",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${size}`,
    "--virtual-time-budget=5000",
    "--blink-settings=preferredColorScheme=1",
    `--screenshot=${file}`,
    `${baseUrl}/store-assets/screenshots.html?shot=${shot}`,
  ], { stdio: "ignore" });
  console.log(file);
}
