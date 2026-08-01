/**
 * The Admin Console E2E harness, described in one place.
 *
 * This module deliberately imports nothing: `playwright.admin.config.ts`, the
 * `scripts/run-admin-e2e.mjs` runner, the Playwright fixtures and the
 * `tests/adminE2eHarness.test.ts` safety contract all read the same values from
 * here, and the safety contract has to be able to import it under plain `tsx`.
 *
 * ## Why this harness has no production bypass at all
 *
 * The user-facing Playwright suite runs with `E2E_AUTH_BYPASS=true` and
 * `E2E_DISABLE_DATABASE=true`, and `app/(site)/(application)/layout.tsx`
 * fabricates a session from the `__tomverse_e2e_auth` cookie. That is enough
 * for the chat shell, which reads its session from React context -- but the
 * admin console does not. `AdminLayout`, `AdminWorkspace` and all 41
 * `/api/admin/**` route handlers call `getServerSession(authOptions)`
 * themselves and then hit Prisma directly, so neither the cookie nor a
 * `page.route()` interception reaches them.
 *
 * Rather than widen the bypass to cover them -- a switch that would, by
 * construction, be one stray environment variable away from disabling admin
 * authorization in production -- this harness removes the need for a bypass:
 *
 *  - **Authentication is real.** Tests mint a genuine NextAuth JWT with
 *    `next-auth/jwt`'s `encode()` and the server's own `NEXTAUTH_SECRET`, and
 *    set it as the ordinary `next-auth.session-token` cookie. The server
 *    decodes it through the unmodified `authOptions`, so server components and
 *    `/api/admin/**` observe the same identity for free. Minting a token is
 *    equivalent to knowing the deployment secret; it grants nothing that
 *    knowing the secret would not already grant.
 *  - **Authorization is real.** These identities become administrators only
 *    because `ADMIN_EMAILS` / `ADMIN_<ROLE>_EMAILS` list them, which is the
 *    same mechanism production uses. No code path anywhere treats them
 *    specially.
 *  - **Data is real.** The server talks to an isolated PostgreSQL database
 *    created from the project's own Prisma schema, reset and re-seeded before
 *    every test.
 *
 * So there is no E2E flag to leak: `adminE2eServerEnv()` never sets
 * `E2E_AUTH_BYPASS` or `E2E_DISABLE_DATABASE`, and `tests/adminE2eHarness.test.ts`
 * asserts that the harness identities are rejected by the real authorization
 * code whenever the admin environment variables are absent.
 */

/**
 * Any environment-shaped record. Deliberately looser than `NodeJS.ProcessEnv`,
 * whose Next.js augmentation makes `NODE_ENV` required -- these helpers are
 * called with small literal objects in tests.
 */
export type HarnessEnv = Record<string, string | undefined>;

export const ADMIN_E2E_PORT = 3101;
export const ADMIN_E2E_HOST = "127.0.0.1";
export const ADMIN_E2E_BASE_URL = `http://${ADMIN_E2E_HOST}:${ADMIN_E2E_PORT}`;

/**
 * `.invalid` is reserved by RFC 2606 and can never resolve, so a harness
 * identity that escaped into a real configuration could not receive mail and
 * would be obvious in an audit log.
 */
export const ADMIN_E2E_EMAIL_DOMAIN = "admin-e2e.tomverse.invalid";

export const ADMIN_E2E_ROLES = [
  "owner",
  "billing",
  "support",
  "ops",
  "readonly",
] as const;

export type AdminE2ERole = (typeof ADMIN_E2E_ROLES)[number];

export type AdminE2EIdentityKey =
  | AdminE2ERole
  /** A second `owner`, so two-person approval can be completed end to end. */
  | "approver"
  /** Signed in, but not an administrator. */
  | "member";

export type AdminE2EIdentity = {
  id: string;
  email: string;
  name: string;
  /** The admin role this identity resolves to, or null for a plain customer. */
  role: AdminE2ERole | null;
};

const identity = (
  key: AdminE2EIdentityKey,
  name: string,
  role: AdminE2ERole | null
): AdminE2EIdentity => ({
  id: `admin-e2e-${key}`,
  email: `${key}@${ADMIN_E2E_EMAIL_DOMAIN}`,
  name,
  role,
});

export const ADMIN_E2E_IDENTITIES: Record<
  AdminE2EIdentityKey,
  AdminE2EIdentity
> = {
  owner: identity("owner", "E2E Owner", "owner"),
  approver: identity("approver", "E2E Second Owner", "owner"),
  billing: identity("billing", "E2E Billing", "billing"),
  support: identity("support", "E2E Support", "support"),
  ops: identity("ops", "E2E Ops", "ops"),
  readonly: identity("readonly", "E2E Read Only", "readonly"),
  member: identity("member", "E2E Member", null),
};

export const ADMIN_E2E_IDENTITY_KEYS = Object.keys(
  ADMIN_E2E_IDENTITIES
) as AdminE2EIdentityKey[];

const emailsWithRole = (role: AdminE2ERole) =>
  ADMIN_E2E_IDENTITY_KEYS.filter(
    (key) => ADMIN_E2E_IDENTITIES[key].role === role
  ).map((key) => ADMIN_E2E_IDENTITIES[key].email);

const administratorEmails = () =>
  ADMIN_E2E_IDENTITY_KEYS.filter((key) => ADMIN_E2E_IDENTITIES[key].role).map(
    (key) => ADMIN_E2E_IDENTITIES[key].email
  );

/**
 * The signing secret for the harness server. It only ever protects a loopback
 * server holding synthetic data; the tests need to know it because they mint
 * the same tokens the server verifies. Override it per run with
 * `ADMIN_E2E_NEXTAUTH_SECRET` if a runner prefers a rotated value.
 */
export const adminE2eNextAuthSecret = (
  env: HarnessEnv = process.env
) =>
  env.ADMIN_E2E_NEXTAUTH_SECRET?.trim() ||
  "tomverse-admin-e2e-nextauth-secret-loopback-only-2026";

/** How long an admin session stays usable before the console demands a re-login. */
export const ADMIN_E2E_SESSION_MAX_HOURS = 8;
/** How recent a sign-in must be for a high-risk mutation to run. */
export const ADMIN_E2E_RECENT_AUTH_MINUTES = 30;
/** How long a pending two-person approval stays claimable. */
export const ADMIN_E2E_APPROVAL_TTL_MINUTES = 30;

export class AdminE2EConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminE2EConfigurationError";
  }
}

const parsePostgresUrl = (raw: string) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdminE2EConfigurationError(
      "ADMIN_E2E_DATABASE_URL is not a valid URL."
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new AdminE2EConfigurationError(
      "ADMIN_E2E_DATABASE_URL must use the postgres or postgresql protocol."
    );
  }
  return url;
};

/**
 * Refuses to run the harness against anything that is not visibly a throwaway
 * database.
 *
 * The harness truncates every table before each test, so pointing it at a real
 * database would destroy it. The bar is the same one
 * `scripts/run-db-integration-tests.mjs` already sets for the Prisma
 * integration suite -- an explicit `test`/`ci`/`e2e` marker in the database or
 * schema name -- plus a check that the URL is not the one the application
 * itself is configured with.
 */
export const assertIsolatedAdminE2EDatabase = (
  raw: string,
  env: HarnessEnv = process.env
) => {
  const url = parsePostgresUrl(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new AdminE2EConfigurationError(
      "ADMIN_E2E_DATABASE_URL must include a database name."
    );
  }
  const schema = url.searchParams.get("schema") || "";
  if (!/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(`${database}_${schema}`)) {
    throw new AdminE2EConfigurationError(
      `The admin E2E database name or schema must carry a separate test marker, for example tomverse_admin_e2e_test. Received "${database}".`
    );
  }
  for (const key of ["DATABASE_URL", "DIRECT_URL", "DIRECT_DATABASE_URL"]) {
    if (env[key]?.trim() && env[key]!.trim() === raw.trim()) {
      throw new AdminE2EConfigurationError(
        `ADMIN_E2E_DATABASE_URL must not be the same connection string as ${key}: the harness truncates every table.`
      );
    }
  }
  return { url, database, schema };
};

/**
 * The connection string the harness server and the fixture seeder both use.
 * Required, never defaulted: a silent default is how a suite that truncates
 * every table ends up pointed somewhere it should not be.
 */
export const resolveAdminE2EDatabaseUrl = (
  env: HarnessEnv = process.env
) => {
  const raw = (env.ADMIN_E2E_DATABASE_URL || env.TEST_DATABASE_URL || "").trim();
  if (!raw) {
    throw new AdminE2EConfigurationError(
      "ADMIN_E2E_DATABASE_URL (or TEST_DATABASE_URL) is required. It must point at a dedicated, disposable PostgreSQL database - the admin E2E harness truncates every table before each test."
    );
  }
  assertIsolatedAdminE2EDatabase(raw, env);
  return raw;
};

/**
 * The environment the harness `next start` runs with.
 *
 * Everything that makes these identities administrators is ordinary
 * configuration. Note what is *absent*: no `E2E_AUTH_BYPASS`, no
 * `E2E_DISABLE_DATABASE`, and no harness-only flag of any kind.
 */
export const adminE2eServerEnv = ({
  databaseUrl,
  nextAuthSecret,
  networkGuardPath,
  nodeOptions,
}: {
  databaseUrl: string;
  nextAuthSecret: string;
  networkGuardPath: string;
  nodeOptions?: string;
}): Record<string, string> => ({
  ALLOWED_REQUEST_HOSTS: [
    `${ADMIN_E2E_HOST}:${ADMIN_E2E_PORT}`,
    `localhost:${ADMIN_E2E_PORT}`,
  ].join(","),
  DATABASE_URL: databaseUrl,
  DIRECT_URL: databaseUrl,
  DIRECT_DATABASE_URL: databaseUrl,
  DISABLE_CSP_UPGRADE_INSECURE_REQUESTS: "true",
  NEXTAUTH_URL: ADMIN_E2E_BASE_URL,
  NEXTAUTH_SECRET: nextAuthSecret,
  REQUIRE_CLOUDFLARE_ORIGIN_SECRET: "false",
  NODE_OPTIONS: [nodeOptions, `--require "${networkGuardPath}"`]
    .filter(Boolean)
    .join(" "),
  // Administrator authorization, configured exactly the way a deployment
  // configures it.
  ADMIN_EMAILS: administratorEmails().join(","),
  ADMIN_OWNER_EMAILS: emailsWithRole("owner").join(","),
  ADMIN_BILLING_EMAILS: emailsWithRole("billing").join(","),
  ADMIN_SUPPORT_EMAILS: emailsWithRole("support").join(","),
  ADMIN_OPS_EMAILS: emailsWithRole("ops").join(","),
  ADMIN_READONLY_EMAILS: emailsWithRole("readonly").join(","),
  ADMIN_SESSION_MAX_HOURS: String(ADMIN_E2E_SESSION_MAX_HOURS),
  ADMIN_RECENT_AUTH_MINUTES: String(ADMIN_E2E_RECENT_AUTH_MINUTES),
  ADMIN_APPROVAL_TTL_MINUTES: String(ADMIN_E2E_APPROVAL_TTL_MINUTES),
});
