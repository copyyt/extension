import {
  OFFSCREEN_SOURCE,
  RUNTIME_SOURCE,
  type OffscreenClipboardObservation,
} from "./messages.ts";
import {
  ClipboardWatcher,
  type ClipboardClearInterval,
  type ClipboardSetInterval,
  type ClipboardWatcherOptions,
} from "./clipboard-watcher.ts";

export interface OffscreenWatcherDependencies {
  readText: ClipboardWatcherOptions["readText"];
  runtime: {
    sendMessage(message: OffscreenClipboardObservation): Promise<unknown>;
  };
  intervalMs?: number;
  setIntervalFn?: ClipboardSetInterval;
  clearIntervalFn?: ClipboardClearInterval;
  onError?: (error: unknown) => void;
}

/**
 * Creates the offscreen observer and keeps the Chrome runtime method attached
 * to its runtime object. Chrome native methods reject detached invocation.
 */
export function createOffscreenClipboardWatcher(
  dependencies: OffscreenWatcherDependencies,
): ClipboardWatcher {
  const sendMessage = (message: OffscreenClipboardObservation) =>
    dependencies.runtime.sendMessage(message);

  return new ClipboardWatcher({
    readText: dependencies.readText,
    intervalMs: dependencies.intervalMs,
    setIntervalFn: dependencies.setIntervalFn,
    clearIntervalFn: dependencies.clearIntervalFn,
    onChanged: (text) => {
      const observation: OffscreenClipboardObservation = {
        source: OFFSCREEN_SOURCE,
        target: RUNTIME_SOURCE,
        type: "CLIPBOARD_CHANGED",
        text,
      };
      // The service worker validates the observation and waits for its
      // startup promise before handling it. Delivery is intentionally
      // fire-and-forget, but the rejection is explicitly consumed.
      void sendMessage(observation).catch(() => undefined);
    },
    onError: dependencies.onError,
  });
}
