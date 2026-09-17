import assert from "node:assert/strict";
import test from "node:test";
import {
  createOffscreenClipboardWatcher,
  type OffscreenWatcherDependencies,
} from "./offscreen-watcher.ts";

class FakeTimers {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();

  setInterval(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearInterval(handle: number): void {
    this.callbacks.delete(handle);
  }

  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("offscreen observation uses a receiver-safe runtime.sendMessage wrapper", async () => {
  let clipboard = "baseline";
  const observations: unknown[] = [];
  const timers = new FakeTimers();
  const runtime = {
    sendMessage(message: unknown): Promise<void> {
      if (this !== runtime) throw new TypeError("Illegal invocation");
      observations.push(message);
      return Promise.resolve();
    },
  };
  const watcherDependencies: OffscreenWatcherDependencies = {
    readText: () => clipboard,
    runtime,
    setIntervalFn: (handler) =>
      timers.setInterval(handler) as unknown as ReturnType<
        typeof globalThis.setInterval
      >,
    clearIntervalFn: (handle) =>
      timers.clearInterval(handle as unknown as number),
  };
  const watcher = createOffscreenClipboardWatcher(watcherDependencies);

  watcher.start();
  await flush();
  clipboard = "changed";
  timers.tick();
  await flush();

  assert.deepEqual(observations, [
    {
      source: "offscreen",
      target: "service-worker",
      type: "CLIPBOARD_CHANGED",
      text: "changed",
    },
  ]);
  watcher.stop();
});
