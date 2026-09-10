import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hasAuthenticatedSessionUser } from "../lib/sessionIdentity.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("an identity-less rejected session is not authenticated", () => {
  for (const session of [
    null,
    undefined,
    {},
    { user: null },
    { user: {} },
    { user: { id: "" } },
    { user: { id: "   " } },
  ]) {
    assert.equal(hasAuthenticatedSessionUser(session), false);
  }

  assert.equal(
    hasAuthenticatedSessionUser({ user: { id: "user-123" } }),
    true
  );
});

test("the session bridge preserves an omitted session but normalizes rejected sessions", () => {
  const source = readFileSync(
    join(repoRoot, "components/auth/SessionProviderWrapper.tsx"),
    "utf8"
  );

  assert.match(source, /session === undefined\s*\? undefined/);
  assert.match(source, /hasAuthenticatedSessionUser\(session\)/);
  assert.match(source, /<SessionProvider session=\{initialSession\}>/);
});

test("the sign-in redirect requires a real user identity", () => {
  const source = readFileSync(
    join(
      repoRoot,
      "app/(site)/(application)/auth/signin/SignInPageContent.tsx"
    ),
    "utf8"
  );

  assert.match(source, /data: session, status/);
  assert.match(source, /if \(hasAuthenticatedUser\) \{\s*router\.replace\(callbackUrl\)/);
  assert.doesNotMatch(source, /if \(status === "authenticated"\) \{\s*router\.replace/);
});
