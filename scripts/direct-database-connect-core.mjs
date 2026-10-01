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

/**
 * Opens a direct connection, retrying a failure that could clear on its own,
 * and returns the connected client.
 *
 * `createClient` builds a fresh client per attempt because `pg` does not allow
 * reconnecting one that failed to connect -- reusing it would turn the second
 * attempt into a different, misleading error. A client that got partway is
 * closed before the next try so a retry cannot leak a socket.
 *
 * Throws the last error once every attempt is spent, leaving each caller's own
 * catch as the single place that redacts and reports a connection failure.
 */
export async function connectWithRetry(createClient, { onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt += 1) {
    const candidate = createClient();
    try {
      await candidate.connect();
      await candidate.query("SELECT 1");
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.end().catch(() => undefined);

      const delayMs = isRetryablePostgresConnectionError(error)
        ? nextConnectRetryDelayMs(attempt)
        : null;
      if (delayMs === null) break;

      onRetry?.(attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// The same condition, one command later.
//
// The 2026-09-13 deploy of e7e2795 failed with the probe above reporting the
// database healthy:
//
//     [migration-check 3/3] Testing PostgreSQL advisory locks
//     Direct PostgreSQL connection and advisory locks are available.
//     Datasource "db": PostgreSQL database "postgres" at "db.prisma.io:5432"
//     Error: P1001: Can't reach database server at `db.prisma.io:5432`
//
// Eight seconds separate those lines. The build had succeeded and the image was
// pushed; the five sibling services deploying from the same commit were
// unaffected, and the previous release kept serving requests against that same
// database minutes later. Nothing was wrong with the database for longer than
// the five seconds Prisma waits to connect.
//
// `db:migrate` is three commands. The retry added on 2026-08-24 covers the
// first one, and the comment above says it was "the one thing here with no
// second attempt" -- which was not true when it was written. The connect in
// `baseline-existing-database.mjs` and the connect `prisma migrate deploy`
// makes are the same one-shot, and this deploy lost on the third.
//
// The CLI is not `pg`: there is no error object to read, only what it printed.
// So the decision inverts. `pg` treats an error with no SQLSTATE as retryable,
// because a connection that never reached the server carries no code. Here an
// unrecognised failure is far more likely to be a migration that will not
// apply, and retrying schema changes on a guess is worse than stopping. Only
// the codes named below are tried again.
// ---------------------------------------------------------------------------

/**
 * Prisma CLI error codes for a database that was not reached, or that dropped
 * the connection before the command could do anything.
 *
 * Deliberately excludes the connection errors that cannot change between
 * attempts: P1000 (authentication failed), P1003 (the database named in the URL
 * does not exist) and P1010 (access denied) fail identically every time.
 */
export const RETRYABLE_PRISMA_CONNECT_CODES = Object.freeze([
  // P1001 can't reach the database server.
  "P1001",
  // P1002 the server was reached but timed out.
  "P1002",
  // P1017 the server closed the connection.
  "P1017",
]);

/** Any `P3xxx`: the migration engine ran and something about the schema failed. */
const PRISMA_MIGRATION_ERROR_PATTERN = /\bP3\d{3}\b/;

/**
 * Whether `output` -- everything `prisma migrate deploy` wrote before exiting
 * non-zero -- describes a database that was not reached, and nothing else.
 *
 * A migration error anywhere in the output vetoes the retry even when a
 * connection code is also present. `migrate deploy` records a failed migration
 * in `_prisma_migrations`, and every later attempt fails on that row (P3009)
 * rather than on the connection; retrying would bury the reason under
 * "retrying..." lines and delay a failure that needs a person.
 *
 * Retrying the connection case is safe because `migrate deploy` is resumable:
 * it applies what is pending and skips what is recorded, so a second attempt
 * after a lost connection is the same attempt, not a repeated one.
 */
export function isRetryablePrismaMigrateFailure(output) {
  if (typeof output !== "string" || output === "") return false;
  if (PRISMA_MIGRATION_ERROR_PATTERN.test(output)) return false;
  return RETRYABLE_PRISMA_CONNECT_CODES.some((code) =>
    new RegExp(`\\b${code}\\b`).test(output)
  );
}
