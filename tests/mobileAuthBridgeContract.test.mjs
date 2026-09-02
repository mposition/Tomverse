import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  MOBILE_AUTH_BRIDGE_METHODS,
} from "../apps/mobile/src/authBridgeContract.ts";

/**
 * D19's requirement, which is an absence.
 *
 * "The bridge has no API that returns a refresh token -- what does not exist
 * cannot leak." A reviewer cannot see an absence, so it is a test.
 *
 * What this does **not** claim: that a refresh token is absent from a real
 * WebView on a real device. That is `AUTH-03`'s evidence, it is a physical
 * check (approved decision 16), and nothing in this repository can stand in
 * for it. This fixes the TypeScript surface a future plugin has to satisfy.
 */

const SOURCE = readFileSync(
  new URL("../apps/mobile/src/authBridgeContract.ts", import.meta.url),
  "utf8"
);

const withoutComments = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /(^|[^:])\/\/.*$/gm,
  "$1"
);

test("the bridge exposes exactly three methods, and they are the approved three", () => {
  assert.deepEqual([...MOBILE_AUTH_BRIDGE_METHODS], [
    "getAccessToken",
    "hasSession",
    "signOut",
  ]);
});

test("no member name mentions a refresh token", () => {
  for (const method of MOBILE_AUTH_BRIDGE_METHODS) {
    assert.ok(
      !/refresh/i.test(method),
      `${method} names a refresh token; D19 says the bridge has no such API`
    );
  }
});

test("no declared type carries a refresh token or a stored credential", () => {
  // The comments explain *why* there is no refresh token here, so they are
  // stripped before the scan -- otherwise the explanation would trip the check
  // it exists to justify.
  for (const forbidden of [
    "refreshToken",
    "secretDigest",
    "credential:",
    "keychain",
  ]) {
    assert.ok(
      !new RegExp(forbidden, "i").test(withoutComments),
      `the bridge declares ${forbidden}`
    );
  }
});

test("the method list and the type cannot drift apart", () => {
  // Adding a member to the type without adding it to the list would put a
  // bridge method outside the one place that asks what it returns.
  const declared = [...withoutComments.matchAll(/^\s{2}(\w+)\(/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(declared.sort(), [...MOBILE_AUTH_BRIDGE_METHODS].sort());
});

test("what JS may hold is an access token and an expiry, and nothing else", () => {
  const grant = /export type MobileAccessGrant = \{([\s\S]*?)\};/.exec(SOURCE)?.[1];
  assert.ok(grant, "MobileAccessGrant should be declared");
  const fields = [...grant.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]);
  assert.deepEqual(fields.sort(), ["accessToken", "expiresAt"]);
});

// --- the boundary as a shipped gate --------------------------------------

test("the bundle's own source passes the boundary check", () => {
  // The gate runs in CI; running it here too means a change to apps/mobile
  // fails in the unit lane rather than several minutes later.
  const result = spawnSync(
    process.execPath,
    ["scripts/check-native-token-boundary.mjs"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /none able to hold a refresh token/);
});

test("the boundary check actually fails on what it claims to catch", () => {
  // A validator nobody has seen fail is a validator nobody knows works. Three
  // shapes, and the comment case, which must not trip it -- the modules here
  // explain at length why a refresh token is absent, and an explanation is not
  // a use.
  const probe = new URL("../apps/mobile/src/boundaryProbe.test-tmp.ts", import.meta.url);
  const run = () =>
    spawnSync(process.execPath, ["scripts/check-native-token-boundary.mjs"], {
      encoding: "utf8",
    });

  try {
    for (const source of [
      'export const url = "/api/auth/mobile/refresh";',
      'export const refreshToken = "x";',
      "export const token = { refresh_token: 1 };",
    ]) {
      writeFileSync(probe, `${source}\n`);
      assert.notEqual(run().status, 0, source);
    }

    writeFileSync(
      probe,
      "// refreshToken is absent; /api/auth/mobile/refresh is the native layer's\nexport const ok = 1;\n"
    );
    assert.equal(run().status, 0, "a comment explaining the rule must not break it");
  } finally {
    rmSync(probe, { force: true });
  }
});
