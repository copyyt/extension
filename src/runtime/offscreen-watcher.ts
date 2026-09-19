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
import type { ClipboardPayloadV1 } from "../clipboard/payload.ts";

export interface OffscreenWatcherDependencies {
  readText?: ClipboardWatcherOptions["readText"];
  readPayload?: ClipboardWatcherOptions["readPayload"];
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
    ...(dependencies.readPayload
      ? { readPayload: dependencies.readPayload }
      : { readText: dependencies.readText }),
    intervalMs: dependencies.intervalMs,
    setIntervalFn: dependencies.setIntervalFn,
    clearIntervalFn: dependencies.clearIntervalFn,
    ...(dependencies.readPayload
      ? {
          onPayloadChanged: (payload: ClipboardPayloadV1) => {
            const observation: OffscreenClipboardObservation = {
              source: OFFSCREEN_SOURCE,
              target: RUNTIME_SOURCE,
              type: "CLIPBOARD_CHANGED",
              payload,
            };
            void sendMessage(observation).catch(() => undefined);
          },
        }
      : {
          onChanged: (text: string) => {
            const observation: OffscreenClipboardObservation = {
              source: OFFSCREEN_SOURCE,
              target: RUNTIME_SOURCE,
              type: "CLIPBOARD_CHANGED",
              text,
            };
            void sendMessage(observation).catch(() => undefined);
          },
        }),
    onError: dependencies.onError,
  });
}
