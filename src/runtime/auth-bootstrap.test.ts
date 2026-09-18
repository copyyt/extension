import assert from "node:assert/strict";
import test from "node:test";
import type { IUser } from "../interfaces/user.interface.ts";
import {
  bootstrapExtensionAuth,
  resolveExtensionAuth,
  shouldRefreshWebAuth,
} from "../hocs/auth-bootstrap.ts";
import type { RuntimeStatus } from "./messages.ts";

const user: IUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
};

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    connectionState: "signed-out",
    signedIn: false,
    device: {
      registration: "unknown",
      trustState: "unknown",
    },
    socket: {
      connected: false,
      deviceAuthenticated: false,
    },
    syncReady: false,
    syncPreferences: {
      schemaVersion: 1,
      sendEnabled: true,
      receiveEnabled: true,
    },
    onboarding: {
      state: "unknown",
      bootstrapEligible: false,
    },
    ...overrides,
  };
}

test("signed-out extension runtime goes directly to sign-in", () => {
  assert.deepEqual(resolveExtensionAuth(status()), {
    authenticated: false,
    view: "sign-in",
  });
});

test("signed-out extension bootstrap only reads runtime status", async () => {
  const commands: string[] = [];
  const result = await bootstrapExtensionAuth(async () => {
    commands.push("runtime:get-status");
    return status();
  });

  assert.deepEqual(result, { authenticated: false, view: "sign-in" });
  assert.deepEqual(commands, ["runtime:get-status"]);
  assert.equal(commands.includes("runtime:auth-refresh"), false);
});

test("signed-in extension runtime with a user renders the authenticated view", async () => {
  const result = await bootstrapExtensionAuth(async () =>
    status({
      connectionState: "account-authenticated",
      signedIn: true,
      user,
    }),
  );

  assert.deepEqual(result, { authenticated: true, user });
});

test("normal signed-out bootstrap does not generate a session-required error", async () => {
  await assert.doesNotReject(bootstrapExtensionAuth(async () => status()));
  assert.equal(resolveExtensionAuth(status()).authenticated, false);
  assert.equal(
    JSON.stringify(resolveExtensionAuth(status())).includes("Sign in to use Copyyt"),
    false,
  );
});

test("web auth keeps valid-token and refresh decisions unchanged", () => {
  const isJwtValid = (token: string) => token === "valid-token";

  assert.equal(shouldRefreshWebAuth("valid-token", isJwtValid), false);
  assert.equal(shouldRefreshWebAuth("expired-token", isJwtValid), true);
  assert.equal(shouldRefreshWebAuth(null, isJwtValid), true);
});
