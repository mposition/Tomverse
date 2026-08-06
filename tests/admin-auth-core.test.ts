import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConfiguredAdminRole,
  roleHasPermission,
  configuredAdminAccessExpiry,
  resolveAdminSessionAccessState,
  type AdminRole,
} from "../lib/adminAuthCore.ts";
import {
  ACCOUNT_SWITCH_REASON,
  accountSwitchSignInHref,
  isAdminPathname,
  normalizeAdminCallbackPath,
} from "../lib/adminReauthenticationCore.ts";

const roles = (overrides?: Partial<Record<AdminRole, string[]>>) => ({
  owner: [],
  billing: [],
  support: [],
  ops: [],
  readonly: [],
  ...overrides,
});

test("administrator access expiry fails closed for invalid or expired configuration", () => {
  assert.equal(configuredAdminAccessExpiry("admin@example.com", undefined).active, true);
  assert.equal(configuredAdminAccessExpiry("admin@example.com", "not-json").active, false);
  assert.equal(configuredAdminAccessExpiry(
    "admin@example.com",
    JSON.stringify({ "admin@example.com": "2000-01-01T00:00:00.000Z" })
  ).active, false);
  assert.equal(configuredAdminAccessExpiry(
    "admin@example.com",
    JSON.stringify({ "admin@example.com": "2999-01-01T00:00:00.000Z" })
  ).active, true);
});

test("unassigned or email-less administrators fail closed to readonly", () => {
  assert.equal(
    resolveConfiguredAdminRole({ isAdmin: true, email: null, roleEmails: roles() }),
    "readonly"
  );
  assert.equal(
    resolveConfiguredAdminRole({
      isAdmin: true,
      email: "unassigned@example.com",
      roleEmails: roles(),
    }),
    "readonly"
  );
  assert.equal(
    resolveConfiguredAdminRole({
      isAdmin: false,
      email: "owner@example.com",
      roleEmails: roles({ owner: ["owner@example.com"] }),
    }),
    null
  );
});

test("role permission matrix enforces least privilege", () => {
  assert.equal(roleHasPermission("owner", "user:delete"), true);
  assert.equal(roleHasPermission("billing", "billing:write"), true);
  assert.equal(roleHasPermission("billing", "support:write"), false);
  assert.equal(roleHasPermission("support", "support:write"), true);
  assert.equal(roleHasPermission("ops", "ops:write"), true);
  assert.equal(roleHasPermission("readonly", "ops:write"), false);
});

test("every administrator role has only its documented write permissions", () => {
  const permissions = [
    "support:write",
    "billing:write",
    "ops:write",
    "user:delete",
  ] as const;
  const expected: Record<AdminRole, boolean[]> = {
    owner: [true, true, true, true],
    billing: [false, true, false, false],
    support: [true, false, false, false],
    ops: [false, false, true, false],
    readonly: [false, false, false, false],
  };
  for (const role of Object.keys(expected) as AdminRole[]) {
    assert.deepEqual(
      permissions.map((permission) => roleHasPermission(role, permission)),
      expected[role],
      role
    );
  }
});

test("registered administrators with an expired admin session require reauthentication", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const common = {
    userId: "admin-user",
    email: "admin@example.com",
    adminUserIds: [],
    adminEmails: ["admin@example.com"],
    sessionMaxAgeMs: 8 * 60 * 60 * 1_000,
    now,
  };

  assert.equal(
    resolveAdminSessionAccessState({
      ...common,
      authenticatedAt: "2026-07-18T15:59:59.000Z",
    }),
    "reauthentication-required"
  );
  assert.equal(
    resolveAdminSessionAccessState({
      ...common,
      authenticatedAt: "2026-07-18T16:00:01.000Z",
    }),
    "authorized"
  );
});

test("unregistered or access-expired identities remain hidden as not authorized", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const common = {
    userId: "ordinary-user",
    email: "ordinary@example.com",
    authenticatedAt: "2026-07-18T23:00:00.000Z",
    adminUserIds: [],
    sessionMaxAgeMs: 8 * 60 * 60 * 1_000,
    now,
  };

  assert.equal(
    resolveAdminSessionAccessState({
      ...common,
      adminEmails: ["admin@example.com"],
    }),
    "not-authorized"
  );
  assert.equal(
    resolveAdminSessionAccessState({
      ...common,
      email: "admin@example.com",
      adminEmails: ["admin@example.com"],
      accessExpiryJson: JSON.stringify({
        "admin@example.com": "2026-07-18T23:59:59.000Z",
      }),
    }),
    "not-authorized"
  );
});

test("administrator reauthentication callbacks remain on an admin route", () => {
  assert.equal(
    normalizeAdminCallbackPath("/admin/providers/openai?view=usage"),
    "/admin/providers/openai?view=usage"
  );
  assert.equal(
    normalizeAdminCallbackPath("https://evil.example/admin/overview"),
    "/admin/overview"
  );
  assert.equal(normalizeAdminCallbackPath("//evil.example/admin"), "/admin/overview");
  assert.equal(normalizeAdminCallbackPath("/chat"), "/admin/overview");
});

test("the 404 recognises admin request paths without consulting a session", () => {
  assert.equal(isAdminPathname("/admin"), true);
  assert.equal(isAdminPathname("/admin/overview"), true);
  // A path that resolves to no route at all still counts: the account-switch
  // offer must not distinguish a real console URL from a typo, or it becomes
  // an oracle for which admin routes exist.
  assert.equal(isAdminPathname("/admin/does-not-exist"), true);

  assert.equal(isAdminPathname("/chat"), false);
  assert.equal(isAdminPathname("/administrators"), false);
  assert.equal(isAdminPathname("/nested/admin/overview"), false);
  // Protocol-relative and absolute forms name another origin even though the
  // first character is a slash.
  assert.equal(isAdminPathname("//evil.example/admin"), false);
  assert.equal(isAdminPathname("https://evil.example/admin"), false);
  assert.equal(isAdminPathname("javascript:alert(1)"), false);
  assert.equal(isAdminPathname(""), false);
  assert.equal(isAdminPathname(null), false);
  assert.equal(isAdminPathname(undefined), false);
  assert.equal(isAdminPathname(42), false);
});

test("account switching returns to the original admin destination", () => {
  assert.equal(
    accountSwitchSignInHref("/admin/refunds?status=pending"),
    `/auth/signin?callbackUrl=%2Fadmin%2Frefunds%3Fstatus%3Dpending&reason=${ACCOUNT_SWITCH_REASON}`
  );
  assert.equal(
    accountSwitchSignInHref("/admin"),
    `/auth/signin?callbackUrl=%2Fadmin&reason=${ACCOUNT_SWITCH_REASON}`
  );
});

test("account switching cannot be turned into an open redirect", () => {
  const fallback = `/auth/signin?callbackUrl=%2Fadmin%2Foverview&reason=${ACCOUNT_SWITCH_REASON}`;
  for (const hostile of [
    "https://evil.example/admin/overview",
    "//evil.example/admin",
    "///evil.example/admin",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/chat?next=https://evil.example",
    "",
    "   ",
    null,
    undefined,
    { toString: () => "/admin/overview" },
  ]) {
    assert.equal(accountSwitchSignInHref(hostile), fallback, String(hostile));
  }
});
