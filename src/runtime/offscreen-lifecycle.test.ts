import assert from "node:assert/strict";
import test from "node:test";
import { ensureOffscreenDocument } from "./offscreen-lifecycle.ts";

test("offscreen document creation is concurrency-safe", async () => {
  let exists = false;
  let creates = 0;
  let reasons: unknown[] = [];
  const api = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () =>
        exists ? [{ documentUrl: "chrome-extension://test/offscreen.html" }] : [],
    },
    offscreen: {
      hasDocument: async () => exists,
      createDocument: async (details: { reasons: unknown[] }) => {
        creates += 1;
        reasons = details.reasons;
        await Promise.resolve();
        exists = true;
      },
    },
  } as never;

  await Promise.all([ensureOffscreenDocument(api), ensureOffscreenDocument(api)]);
  assert.equal(creates, 1);
  assert.deepEqual(reasons, ["CLIPBOARD", "WEB_RTC"]);
  await ensureOffscreenDocument(api);
  assert.equal(creates, 1);
});
