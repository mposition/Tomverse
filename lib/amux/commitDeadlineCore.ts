/**
 * The database's own check that an AMUX transaction with a deadline does not
 * COMMIT after it (docs/policy/development-agent-orchestration.md, Phase A,
 * and version 18, "활성화 증거").
 *
 * The fence that ends such a transaction inserts one `AmuxCommitDeadline` row
 * carrying the commit deadline. The deferred constraint trigger
 * `amux_commit_deadline_check` (migration
 * 20260929200000_amux_commit_deadline_check) runs during COMMIT, before the
 * commit record is written: once the database clock has reached the deadline it
 * raises SQLSTATE `AX001`, and PostgreSQL rolls the whole transaction back.
 *
 * Pure: no database, no `server-only`, so the two classifiers that must read
 * `AX001` before any "failed while committing" shortcut
 * (`withAmuxDbBoundary` and `autoTransactionFailure`) can share it.
 */

export const AMUX_COMMIT_DEADLINE_TABLE = "AmuxCommitDeadline";
export const AMUX_COMMIT_DEADLINE_TRIGGER = "amux_commit_deadline_check";
export const AMUX_LATE_COMMIT_SQLSTATE = "AX001";
/** The trigger's message. Classification reads the SQLSTATE, never this. */
export const AMUX_LATE_COMMIT_MESSAGE = "AMUX_LATE_COMMIT";

/** Enough for every wrapper Prisma and the pg adapter put around one error. */
const MAX_ERROR_NODES = 16;

/**
 * Whether PostgreSQL refused this COMMIT because the commit deadline had
 * passed. An `AX001` is a rollback the database has already made, so it is a
 * known outcome even though it arrives while committing.
 *
 * The code is found wherever it was put, walked structurally the way
 * `hasSqlstate` in lib/marketingPublisherRun.ts does:
 *
 * - at COMMIT, `prisma.$transaction` rejects with the pg adapter's own
 *   `DriverAdapterError`, whose `cause` is `{ kind: "postgres", code: "AX001",
 *   originalCode: "AX001" }` (@prisma/adapter-pg maps an SQLSTATE it does not
 *   know to that shape, and the transaction manager rethrows it unwrapped);
 * - from a raw statement, Prisma's `P2010`/`P2039` carries the same adapter
 *   error at `meta.driverAdapterError`;
 * - an older Prisma shape puts the SQLSTATE at `meta.code`;
 * - the pg driver's own error has it at `code`.
 *
 * Only the SQLSTATE decides. The message is not read, so a text that happens
 * to contain it cannot turn an unknown outcome into a rollback.
 */
export const isAmuxLateCommitError = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < MAX_ERROR_NODES) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.code === AMUX_LATE_COMMIT_SQLSTATE ||
      record.originalCode === AMUX_LATE_COMMIT_SQLSTATE
    ) {
      return true;
    }
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return false;
};
