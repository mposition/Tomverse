import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  ADMIN_E2E_EMAIL_DOMAIN,
  ADMIN_E2E_IDENTITIES,
  ADMIN_E2E_IDENTITY_KEYS,
  ADMIN_E2E_LEGACY_SESSION_COOKIE_NAME,
  ADMIN_E2E_ROLES,
  ADMIN_E2E_SERVER_MODE,
  ADMIN_E2E_SESSION_COOKIE_NAME,
  AdminE2EConfigurationError,
  adminE2eNextAuthSecret,
  adminE2eServerEnv,
  assertIsolatedAdminE2EDatabase,
  resolveAdminE2EDatabaseUrl,
} from "../tests/e2e-admin/support/harness-config.ts";
import {
  normalizeAdminList,
  resolveAdminSessionAccessState,
  resolveConfiguredAdminRole,
  type AdminRole,
} from "../lib/adminAuthCore.ts";
import {
  isE2EAuthBypassEnabled,
  isE2EDatabaseDisabled,
  isE2EFixtureMode,
} from "../lib/e2eTestMode.ts";

/**
 * The safety contract for the Admin Console E2E harness.
 *
 * The harness gives Playwright a genuine administrator session against a
 * genuine database. That is only acceptable because it grants nothing a real
 * deployment could inherit, and these tests are what hold that claim up:
 *
 *  1. The harness adds no runtime bypass -- nothing in its server environment
 *     turns off authentication, authorization or the database.
 *  2. Its identities are administrators only because the ordinary
 *     `ADMIN_*_EMAILS` variables list them. Strip those and the real
 *     authorization code refuses them.
 *  3. No product source file mentions the harness identities or its secret, so
 *     there is no code path that could special-case them.
 *  4. The fixture database URL is validated fail-closed before anything is
 *     truncated.
 *
 * Point 2 is the important one: "a stray environment variable enables admin
 * access in production" is the failure mode this design exists to make
 * impossible, and the only variables involved are the ones an operator already
 * has to set deliberately to appoint an administrator at all.
 */

const harnessEnv = () =>
  adminE2eServerEnv({
    databaseUrl: "postgresql://u:p@127.0.0.1:5432/tomverse_admin_e2e_test",
    nextAuthSecret: "harness-secret",
    networkGuardPath: "/repo/tests/e2e/block-external-network.cjs",
  });

const roleEmailsFrom = (env: Record<string, string>) =>
  Object.fromEntries(
    ADMIN_E2E_ROLES.map((role) => [
      role,
      normalizeAdminList(env[`ADMIN_${role.toUpperCase()}_EMAILS`]),
    ])
  ) as Record<AdminRole, string[]>;

test("the harness server environment enables no Playwright bypass", () => {
  const env = harnessEnv();

  assert.equal(env.E2E_AUTH_BYPASS, undefined);
  assert.equal(env.E2E_DISABLE_DATABASE, undefined);
  // And nothing else that reads like one: the whole point is that the admin
  // suite needs no product short-circuit at all.
  const bypassLooking = Object.keys(env).filter((key) =>
    /^E2E_|BYPASS|DISABLE_DATABASE|SKIP_AUTH/i.test(key)
  );
  assert.deepEqual(bypassLooking, []);
});

test("harness identities are not administrators without the standard admin variables", () => {
  // A production-shaped environment: no ADMIN_EMAILS, no role lists.
  for (const key of ADMIN_E2E_IDENTITY_KEYS) {
    const identity = ADMIN_E2E_IDENTITIES[key];
    const state = resolveAdminSessionAccessState({
      userId: identity.id,
      email: identity.email,
      authenticatedAt: new Date().toISOString(),
      adminUserIds: [],
      adminEmails: [],
      sessionMaxAgeMs: 8 * 60 * 60 * 1000,
    });
    assert.equal(
      state,
      "not-authorized",
      `${identity.email} must not be an administrator without ADMIN_EMAILS`
    );
  }
});

test("harness identities become administrators only through the ordinary role variables", () => {
  const env = harnessEnv();
  const adminEmails = normalizeAdminList(env.ADMIN_EMAILS);
  const roleEmails = roleEmailsFrom(env);

  for (const key of ADMIN_E2E_IDENTITY_KEYS) {
    const identity = ADMIN_E2E_IDENTITIES[key];
    const state = resolveAdminSessionAccessState({
      userId: identity.id,
      email: identity.email,
      authenticatedAt: new Date().toISOString(),
      adminUserIds: [],
      adminEmails,
      sessionMaxAgeMs: 8 * 60 * 60 * 1000,
    });

    if (!identity.role) {
      assert.equal(
        state,
        "not-authorized",
        `${identity.email} is the non-administrator fixture and must stay one`
      );
      continue;
    }

    assert.equal(state, "authorized", `${identity.email} should be authorized`);
    assert.equal(
      resolveConfiguredAdminRole({
        isAdmin: true,
        email: identity.email,
        roleEmails,
      }),
      identity.role,
      `${identity.email} must resolve to the role the harness declares`
    );
  }

  // ADMIN_EMAILS never contains the plain-customer fixture.
  assert.ok(!adminEmails.includes(ADMIN_E2E_IDENTITIES.member.email));
});

test("a stale harness session is refused by the same rule a real one is", () => {
  const env = harnessEnv();
  const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();

  assert.equal(
    resolveAdminSessionAccessState({
      userId: ADMIN_E2E_IDENTITIES.owner.id,
      email: ADMIN_E2E_IDENTITIES.owner.email,
      authenticatedAt: nineHoursAgo,
      adminUserIds: [],
      adminEmails: normalizeAdminList(env.ADMIN_EMAILS),
      sessionMaxAgeMs: Number(env.ADMIN_SESSION_MAX_HOURS) * 60 * 60 * 1000,
    }),
    "reauthentication-required"
  );
});

test("no product source refers to the harness identities or its secret", () => {
  const root = process.cwd();
  // Everything the application ships. `tests/` is excluded because the harness
  // itself lives there.
  const roots = ["app", "components", "lib", "scripts", "prisma", "types"];
  const secret = adminE2eNextAuthSecret({});
  const needles = [ADMIN_E2E_EMAIL_DOMAIN, secret, "admin-e2e-owner"];
  const offenders: string[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|cjs|js|json|prisma)$/.test(entry)) continue;
      const contents = readFileSync(full, "utf8");
      for (const needle of needles) {
        if (contents.includes(needle)) {
          offenders.push(`${relative(root, full).split(sep).join("/")}: ${needle}`);
        }
      }
    }
  };

  for (const directory of roots) walk(join(root, directory));
  assert.deepEqual(
    offenders,
    [],
    `Product code must never reference the admin E2E harness:\n${offenders.join("\n")}`
  );
});

test("the harness signs in with the cookie a production server actually reads", () => {
  // The regression this pins: `lib/auth.ts` chooses the session cookie's name
  // from NODE_ENV, and the harness runs `next start`, so the harness has to
  // write the `__Secure-` prefixed name. It previously wrote the unprefixed
  // one, and every signed-in admin spec silently became an anonymous visitor.
  //
  // Asserted against the source rather than by importing `authOptions`, which
  // pulls in Prisma and the whole provider configuration. If the policy line
  // ever moves, this fails and the harness name has to be reconsidered with
  // it -- which is the point.
  const authSource = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");
  assert.match(
    authSource,
    /useSecureCookies:\s*process\.env\.NODE_ENV === "production"/,
    "lib/auth.ts must keep deriving the secure-cookie policy from NODE_ENV"
  );

  assert.equal(ADMIN_E2E_SERVER_MODE, "production");
  assert.equal(
    ADMIN_E2E_SESSION_COOKIE_NAME,
    `__Secure-${ADMIN_E2E_LEGACY_SESSION_COOKIE_NAME}`,
    "a production server prefixes the session cookie, so the harness must too"
  );
  assert.equal(ADMIN_E2E_LEGACY_SESSION_COOKIE_NAME, "next-auth.session-token");
});

test("the harness identity domain can never receive real mail", () => {
  // RFC 2606 reserves `.invalid`, so an identity that leaked into a real
  // configuration would be inert as well as obvious.
  assert.ok(ADMIN_E2E_EMAIL_DOMAIN.endsWith(".invalid"));
  for (const key of ADMIN_E2E_IDENTITY_KEYS) {
    assert.ok(
      ADMIN_E2E_IDENTITIES[key].email.endsWith(`@${ADMIN_E2E_EMAIL_DOMAIN}`)
    );
  }
});

test("the fixture database URL is validated fail-closed", () => {
  assert.throws(
    () => resolveAdminE2EDatabaseUrl({}),
    AdminE2EConfigurationError,
    "an unset URL must not fall back to a default"
  );

  assert.throws(
    () => assertIsolatedAdminE2EDatabase("postgresql://u:p@db.example.com/tomverse"),
    /test marker/,
    "a production-looking database name must be refused"
  );

  assert.throws(
    () =>
      assertIsolatedAdminE2EDatabase("mysql://u:p@127.0.0.1/tomverse_test"),
    /postgres/,
    "only PostgreSQL is accepted"
  );

  const shared = "postgresql://u:p@127.0.0.1:5432/tomverse_test";
  assert.throws(
    () =>
      assertIsolatedAdminE2EDatabase(shared, { DATABASE_URL: shared }),
    /must not be the same connection string/,
    "the application's own database must never be the fixture database"
  );

  // A properly isolated URL is accepted.
  assert.equal(
    assertIsolatedAdminE2EDatabase(
      "postgresql://u:p@127.0.0.1:5432/tomverse_admin_e2e_test",
      {}
    ).database,
    "tomverse_admin_e2e_test"
  );
});

test("the Playwright short-circuits stay loopback-only regardless of the flags", () => {
  const original = {
    bypass: process.env.E2E_AUTH_BYPASS,
    database: process.env.E2E_DISABLE_DATABASE,
    url: process.env.NEXTAUTH_URL,
  };
  try {
    // Both flags set, as if copied into a real deployment by mistake.
    process.env.E2E_AUTH_BYPASS = "true";
    process.env.E2E_DISABLE_DATABASE = "true";
    process.env.NEXTAUTH_URL = "https://tomverse.app";

    assert.equal(isE2EAuthBypassEnabled(), false);
    assert.equal(isE2EDatabaseDisabled(), false);
    assert.equal(isE2EFixtureMode(), false);
  } finally {
    process.env.E2E_AUTH_BYPASS = original.bypass;
    process.env.E2E_DISABLE_DATABASE = original.database;
    process.env.NEXTAUTH_URL = original.url;
  }
});
