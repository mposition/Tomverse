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
const signInPageSource = readFileSync(
  resolve(ROOT, "app/(site)/(application)/auth/signin/page.tsx"),
  "utf8"
);
const formSlotSource = readFileSync(
  resolve(ROOT, "components/chat/TurnstileFormSlot.tsx"),
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
  assert.match(
    formSlotSource,
    /"pointer-events-none h-0 w-full min-w-0 overflow-hidden opacity-0"/
  );
  assert.doesNotMatch(formSlotSource, /fixed left-0 top-0 h-px w-px/);
});

test("email login receives the runtime Turnstile site key from its dynamic server page", () => {
  assert.match(
    signInPageSource,
    /turnstileSiteKey\s*=\s*process\.env\.NEXT_PUBLIC_TURNSTILE_SITE_KEY/
  );
  assert.match(
    signInPageSource,
    /<SignInPageContent turnstileSiteKey=\{turnstileSiteKey\}/
  );
  assert.match(
    signInSource,
    /useTurnstile\(true, "email_login_request", turnstileSiteKey\)/
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
