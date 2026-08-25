// Which direct-Postgres connection failures are worth trying again, and how
// often.
//
// The release step runs `db:migrate`, which runs
// `require-direct-database-url.mjs` before `prisma migrate deploy`. That check
// opened one connection and failed the whole deploy if it did not answer:
//
//     [migration-check 2/3] Testing PostgreSQL connectivity
//     Direct PostgreSQL connectivity test failed.
//     "Failed to connect to upstream database. Please contact Prisma support
//      if the problem persists."
//
// That is what happened to the 2026-08-24 deploy of d04460c. The build had
// already succeeded and the image was pushed; five sibling services in the
// same environment deployed from the same commit at the same moment without
// trouble, because none of them opens the direct connection. The upstream was
// reachable again minutes later, and production stayed up the whole time on
// the previous release.
//
// So a momentary upstream blip cost a deploy. The same file already retries
// the *advisory lock* for up to a minute, on exactly this reasoning -- a lock
// held by another migration is a condition that clears on its own. A refused
// connection to a managed database is the same kind of condition, and it was
// the one thing here with no second attempt.
//
// Retrying is not always right, which is the other half of this module. A bad
// password or a database that does not exist fails identically on every
// attempt, and retrying only turns an immediate, clear failure into the same
// failure a minute later. Those are named below and fail fast.

/**
 * Postgres SQLSTATE codes whose cause cannot change between attempts made
 * seconds apart. Retrying these delays a certain failure and buries the
 * reason under "retrying..." lines.
 *
 * Deliberately narrow: anything not named here is treated as possibly
 * transient, because the failure this module exists for -- an upstream that
 * is briefly unreachable -- arrives with no SQLSTATE at all.
 */
export const NON_RETRYABLE_POSTGRES_CODES = Object.freeze([
  // 28P01 invalid_password, 28000 invalid_authorization_specification.
  // Credentials are wrong; they will still be wrong next time.
  "28P01",
  "28000",
  // 3D000 invalid_catalog_name: the database named in the URL is not there.
  "3D000",
  // 42501 insufficient_privilege: the role cannot do this at all.
  "42501",
]);

/** How many times the connectivity probe is attempted in total. */
export const CONNECT_RETRY_COUNT = 4;

/** Pause between attempts. */
export const CONNECT_RETRY_DELAY_MS = 4_000;

/**
 * Whether `error` describes a condition that could plausibly clear on its own.
 *
 * Reads `error.code`, which `pg` sets from the server's SQLSTATE. A refused,
 * reset or timed-out connection never reaches the server, so it carries no
 * code (or a socket-level one like ECONNREFUSED / ETIMEDOUT) -- and those are
 * precisely the ones worth another attempt.
 */
export function isRetryablePostgresConnectionError(error) {
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : null;
  if (!code) return true;
  return !NON_RETRYABLE_POSTGRES_CODES.includes(code);
}

/**
 * The delay before the attempt after `attempt`, or `null` when `attempt` was
 * the last one.
 *
 * A flat delay rather than a backoff, matching the advisory-lock loop beside
 * it: the wait is there to let an upstream finish recovering, and four evenly
 * spaced tries inside a bounded window is easier to reason about in a deploy
 * log than a curve. The whole probe stays under the minute the lock retry
 * already costs.
 */
export function nextConnectRetryDelayMs(attempt, total = CONNECT_RETRY_COUNT) {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (attempt >= total) return null;
  return CONNECT_RETRY_DELAY_MS;
}
