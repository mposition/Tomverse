import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { guestVerificationFailureKey } from "../components/chat/guestVerificationCopy.ts";

const ROOT = resolve(import.meta.dirname, "..");
const signInSource = readFileSync(
  resolve(
    ROOT,
    "app/(site)/(application)/auth/signin/SignInPageContent.tsx"
  ),
  "utf8"
);

test("email login keeps the Turnstile container renderable before interaction", () => {
  assert.match(signInSource, /<TurnstileFormSlot/);
  assert.match(signInSource, /isChallengeVisible=\{isChallengeVisible\}/);
  assert.match(signInSource, /surface="emailLogin"/);
  assert.doesNotMatch(
    signInSource,
    /className=\{needsTurnstile\s*\?[^}]*:\s*"hidden"\}/
  );
});

test("email login uses its existing localized verification failures", () => {
  assert.equal(
    guestVerificationFailureKey("unavailable", "emailLogin"),
    "auth.emailLoginTurnstileUnavailable"
  );
  for (const failure of ["failed", "cancelled", "timeout", "expired"]) {
    assert.equal(
      guestVerificationFailureKey(failure, "emailLogin"),
      "auth.emailLoginTurnstileFailed"
    );
  }
});
