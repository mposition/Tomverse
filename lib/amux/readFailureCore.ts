/**
 * What a failed AMUX read is answered as.
 *
 * A read boundary (`isolation: "read"` in `AMUX_DB_BOUNDARIES`) writes
 * nothing: no card, no audit entry, no commit-deadline marker. When it fails,
 * nothing was written, so it has no unknown outcome. The unknown-outcome rule
 * (docs/policy/development-agent-orchestration.md, Phase A) is about writes
 * and stays with the mutation boundaries.
 *
 * A read that failed because the database could not take it just then -- the
 * pool had no connection, the transaction could not start within `maxWait`,
 * the statement timed out, the connection dropped -- is answered 503
 * `amux_database_busy`, and the caller may ask again on its next tick. Any
 * other read failure keeps its old answer.
 *
 * Pure: no database and no `server-only`, so the boundary, the internal route
 * and the tests read one list.
 */

/** The reason of the 503 a busy read answers with. The Rust client matches it. */
export const AMUX_DATABASE_BUSY_REASON = "amux_database_busy";

/**
 * The `Retry-After` of that 503, in seconds: the Railway scheduler's own tick
 * interval (apps/tomverse-orchestrator/src/scheduler.rs). It is a hint; the
 * Rust client skips the tick and asks again on its own cadence.
 */
export const AMUX_DATABASE_BUSY_RETRY_AFTER_SECONDS = 5;

/** Prisma error codes that mean the database could not take the call just then. */
const TRANSIENT_PRISMA_CODES = new Set([
  // Timed out fetching a new connection from the connection pool.
  "P2024",
  // Transaction API error: the transaction could not start within `maxWait`,
  // or its own timeout closed it.
  "P2028",
  // Can't reach the database server.
  "P1001",
  // The database server was reached but timed out.
  "P1002",
  // Operations timed out (the pg adapter's `SocketTimeout`).
  "P1008",
  // The server closed the connection (the pg adapter's `ConnectionClosed`).
  "P1017",
  // Too many database connections opened (the pg adapter's `TooManyConnections`).
  "P2037",
]);

/** The @prisma/adapter-pg error kinds for a connection that failed or closed. */
const TRANSIENT_DRIVER_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
]);

/** PostgreSQL SQLSTATEs. */
const TRANSIENT_SQLSTATES = new Set([
  // query_canceled: the statement timeout.
  "57014",
  // Class 08, connection exception.
  "08000",
  "08001",
  "08003",
  "08006",
  "08007",
  // Not 08004 (the server rejected the connection) or 08P01 (protocol
  // violation): both describe a configuration or client fault that a retry in
  // five seconds will meet again, so they stay a 500 incident.
  // admin_shutdown, crash_shutdown, cannot_connect_now.
  "57P01",
  "57P02",
  "57P03",
  // too_many_connections.
  "53300",
]);

/** The socket errors @prisma/adapter-pg maps to a connection error kind. */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

/** Enough for every wrapper Prisma and the pg adapter put around one error. */
const MAX_ERROR_NODES = 16;

/** A short nested database/driver code, without reading error text. */
export const amuxDatabaseDiagnosticCode = (error: unknown): string | null => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < MAX_ERROR_NODES) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const code of [record.code, record.originalCode]) {
      if (typeof code === "string" && /^(?!P\d{4}$)[0-9A-Z]{5}$/.test(code)) {
        return code;
      }
    }
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return null;
};

const isTransientCode = (value: unknown): value is string =>
  typeof value === "string" &&
  (TRANSIENT_PRISMA_CODES.has(value) ||
    TRANSIENT_SQLSTATES.has(value) ||
    TRANSIENT_SOCKET_CODES.has(value));

/**
 * The code that makes this a transient database failure, or null.
 *
 * Walked structurally, the way `isAmuxLateCommitError` finds AX001: Prisma's
 * own code at the top (`P2028`), the pg adapter's `DriverAdapterError` whose
 * `cause` carries `kind` and `code`/`originalCode` (rethrown bare by the
 * transaction manager, or at `meta.driverAdapterError` of a `P2010`/`P2039`),
 * an older Prisma shape at `meta.code`, and the pg driver's own `code`. Only
 * codes and kinds decide; no message is read.
 */
export const amuxTransientDatabaseCode = (error: unknown): string | null => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < MAX_ERROR_NODES) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (isTransientCode(record.code)) return record.code;
    if (isTransientCode(record.originalCode)) return record.originalCode;
    if (typeof record.kind === "string" && TRANSIENT_DRIVER_KINDS.has(record.kind)) {
      return record.kind;
    }
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return null;
};

/**
 * Prisma's two answers for a transaction that never got going: no pool
 * connection in time (P2024), and the transaction manager's `maxWait` expiring
 * before the transaction started (P2028, "Unable to start a transaction in
 * the given time"). Read only at the top level, where Prisma throws them.
 *
 * The code alone does not prove nothing ran: P2028 is also the interactive
 * transaction's own timeout once it is running. The boundary's phase decides
 * that (`amuxDbBoundaryFailure`); this only names the code.
 */
const TRANSACTION_NOT_STARTED_CODES = new Set(["P2024", "P2028"]);

export const amuxTransactionNotStartedCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && TRANSACTION_NOT_STARTED_CODES.has(code)
    ? code
    : null;
};

/**
 * The `AmuxDbBoundaryError` codes answered 503 `amux_database_busy`: a busy
 * read, and a transaction that never started, in a route that wrote nothing
 * (lib/amux/dbBoundary.ts). One list for the boundary and the internal route.
 */
const AMUX_DB_BUSY_ERROR_CODES = new Set(["AMUX_DB_READ_BUSY", "AMUX_DB_NOT_STARTED"]);

export const isAmuxDbBusyCode = (code: unknown): boolean =>
  typeof code === "string" && AMUX_DB_BUSY_ERROR_CODES.has(code);
