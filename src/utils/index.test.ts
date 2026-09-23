import assert from "node:assert/strict";
import test from "node:test";
import { checkJwtExpiry } from "./index.ts";

test("malformed JWTs are treated as expired", () => {
  assert.equal(checkJwtExpiry("not-a-jwt"), false);
  assert.equal(checkJwtExpiry(""), false);
});

