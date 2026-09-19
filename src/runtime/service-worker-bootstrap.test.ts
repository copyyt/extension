import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeMessageListener,
  type RuntimeMessageSender,
} from "./service-worker-bootstrap.ts";
import {
  isOffscreenClipboardObservation,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./messages.ts";

function request(command: RuntimeRequest["command"]): RuntimeRequest {
  return {
    source: "popup",
    target: "service-worker",
    requestId: "request-1",
    command,
  };
}

function response(message: RuntimeRequest): RuntimeResponse {
  return {
    source: "service-worker",
    target: "popup",
    requestId: message.requestId,
    ok: true,
    data: { handled: true },
  };
}

const sender: RuntimeMessageSender = {
  id: "extension-id",
  url: "chrome-extension://extension-id/popup.html",
};

test("a message arriving during startup waits and executes after startup resolves", async () => {
  let releaseStartup!: () => void;
  const startup = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  let handled = false;
  let received: RuntimeResponse | undefined;
  const message = request({ type: "runtime:auth-passwordless", email: "test@example.com" });
  const listener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async (value) => {
        assert.equal(value, message);
        handled = true;
        return response(message);
      },
    },
    runtimeReady: startup,
    getStartupError: () => null,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });

  assert.equal(listener(message, sender, (value) => { received = value; }), true);
  await Promise.resolve();
  assert.equal(handled, false);
  assert.equal(received, undefined);

  releaseStartup();
  await startup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, true);
  assert.deepEqual(received, response(message));
});

test("startup rejection returns a structured runtime error and keeps the channel alive", async () => {
  let startupError: unknown = null;
  const startup = Promise.resolve().then(() => {
    startupError = new Error("bootstrap failed");
  });
  let received: RuntimeResponse | undefined;
  const message = request({ type: "runtime:auth-passwordless", email: "test@example.com" });
  const listener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async () => {
        throw new Error("must not execute after failed startup");
      },
    },
    runtimeReady: startup,
    getStartupError: () => startupError,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });

  assert.equal(listener(message, sender, (value) => { received = value; }), true);
  await startup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, {
    source: "service-worker",
    target: "popup",
    requestId: message.requestId,
    ok: false,
    error: {
      code: "RUNTIME_START_FAILED",
      message: "The Copyyt service worker could not start",
    },
  });
});

test("concurrent messages share one startup promise", async () => {
  let startCalls = 0;
  let releaseStartup!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    startCalls += 1;
    releaseStartup = resolve;
  });
  let responses = 0;
  const listener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async (value) => response(value as RuntimeRequest),
    },
    runtimeReady,
    getStartupError: () => null,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });

  const first = request({ type: "runtime:get-status" });
  const second = request({ type: "runtime:auth-passwordless", email: "test@example.com" });
  assert.equal(listener(first, sender, () => { responses += 1; }), true);
  assert.equal(listener(second, sender, () => { responses += 1; }), true);
  assert.equal(startCalls, 1);
  releaseStartup();
  await runtimeReady;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses, 2);
});

test("offscreen clipboard observations wait for startup and use the packaged sender context", async () => {
  let releaseStartup!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  const observations: unknown[] = [];
  const listener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async () => response(request({ type: "runtime:get-status" })),
      handleClipboardObservation: async (message) => {
        observations.push(message);
      },
    },
    runtimeReady,
    getStartupError: () => null,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });
  const observation = {
    source: "offscreen" as const,
    target: "service-worker" as const,
    type: "CLIPBOARD_CHANGED" as const,
    text: "clipboard value",
  };

  assert.equal(
    listener(
      observation,
      { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" },
      () => undefined,
    ),
    true,
  );
  await Promise.resolve();
  assert.deepEqual(observations, []);
  releaseStartup();
  await runtimeReady;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observations, [observation]);
});

test("offscreen observations from another extension page or id are rejected", async () => {
  const observations: unknown[] = [];
  const listener = createRuntimeMessageListener({
    runtime: {
      handleMessage: async () => response(request({ type: "runtime:get-status" })),
      handleClipboardObservation: (message) => {
        observations.push(message);
      },
    },
    runtimeReady: Promise.resolve(),
    getStartupError: () => null,
    runtimeId: "extension-id",
    extensionUrl: "chrome-extension://extension-id/",
  });
  const observation = {
    source: "offscreen" as const,
    target: "service-worker" as const,
    type: "CLIPBOARD_CHANGED" as const,
    text: "must not dispatch",
  };

  assert.equal(
    listener(
      observation,
      { id: "extension-id", url: "chrome-extension://extension-id/popup.html" },
      () => undefined,
    ),
    false,
  );
  assert.equal(
    listener(
      observation,
      { id: "different-extension", url: "chrome-extension://extension-id/offscreen.html" },
      () => undefined,
    ),
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observations, []);
});

test("offscreen clipboard observations enforce the typed legacy-or-payload union", () => {
  const payload = {
    version: 1 as const,
    representations: [
      { mime: "text/plain" as const, encoding: "utf-8" as const, data: "Copyyt" },
    ],
  };
  const base = {
    source: "offscreen" as const,
    target: "service-worker" as const,
    type: "CLIPBOARD_CHANGED" as const,
  };
  assert.equal(isOffscreenClipboardObservation({ ...base, payload }), true);
  assert.equal(isOffscreenClipboardObservation({ ...base, text: "Copyyt" }), true);
  assert.equal(isOffscreenClipboardObservation({ ...base, text: "Copyyt", payload }), false);
  assert.equal(isOffscreenClipboardObservation(base), false);
  assert.equal(
    isOffscreenClipboardObservation({ ...base, payload: { version: 1, representations: [] } }),
    false,
  );
});
