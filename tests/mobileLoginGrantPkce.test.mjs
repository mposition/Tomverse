import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  isPkceChallenge,
  isPkceVerifier,
  pkceChallengeFor,
} from "../lib/mobileLoginGrant.ts";

/**
 * The client binding on a login grant (design D14.1, approved decision 14).
 *
 * A grant intercepted on its way back to the device is useless without the
 * verifier that never left the browser instance that started the flow -- but
 * only if the challenge really is a challenge. These are the checks that stop a
 * caller registering an empty or guessable binding and then satisfying it.
 */

test("the challenge is S256 of the verifier, base64url, unpadded", () => {
  const verifier = randomBytes(32).toString("base64url");
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceChallengeFor(verifier), expected);
  assert.ok(!pkceChallengeFor(verifier).includes("="));
  assert.equal(pkceChallengeFor(verifier).length, 43);
});

test("a challenge has to be the shape SHA-256 produces", () => {
  assert.equal(isPkceChallenge(pkceChallengeFor("anything")), true);
  for (const value of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}+`, null, 7, {}]) {
    assert.equal(isPkceChallenge(value), false, String(value));
  }
});

test("a verifier follows RFC 7636's alphabet and length", () => {
  assert.equal(isPkceVerifier("a".repeat(43)), true);
  assert.equal(isPkceVerifier("a".repeat(128)), true);
  assert.equal(isPkceVerifier("aA0-._~".repeat(7)), true);
  for (const value of ["a".repeat(42), "a".repeat(129), `${"a".repeat(42)}/`, "", null]) {
    assert.equal(isPkceVerifier(value), false, String(value));
  }
});

test("two verifiers do not share a challenge", () => {
  const seen = new Set();
  for (let index = 0; index < 100; index += 1) {
    const challenge = pkceChallengeFor(randomBytes(32).toString("base64url"));
    assert.ok(!seen.has(challenge));
    seen.add(challenge);
  }
});
