import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWebAccessToken,
  getWebAccessToken,
  setWebAccessToken,
} from "./web-session.ts";

test("web access tokens are held in memory and can be cleared", () => {
  clearWebAccessToken();
  assert.equal(getWebAccessToken(), null);

  setWebAccessToken("short-lived-access-token");
  assert.equal(getWebAccessToken(), "short-lived-access-token");

  clearWebAccessToken();
  assert.equal(getWebAccessToken(), null);
});

test("web access token storage rejects blank tokens", () => {
  assert.throws(() => setWebAccessToken("  "), TypeError);
});

