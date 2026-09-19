import { clipboardPayloadFromPngBytes } from "./payload.ts";

type ClipboardPageNavigator = Navigator & {
  clipboard?: Clipboard;
};

function assertFocusedExtensionPage(): void {
  const page = globalThis.document;
  if (!page || page.location.protocol !== "chrome-extension:") {
    throw new Error(
      "PNG clipboard writing requires a focused Copyyt extension page",
    );
  }
  if (
    page.visibilityState !== "visible" ||
    typeof page.hasFocus !== "function" ||
    !page.hasFocus()
  ) {
    throw new Error(
      "PNG clipboard writing requires a visible, focused extension page",
    );
  }
}

function getPageClipboard(): Clipboard {
  const pageNavigator = (globalThis as typeof globalThis & {
    navigator?: ClipboardPageNavigator;
  }).navigator;
  if (!pageNavigator?.clipboard) {
    throw new Error("The focused extension page has no Clipboard API");
  }
  if (typeof pageNavigator.clipboard.write !== "function") {
    throw new Error(
      "The focused extension page has no navigator.clipboard.write()",
    );
  }
  return pageNavigator.clipboard;
}

function getClipboardItemConstructor(): typeof ClipboardItem {
  const constructor = (
    globalThis as typeof globalThis & {
      ClipboardItem?: typeof ClipboardItem;
    }
  ).ClipboardItem;
  if (typeof constructor !== "function") {
    throw new Error("ClipboardItem is unavailable in this extension page");
  }
  return constructor;
}

/**
 * Write one validated PNG to the native clipboard from a visible, focused
 * Copyyt extension page. This helper is intentionally not imported by the
 * service worker or the MV3 offscreen document.
 */
export async function writePngToFocusedClipboard(
  pngBytes: Uint8Array,
): Promise<void> {
  assertFocusedExtensionPage();
  const clipboard = getPageClipboard();
  const ClipboardItemConstructor = getClipboardItemConstructor();

  // Reuse the local payload validator so the experiment accepts only bounded
  // Copyyt PNG bytes with the expected signature before touching the clipboard.
  clipboardPayloadFromPngBytes(pngBytes);

  const blob = new Blob([pngBytes], {
    type: "image/png",
  });
  const item = new ClipboardItemConstructor({
    "image/png": blob,
  });

  try {
    await clipboard.write([item]);
  } catch (error) {
    throw new Error(
      `Chrome rejected the focused PNG clipboard write: ${
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"
      }`,
    );
  }
}

/**
 * Optional, best-effort read-back for the focused-page experiment. A null
 * result means read-back is unavailable or was rejected; it never changes
 * whether the preceding write is considered successful.
 */
export async function focusedClipboardHasPng(): Promise<boolean | null> {
  assertFocusedExtensionPage();
  const clipboard = getPageClipboard();
  if (typeof clipboard.read !== "function") return null;

  try {
    const items = await clipboard.read();
    return items.some((item) => item.types.includes("image/png"));
  } catch {
    return null;
  }
}
