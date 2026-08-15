import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveAdminSessionAccessState,
  type AdminSessionAccessState,
} from "../lib/adminAuthCore.ts";
import {
  ADMIN_SESSION_EXPIRED_REASON,
  ADMIN_STEP_UP_EXPIRED_REASON,
  adminReauthenticationHref,
  adminReauthenticationSignInHref,
  adminRecentAuthenticationHref,
  isAdminReauthenticationSignInReason,
  normalizeAdminReauthenticationMode,
  resolveAdminReauthenticationView,
  resolveRecentAuthMinutes,
} from "../lib/adminReauthenticationCore.ts";
import { hasRecentAdminAuthentication } from "../lib/adminReauthentication.ts";

/**
 * `/auth/admin-reauthenticate`, which two different expiries land on.
 *
 * The bug these cases exist for: the page redirected any `authorized` session
 * straight to its callback, and `authorized` only ever meant the 8-hour
 * console window (`ADMIN_SESSION_MAX_HOURS`). An operator whose 30-minute
 * step-up window (`ADMIN_RECENT_AUTH_MINUTES`) had run out therefore got a
 * 428 from `/api/admin/app-settings`, followed the reauthentication link, and
 * was bounced back to the same screen -- with the console still working, so
 * nothing on the way explained what to do.
 *
 * Every case here drives `resolveAdminReauthenticationView`, which is what the
 * page calls. The window lengths are never written down in the decision: the
 * access state comes from `resolveAdminSessionAccessState` and the step-up
 * answer from `hasRecentAdminAuthentication`, both reading the environment.
 */

const ROOT = resolve(import.meta.dirname, "..");

const readRepoCode = (relative: string) =>
  readFileSync(resolve(ROOT, relative), "utf8");

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1_000;

// The wall clock, not a fixed instant. `hasRecentAdminAuthentication()` reads
// the real clock on purpose -- it is the production step-up decision, and a
// deadline it could be handed from outside would be one an caller could move.
// Every claim below is therefore an offset from now, and the access state is
// evaluated against the same instant so the two windows stay comparable.
const NOW = new Date();

/** Minutes ago, as the JWT claim `callbacks.jwt` stamps at sign-in. */
const authenticatedMinutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const adminAccessState = (minutesAgo: number): AdminSessionAccessState =>
  resolveAdminSessionAccessState({
    email: "owner@example.com",
    authenticatedAt: authenticatedMinutesAgo(minutesAgo),
    adminUserIds: [],
    adminEmails: ["owner@example.com"],
    sessionMaxAgeMs: SESSION_MAX_AGE_MS,
    now: NOW,
  });

/** The step-up answer, read the way the page reads it: through the env. */
const recentAuth = (minutesAgo: number, override?: string) => {
  const previous = process.env.ADMIN_RECENT_AUTH_MINUTES;
  if (override === undefined) delete process.env.ADMIN_RECENT_AUTH_MINUTES;
  else process.env.ADMIN_RECENT_AUTH_MINUTES = override;
  try {
    return hasRecentAdminAuthentication({
      user: {
        id: "user-1",
        email: "owner@example.com",
        authenticatedAt: authenticatedMinutesAgo(minutesAgo),
      },
    } as Parameters<typeof hasRecentAdminAuthentication>[0]);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_RECENT_AUTH_MINUTES;
    else process.env.ADMIN_RECENT_AUTH_MINUTES = previous;
  }
};

test("an expired step-up window inside a valid console session shows the card", () => {
  // 45 minutes: past the 30-minute step-up window, nowhere near the 8-hour
  // console window. This is the exact state that used to redirect in a circle.
  assert.equal(adminAccessState(45), "authorized");
  assert.equal(recentAuth(45), false);

  assert.deepEqual(
    resolveAdminReauthenticationView({
      signedIn: true,
      accessState: adminAccessState(45),
      mode: "recent-auth",
      hasRecentAuthentication: recentAuth(45),
      callbackUrl: "/admin/platform",
    }),
    { kind: "reauthenticate", reason: "recent-auth", callbackUrl: "/admin/platform" }
  );
});

test("a step-up window that is still open goes back to the callback", () => {
  assert.equal(recentAuth(5), true);
  assert.deepEqual(
    resolveAdminReauthenticationView({
      signedIn: true,
      accessState: adminAccessState(5),
      mode: "recent-auth",
      hasRecentAuthentication: recentAuth(5),
      callbackUrl: "/admin/platform",
    }),
    { kind: "callback", href: "/admin/platform" }
  );
});

test("an expired console session shows the card whichever mode was asked for", () => {
  // 600 minutes is past both windows, so the console itself is unreachable and
  // the stronger of the two failures is the one to report.
  assert.equal(adminAccessState(600), "reauthentication-required");
  for (const mode of ["admin-session", "recent-auth"] as const) {
    assert.deepEqual(
      resolveAdminReauthenticationView({
        signedIn: true,
        accessState: adminAccessState(600),
        mode,
        hasRecentAuthentication: recentAuth(600),
        callbackUrl: "/admin/platform",
      }),
      {
        kind: "reauthenticate",
        reason: "admin-session",
        callbackUrl: "/admin/platform",
      }
    );
  }
});

test("a signed-out visitor is sent to sign-in with the admin callback kept", () => {
  assert.deepEqual(
    resolveAdminReauthenticationView({
      signedIn: false,
      accessState: "not-authorized",
      mode: "recent-auth",
      hasRecentAuthentication: false,
      callbackUrl: "/admin/platform",
    }),
    { kind: "sign-in", href: "/auth/signin?callbackUrl=%2Fadmin%2Fplatform" }
  );
});

test("a non-administrator gets 404 whatever their own clock says", () => {
  // Before the access state is even reached for the step-up question: a page
  // that answered differently for a fresh non-admin than for a stale one would
  // confirm that /admin exists.
  for (const hasRecentAuthentication of [true, false]) {
    assert.deepEqual(
      resolveAdminReauthenticationView({
        signedIn: true,
        accessState: "not-authorized",
        mode: "recent-auth",
        hasRecentAuthentication,
        callbackUrl: "/admin/platform",
      }),
      { kind: "not-found" }
    );
  }
});

test("callbacks outside the console are normalized before they are handed back", () => {
  const outside = [
    "https://evil.example/admin/overview",
    "//evil.example/admin",
    "/chat",
    "",
    undefined,
  ];
  for (const callbackUrl of outside) {
    assert.deepEqual(
      resolveAdminReauthenticationView({
        signedIn: true,
        accessState: "authorized",
        mode: "recent-auth",
        hasRecentAuthentication: true,
        callbackUrl,
      }),
      { kind: "callback", href: "/admin/overview" },
      `expected the fallback for callbackUrl=${String(callbackUrl)}`
    );
  }

  // Including the one the signed-out branch hands to the sign-in page, which
  // is the branch an unauthenticated attacker can reach.
  assert.deepEqual(
    resolveAdminReauthenticationView({
      signedIn: false,
      accessState: "not-authorized",
      mode: "recent-auth",
      hasRecentAuthentication: false,
      callbackUrl: "https://evil.example/admin/overview",
    }),
    { kind: "sign-in", href: "/auth/signin?callbackUrl=%2Fadmin%2Foverview" }
  );
});

test("the step-up window follows a production override, not a constant", () => {
  // 45 minutes is expired under the 30-minute default and open under a
  // 60-minute override. Both readings come from the same env variable the API
  // endpoint reads, so the page and `/api/admin/**` cannot disagree.
  assert.equal(resolveRecentAuthMinutes(undefined), 30);
  assert.equal(resolveRecentAuthMinutes("60"), 60);
  assert.equal(recentAuth(45), false);
  assert.equal(recentAuth(45, "60"), true);
  assert.equal(recentAuth(90, "60"), false);

  // And no copy of either window is written into the decision or the page.
  for (const file of [
    "lib/adminReauthenticationCore.ts",
    "app/(site)/(application)/auth/admin-reauthenticate/page.tsx",
    "components/admin/PlatformSettingsPanel.tsx",
  ]) {
    const source = readRepoCode(file);
    assert.doesNotMatch(
      source,
      /process\.env\.ADMIN_(RECENT_AUTH_MINUTES|SESSION_MAX_HOURS)/,
      `${file} must not read an administrator window itself`
    );
  }
  assert.match(
    readRepoCode("app/(site)/(application)/auth/admin-reauthenticate/page.tsx"),
    /hasRecentAdminAuthentication\(session\)/,
    "the page must reuse the shared step-up helper"
  );
  assert.match(
    readRepoCode("lib/adminReauthentication.ts"),
    /isRecentAdminAuthentication\(/,
    "the shared helper must apply the same policy as the API assertion"
  );
});

test("the two reauthentication entry points stay distinguishable", () => {
  assert.equal(
    adminRecentAuthenticationHref("/admin/platform"),
    "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform&mode=recent"
  );
  // The console-session URL is unchanged, and carries no mode.
  assert.equal(
    adminReauthenticationHref("/admin/platform"),
    "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform"
  );
  assert.equal(
    adminRecentAuthenticationHref("https://evil.example/admin/platform"),
    "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Foverview&mode=recent"
  );

  assert.equal(normalizeAdminReauthenticationMode("recent"), "recent-auth");
  assert.equal(normalizeAdminReauthenticationMode(["recent", "x"]), "recent-auth");
  // Anything else means the console-session flow, which is the stricter one.
  for (const value of [undefined, "", "session", "RECENT", ["x"], 1]) {
    assert.equal(
      normalizeAdminReauthenticationMode(value),
      "admin-session",
      `expected the console-session mode for ${JSON.stringify(value)}`
    );
  }
});

test("the sign-out destination names which window expired", () => {
  assert.equal(
    adminReauthenticationSignInHref("/admin/platform", "recent-auth"),
    `/auth/signin?callbackUrl=%2Fadmin%2Fplatform&reason=${ADMIN_STEP_UP_EXPIRED_REASON}`
  );
  assert.equal(
    adminReauthenticationSignInHref("/admin/platform", "admin-session"),
    `/auth/signin?callbackUrl=%2Fadmin%2Fplatform&reason=${ADMIN_SESSION_EXPIRED_REASON}`
  );
  assert.equal(
    adminReauthenticationSignInHref("https://evil.example/x", "recent-auth"),
    `/auth/signin?callbackUrl=%2Fadmin%2Foverview&reason=${ADMIN_STEP_UP_EXPIRED_REASON}`
  );

  // The sign-in page shows its administrator notice for both, so an operator
  // arriving from a refused save is not left looking at a bare form.
  assert.equal(isAdminReauthenticationSignInReason(ADMIN_STEP_UP_EXPIRED_REASON), true);
  assert.equal(isAdminReauthenticationSignInReason(ADMIN_SESSION_EXPIRED_REASON), true);
  assert.equal(isAdminReauthenticationSignInReason("switch-account"), false);
  assert.equal(isAdminReauthenticationSignInReason(null), false);
});

test("high-risk panels link to the step-up flow, the layout to the session flow", () => {
  const securityControls = readRepoCode(
    "components/admin/AdminUserSecurityControls.tsx"
  );
  assert.match(securityControls, /adminRecentAuthenticationHref\(pathname\)/);
  assert.doesNotMatch(securityControls, /adminReauthenticationHref\(/);

  const platformPanel = readRepoCode("components/admin/PlatformSettingsPanel.tsx");
  assert.match(platformPanel, /adminRecentAuthenticationHref\(/);
  assert.doesNotMatch(platformPanel, /adminReauthenticationHref\(/);

  // The admin layout's redirect is the console-session one and stays that way:
  // there the session really has expired, and `mode=recent` would describe the
  // wrong failure.
  const layout = readRepoCode("app/(site)/(application)/admin/layout.tsx");
  assert.match(layout, /adminReauthenticationHref\(/);
  assert.doesNotMatch(layout, /adminRecentAuthenticationHref\(/);
});

test("the step-up assertion is still what guards the high-risk endpoint", () => {
  // The recovery UX must not have been bought by removing the check it
  // recovers from.
  const route = readRepoCode("app/api/admin/app-settings/route.ts");
  assert.match(route, /await assertRecentAdminAuthentication\(session\)/);
  assert.match(
    readRepoCode("lib/adminApproval.ts"),
    /status: 428/,
    "a spent step-up window must still answer 428"
  );
});
