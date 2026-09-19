import assert from "node:assert/strict";
import test from "node:test";
import {
  clipboardPayloadFromPlainText,
  clipboardPayloadFromPngBytes,
  type ClipboardPayloadV1,
} from "../clipboard/payload.ts";
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

function richPayload(plain: string, html: string): ClipboardPayloadV1 {
  return {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: plain },
      { mime: "text/html", encoding: "utf-8", data: html },
    ],
  };
}

function pngPayload(marker: number): ClipboardPayloadV1 {
  return clipboardPayloadFromPngBytes(
    new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      marker,
    ]),
  );
}

test("typed watcher observes image-only changes and suppresses identical PNGs", async () => {
  let clipboard = pngPayload(1);
  const changed: ClipboardPayloadV1[] = [];
  const timers = new FakeTimers();
  const watcher = new ClipboardWatcher({
    readPayload: () => clipboard,
    onPayloadChanged: (payload) => { changed.push(payload); },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });

  watcher.start();
  await flush();
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  clipboard = pngPayload(2);
  timers.tick();
  await flush();
  assert.deepEqual(changed, [clipboard]);

  timers.tick();
  await flush();
  assert.deepEqual(changed, [clipboard]);
  watcher.stop();
});

test("typed watcher treats image and text/html differences as meaningful", async () => {
  let clipboard: ClipboardPayloadV1 = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "same" },
      { mime: "text/html", encoding: "utf-8", data: "<b>same</b>" },
      ...pngPayload(1).representations,
    ],
  };
  const changed: ClipboardPayloadV1[] = [];
  const timers = new FakeTimers();
  const watcher = new ClipboardWatcher({
    readPayload: () => clipboard,
    onPayloadChanged: (payload) => { changed.push(payload); },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  watcher.start();
  await flush();

  clipboard = {
    version: 1,
    representations: [
      ...pngPayload(2).representations,
      { mime: "text/html", encoding: "utf-8", data: "<b>same</b>" },
      { mime: "text/plain", encoding: "utf-8", data: "same" },
    ],
  };
  timers.tick();
  await flush();
  assert.equal(changed.length, 1);

  clipboard = {
    version: 1,
    representations: [
      { mime: "text/plain", encoding: "utf-8", data: "same" },
      { mime: "text/html", encoding: "utf-8", data: "<i>changed</i>" },
      ...pngPayload(2).representations,
    ],
  };
  timers.tick();
  await flush();
  assert.equal(changed.length, 2);
  watcher.stop();
});

test("typed watcher establishes a rich baseline and emits plain or HTML changes", async () => {
  let clipboard = richPayload("same", "<b>same</b>");
  const changed: ClipboardPayloadV1[] = [];
  const timers = new FakeTimers();
  const watcher = new ClipboardWatcher({
    readPayload: () => clipboard,
    onPayloadChanged: (payload) => { changed.push(payload); },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });

  watcher.start();
  await flush();
  clipboard = richPayload("same", "<i>different</i>");
  timers.tick();
  await flush();
  clipboard = richPayload("different", "<i>different</i>");
  timers.tick();
  await flush();
  assert.deepEqual(changed, [
    richPayload("same", "<i>different</i>"),
    richPayload("different", "<i>different</i>"),
  ]);
  watcher.stop();
});

test("typed watcher ignores representation order and suppresses rich remote echoes", async () => {
  let clipboard = richPayload("baseline", "<b>baseline</b>");
  const changed: ClipboardPayloadV1[] = [];
  const timers = new FakeTimers();
  const watcher = new ClipboardWatcher({
    readPayload: () => clipboard,
    onPayloadChanged: (payload) => { changed.push(payload); },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  watcher.start();
  await flush();

  clipboard = {
    version: 1,
    representations: [
      { mime: "text/html", encoding: "utf-8", data: "<b>baseline</b>" },
      { mime: "text/plain", encoding: "utf-8", data: "baseline" },
    ],
  };
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  const remote = richPayload("remote", "<b>remote</b>");
  clipboard = remote;
  watcher.noteExternalWrite(remote);
  timers.tick();
  await flush();
  assert.deepEqual(changed, []);

  clipboard = clipboardPayloadFromPlainText("human copy");
  timers.tick();
  await flush();
  assert.deepEqual(changed, [clipboard]);
  watcher.stop();
});

test("typed watcher discards an invalidated asynchronous rich read", async () => {
  let release!: (payload: ClipboardPayloadV1) => void;
  const pending = new Promise<ClipboardPayloadV1>((resolve) => {
    release = resolve;
  });
  const timers = new FakeTimers();
  const changed: ClipboardPayloadV1[] = [];
  const watcher = new ClipboardWatcher({
    readPayload: () => pending,
    onPayloadChanged: (payload) => { changed.push(payload); },
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  watcher.start();
  watcher.stop();
  release(richPayload("stale", "<b>stale</b>"));
  await flush();
  assert.deepEqual(changed, []);
});
