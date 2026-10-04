import assert from "node:assert/strict";
import test from "node:test";

import {
  addressProofCovers,
  addressProofForSignIn,
  isAddressProof,
} from "../lib/emailPreferenceCore.ts";

// What a sign-in proves about the account's address.
// Contract: docs/policy/email-double-opt-in.md section 14.1.

const NOW = new Date("2026-09-30T10:00:00.000Z");
const proof = (overrides) =>
  addressProofForSignIn({ provider: "google", profile: null, userEmail: "a@example.test", now: NOW, ...overrides });

test("an email-code sign-in proves the account's own address", () => {
  assert.deepEqual(proof({ provider: "email-code", userEmail: " A@Example.test " }), {
    method: "email_code",
    address: "a@example.test",
    provenAt: NOW.toISOString(),
  });
});

test("Google proves only with email_verified true and the same address", () => {
  assert.deepEqual(proof({ profile: { email: "A@example.test", email_verified: true } }), {
    method: "google_verified",
    address: "a@example.test",
    provenAt: NOW.toISOString(),
  });
  // Not verified, or verified as a string: nothing.
  assert.equal(proof({ profile: { email: "a@example.test", email_verified: false } }), null);
  assert.equal(proof({ profile: { email: "a@example.test", email_verified: "true" } }), null);
  assert.equal(proof({ profile: { email: "a@example.test" } }), null);
  // A Google account linked to another address's session proves that account nothing.
  assert.equal(proof({ profile: { email: "other@example.test", email_verified: true } }), null);
});

test("Microsoft proves the account's own address (owner decision, section 14.7)", () => {
  assert.deepEqual(proof({ provider: "azure-ad", profile: { email: "A@example.test" } }), {
    method: "microsoft_signin",
    address: "a@example.test",
    provenAt: NOW.toISOString(),
  });
  // A Microsoft account linked to another address's session proves nothing,
  // and a profile without an address proves nothing.
  assert.equal(proof({ provider: "azure-ad", profile: { email: "other@example.test" } }), null);
  assert.equal(proof({ provider: "azure-ad", profile: {} }), null);
  assert.equal(proof({ provider: "azure-ad", profile: null }), null);
});

test("anything else proves nothing", () => {
  assert.equal(proof({ provider: undefined }), null);
  assert.equal(proof({ provider: "github", profile: { email: "a@example.test", email_verified: true } }), null);
  assert.equal(proof({ provider: "email-code", userEmail: null }), null);
});

test("a proof covers only the address it names, after normalisation", () => {
  const google = proof({ profile: { email: "a@example.test", email_verified: true } });
  assert.ok(addressProofCovers(google, "A@example.test"));
  assert.equal(addressProofCovers(google, "b@example.test"), false);
  assert.equal(addressProofCovers(google, null), false);
  // A shape from anywhere but the server's own writer is not a proof.
  assert.equal(isAddressProof({ method: "azure_ad", address: "a@example.test", provenAt: NOW.toISOString() }), false);
  assert.equal(isAddressProof({ method: "email_code", address: "a@example.test", provenAt: "yesterday" }), false);
  assert.equal(addressProofCovers(undefined, "a@example.test"), false);
});
