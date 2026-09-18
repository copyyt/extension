import assert from "node:assert/strict";
import test from "node:test";
import { sendRuntimeCommand } from "./client.ts";
import type { RuntimeRequest, RuntimeResponse } from "./messages.ts";

type ChromeRuntimeStub = {
  sendMessage: (message: RuntimeRequest) => Promise<unknown>;
};

const globalWithChrome = globalThis as unknown as {
  chrome?: { runtime: ChromeRuntimeStub };
};

function installSendMessage(
  sendMessage: ChromeRuntimeStub["sendMessage"],
): void {
  globalWithChrome.chrome = { runtime: { sendMessage } };
}

function okResponse(message: RuntimeRequest): RuntimeResponse {
  return {
    source: "service-worker",
    target: "popup",
    requestId: message.requestId,
    ok: true,
    data: { ok: true },
  };
}

test("runtime status gets one retry after a transient worker restart error", async () => {
  let calls = 0;
  installSendMessage(async (message) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return okResponse(message);
  });

  const result = await sendRuntimeCommand({ type: "runtime:get-status" });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("passwordless auth is never retried after a transient worker restart error", async () => {
  let calls = 0;
  installSendMessage(async () => {
    calls += 1;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });

  await assert.rejects(
    sendRuntimeCommand({
      type: "runtime:auth-passwordless",
      email: "test@example.com",
    }),
  );
  assert.equal(calls, 1);
});

test("token refresh is never retried after a transient worker restart error", async () => {
  let calls = 0;
  installSendMessage(async () => {
    calls += 1;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });

  await assert.rejects(
    sendRuntimeCommand({ type: "runtime:auth-refresh" }),
  );
  assert.equal(calls, 1);
});

test("OTP verification is never retried after a transient worker restart error", async () => {
  let calls = 0;
  installSendMessage(async () => {
    calls += 1;
    throw new Error("The message port closed before a response was received.");
  });

  await assert.rejects(
    sendRuntimeCommand({
      type: "runtime:auth-verify-email",
      email: "test@example.com",
      code: 123456,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AUTH_REQUIRED",
  );
  assert.equal(calls, 1);
});

test("non-idempotent clipboard commands are not retried", async () => {
  let calls = 0;
  installSendMessage(async () => {
    calls += 1;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });

  await assert.rejects(
    sendRuntimeCommand({ type: "runtime:send-current-clipboard" }),
  );
  assert.equal(calls, 1);
});
