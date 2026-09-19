import { RuntimeError } from "./errors.ts";

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_JUSTIFICATION =
  "Copyyt needs clipboard access and WebRTC for direct encrypted device-to-device transfers.";

type ChromeOffscreenApi = Pick<typeof chrome, "runtime" | "offscreen">;

let creationPromise: Promise<void> | null = null;

async function hasOffscreenDocument(api: ChromeOffscreenApi): Promise<boolean> {
  const url = api.runtime.getURL(OFFSCREEN_PATH);
  if (typeof api.runtime.getContexts === "function") {
    const contexts = await api.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [url],
    });
    return contexts.some((context) => context.documentUrl === url);
  }
  // This is only a compatibility fallback. Chrome 137+ takes the getContexts path.
  return api.offscreen.hasDocument();
}

export async function ensureOffscreenDocument(
  api: ChromeOffscreenApi = chrome,
): Promise<void> {
  if (await hasOffscreenDocument(api)) {
    return;
  }
  if (!creationPromise) {
    creationPromise = (async () => {
      if (await hasOffscreenDocument(api)) return;
      try {
        await api.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: [
            "CLIPBOARD" as chrome.offscreen.Reason,
            "WEB_RTC" as chrome.offscreen.Reason,
          ],
          justification: OFFSCREEN_JUSTIFICATION,
        });
      } catch {
        // A second event can race from another API turn. Re-check before
        // surfacing the error rather than creating a second document.
        if (!(await hasOffscreenDocument(api))) {
          throw new RuntimeError(
            "CLIPBOARD_READ_FAILED",
            "Unable to create the Copyyt clipboard adapter",
          );
        }
      }
    })().finally(() => {
      creationPromise = null;
    });
  }
  await creationPromise;
}

export const OFFSCREEN_DOCUMENT_PATH = OFFSCREEN_PATH;
