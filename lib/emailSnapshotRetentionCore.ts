/**
 * How long a delivery keeps the inputs it was rendered from.
 *
 * Contract: docs/policy/email-notifications.md §10.3 rule 3, §13.2.
 *
 * The snapshot is what makes a sent message reproducible: re-reading the source
 * rows later renders *something current*, which is not what was sent -- the
 * name changed, the plan changed, and the amount was always a value from that
 * moment. Keeping it forever is a different mistake. It is envelope-encrypted
 * personalisation data about a person, and §10.3 gives it a life.
 *
 * Two windows, and the split is the point:
 *
 *   reproducible  snapshot + versions + hash -- the body can be rebuilt
 *   verify-only   hash + version references -- "we sent something with this
 *                 hash" and nothing more
 *
 * A purge moves a row from the first to the second. The row survives, the
 * `renderedHash` survives, and the fact that a legal notice was delivered
 * survives -- which is the point of §10.3 rule 4: a deletion request clears the
 * snapshot and leaves the proof of notice.
 *
 * Pure, and separate from the sweep, because the windows are a policy decision
 * and the SQL is not.
 */

/**
 * Days, by classification.
 *
 * `legal` is seven years and provisional (§21 Q6). It is longer than the others
 * because the message is the notice itself: an account-deletion notice has to
 * stay reproducible for as long as somebody might ask whether it was sent and
 * what it said.
 */
export const SNAPSHOT_RETENTION_DAYS = {
  transactional: 90,
  service: 90,
  marketing: 90,
  legal: 2555,
} as const;

export type SnapshotRetentionClassification = keyof typeof SNAPSHOT_RETENTION_DAYS;

/**
 * The window an unknown classification gets.
 *
 * The shortest, not the longest. A classification this module has not been
 * taught is one nobody decided a retention period for, and holding personal
 * data for seven years by accident is the worse direction to fail in -- while
 * purging early costs reproducibility of a message whose class is already
 * unclear. The database's own CHECK keeps the set closed, so this is a floor
 * rather than a path anything takes.
 */
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 90;

export const snapshotRetentionDays = (classification: string): number =>
  classification in SNAPSHOT_RETENTION_DAYS
    ? SNAPSHOT_RETENTION_DAYS[classification as SnapshotRetentionClassification]
    : DEFAULT_SNAPSHOT_RETENTION_DAYS;

/**
 * The longest window any classification has.
 *
 * The retention screen counts what is overdue against this, the way the usage
 * bucket policy uses its longest period: counting against 90 days would report
 * every legal delivery older than a quarter as overdue when the sweep was never
 * going to take it.
 */
export const LONGEST_SNAPSHOT_RETENTION_DAYS = Math.max(
  ...Object.values(SNAPSHOT_RETENTION_DAYS)
);

const DAY_MS = 86_400_000;

/** Deliveries older than this, for that classification, have lost the window. */
export const snapshotPurgeCutoff = (classification: string, now: Date): Date =>
  new Date(now.getTime() - snapshotRetentionDays(classification) * DAY_MS);

/** Every classification and its cutoff, for a sweep that runs them together. */
export const snapshotPurgeCutoffs = (now: Date) =>
  (
    Object.keys(SNAPSHOT_RETENTION_DAYS) as SnapshotRetentionClassification[]
  ).map((classification) => ({
    classification,
    days: SNAPSHOT_RETENTION_DAYS[classification],
    cutoff: snapshotPurgeCutoff(classification, now),
  }));
