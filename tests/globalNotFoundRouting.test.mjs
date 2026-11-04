import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { HELP_CENTRE_PATH } from "../lib/localizedHelpHref.ts";

/**
 * What makes an unmatched URL a 404 instead of a 500.
 *
 * This app has two root layouts (`app/(site)/layout.tsx` and
 * `app/[locale]/layout.tsx`, for the two correct sources of `<html lang>`), so
 * a request that matches no route has no root layout for Next to compose
 * `app/not-found.tsx` with. Next refused the whole response --
 * `not-found.tsx doesn't have a root layout`, logged on the server, answered
 * with a 500 -- for every mistyped URL, dead link and guessed path, `/help`
 * among them.
 *
 * Three things have to hold together for that not to come back, and each one
 * is invisible on its own: the flag without the file serves Next's unstyled
 * built-in 404, the file without the flag is never read, and either is only
 * load-bearing while there is no single root layout at `app/layout.tsx`. So
 * all three are asserted here rather than left to a 500 in production.
 */
const ROOT = resolve(import.meta.dirname, "..");

// Sentry wraps the exported config when its build credentials are present,
// which a developer machine may have; the decisions under test are the app's
// own, so the plain config is what is read.
for (const key of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]) {
  delete process.env[key];
}
const nextConfig = (await import("../next.config.ts")).default;

test("the routing-level 404 is enabled and its file exists", () => {
  assert.equal(
    nextConfig.experimental?.globalNotFound,
    true,
    "experimental.globalNotFound is off, so app/global-not-found.tsx is never read and an unmatched URL has no root layout again"
  );
  assert.ok(
    existsSync(resolve(ROOT, "app/global-not-found.tsx")),
    "experimental.globalNotFound is on with no app/global-not-found.tsx, so unmatched URLs fall back to Next's built-in 404"
  );
});

test("there is still no single root layout to compose a 404 from", () => {
  // If one is ever added, this test is the place to re-decide: the routing
  // level 404 stays correct, but the reason it is required would be gone.
  assert.ok(
    !existsSync(resolve(ROOT, "app/layout.tsx")),
    "app/layout.tsx exists; re-read app/global-not-found.tsx before changing anything here"
  );
  for (const rootLayout of ["app/(site)/layout.tsx", "app/[locale]/layout.tsx"]) {
    assert.ok(existsSync(resolve(ROOT, rootLayout)), `${rootLayout} is missing`);
  }
});

test("/help reaches the help centre rather than any 404 at all", async () => {
  const redirects = await nextConfig.redirects();
  const help = redirects.find((rule) => rule.source === "/help");
  assert.ok(help, "/help has no redirect; it is not a route, so it would 404");
  assert.equal(help.destination, HELP_CENTRE_PATH);
  // A permanent redirect is cached by the browser; the help centre has moved
  // before, and a 308 is not something a later move can take back.
  assert.equal(help.permanent, false);
});
