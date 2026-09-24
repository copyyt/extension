import { base64ToBytes } from "./crypto/bytes.ts";
import {
  focusedClipboardHasPng,
  writePngToFocusedClipboard,
} from "./clipboard/focused-page-writer.ts";

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const testPngBytes = base64ToBytes(TEST_PNG_BASE64);

const button = document.querySelector<HTMLButtonElement>("#copy-test-png");
const status = document.querySelector<HTMLOutputElement>("#status");
const clipboardItemSupport = document.querySelector<HTMLOutputElement>(
  "#clipboard-item-support",
);
const readBack = document.querySelector<HTMLOutputElement>("#read-back");
const output = document.querySelector<HTMLElement>("#output");

if (!button || !status || !clipboardItemSupport || !readBack || !output) {
  throw new Error("PNG clipboard experiment UI is incomplete");
}

clipboardItemSupport.textContent =
  typeof globalThis.ClipboardItem === "function" ? "Available" : "Unavailable";

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Writing…";
  readBack.textContent = "Checking…";
  output.textContent = "RUNNING";

  try {
    await writePngToFocusedClipboard(testPngBytes);

    let readBackResult: boolean | null = null;
    try {
      readBackResult = await focusedClipboardHasPng();
    } catch {
      // A successful write remains successful when optional read-back is not
      // available or loses its separate permission.
    }
    readBack.textContent =
      readBackResult === true
        ? "Yes"
        : readBackResult === false
          ? "No"
          : "Unavailable or rejected";
    status.textContent = "Success";
    output.textContent = `PASS\nClipboardItem: ${clipboardItemSupport.textContent}\nwrite(): resolved\nread(): ${readBack.textContent}`;
  } catch (error) {
    status.textContent = "Failed";
    readBack.textContent = "Not tested";
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown clipboard error";
    output.textContent = `FAIL\n${message}`;
  } finally {
    button.disabled = false;
  }
});
