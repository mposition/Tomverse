import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
