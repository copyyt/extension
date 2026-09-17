import assert from "node:assert/strict";
import test from "node:test";
import { ClipboardWatcher } from "./clipboard-watcher.ts";

class FakeTimers {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();

  setInterval = ((callback: () => void) => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval;

  clearInterval = ((handle: ReturnType<typeof globalThis.setInterval>) => {
    this.callbacks.delete(handle as unknown as number);
  }) as typeof globalThis.clearInterval;

  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeWatcher(
  readText: () => string | Promise<string>,
  changed: string[],
): { watcher: ClipboardWatcher; timers: FakeTimers } {
  const timers = new FakeTimers();
  const watcher = new ClipboardWatcher({
    readText,
    onChanged: (text) => {
      changed.push(text);
    },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  return { watcher, timers };
}

test("first watcher sample establishes a baseline without emitting", async () => {
  const clipboard = "first";
  const changed: string[] = [];
  const { watcher } = makeWatcher(() => clipboard, changed);

  watcher.start();
  await flush();
  assert.deepEqual(changed, []);
  watcher.stop();
});

test("unchanged clipboard does not emit and a changed value emits once", async () => {
  let clipboard = "same";
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => clipboard, changed);

  watcher.start();
  await flush();
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  clipboard = "changed";
  timers.tick();
  await flush();
  timers.tick();
  await flush();
  assert.deepEqual(changed, ["changed"]);
  watcher.stop();
});

test("empty clipboard changes update the baseline but are ignored", async () => {
  let clipboard = "non-empty";
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => clipboard, changed);

  watcher.start();
  await flush();
  clipboard = "";
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  clipboard = "next";
  timers.tick();
  await flush();
  assert.deepEqual(changed, ["next"]);
  watcher.stop();
});

test("polling never overlaps reads", async () => {
  let release!: () => void;
  const readGate = new Promise<string>((resolve) => {
    release = () => resolve("baseline");
  });
  let reads = 0;
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => {
    reads += 1;
    return readGate;
  }, changed);

  watcher.start();
  timers.tick();
  assert.equal(reads, 1);
  release();
  await flush();
  assert.equal(reads, 1);
  watcher.stop();
});

test("WATCH_START is idempotent and WATCH_STOP cancels future polling", async () => {
  let clipboard = "before";
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => clipboard, changed);

  watcher.start();
  watcher.start();
  assert.equal(timers.callbacks.size, 1);
  await flush();
  watcher.stop();
  clipboard = "after";
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);
});

test("a remote write updates the baseline and suppresses its echo", async () => {
  let clipboard = "local";
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => clipboard, changed);

  watcher.start();
  await flush();
  clipboard = "remote";
  watcher.noteExternalWrite("remote");
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  clipboard = "human copy";
  timers.tick();
  await flush();
  assert.deepEqual(changed, ["human copy"]);
  watcher.stop();
});

test("a recreated watcher baselines the existing clipboard without emitting", async () => {
  const changed: string[] = [];
  const { watcher, timers } = makeWatcher(() => "already-present", changed);

  watcher.start();
  await flush();
  watcher.stop();

  const recreated = makeWatcher(() => "already-present", changed);
  recreated.watcher.start();
  await flush();
  recreated.timers.tick();
  await flush();
  assert.deepEqual(changed, []);
  recreated.watcher.stop();
  void timers;
});

test("default timer wrappers preserve the global receiver", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const strictSetInterval = function (
    this: typeof globalThis,
    handler: TimerHandler,
    timeout?: number,
  ): number {
    void handler;
    void timeout;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return 1;
  } as typeof globalThis.setInterval;
  const strictClearInterval = function (
    this: typeof globalThis,
    id: ReturnType<typeof globalThis.setInterval>,
  ): void {
    void id;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
  } as typeof globalThis.clearInterval;

  globalThis.setInterval = strictSetInterval;
  globalThis.clearInterval = strictClearInterval;
  try {
    const watcher = new ClipboardWatcher({
      readText: () => "baseline",
      onChanged: () => undefined,
    });
    watcher.start();
    await flush();
    watcher.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("polling failures cannot become unhandled Promise rejections", async () => {
  const timers = new FakeTimers();
  let errorReports = 0;
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);

  const watcher = new ClipboardWatcher({
    readText: async () => {
      throw new Error("clipboard read failed");
    },
    onChanged: () => undefined,
    onError: () => {
      errorReports += 1;
      throw new Error("error reporter failed");
    },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });

  watcher.start();
  await flush();
  timers.tick();
  await flush();
  watcher.stop();
  await flush();
  process.off("unhandledRejection", onUnhandled);

  assert.equal(errorReports, 2);
  assert.equal(unhandled, undefined);
});
