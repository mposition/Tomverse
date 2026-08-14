import "server-only";

/**
 * MANIFEST-02: aged manifests keep what an audit verifies with, and lose what
 * describes the request.
 *
 * §5 says detailed manifests are compacted after the retention period, and
 * that user deletion and memory deletion always take priority over audit
 * retention. Those are two different mechanisms and only one of them is a job:
 * deletion is already immediate and total, because `ContextManifest` hangs off
 * `RoutingAttempt` which hangs off `RoutingRun` which cascades from the
 * account. Nothing here has to remember to delete anything, and nothing here
 * may delay a deletion by holding a row for its retention window.
 *
 * ## What is kept, and why that is the right half
 *
 * Kept: the effective-request hash, the planner/adapter/template versions, the
 * tokenizer and its counts, the window the request was checked against, and
 * the lifecycle timestamps.
 *
 * Dropped: `sourceRefs`, `inclusionRange`, `truncationPoints` -- the per-part
 * detail.
 *
 * The split is not by size, although the dropped half is much the larger one.
 * It is by what each half lets somebody do. With the hash, anyone holding the
 * original request can still prove it is the request that was sent; that is
 * the manifest's whole purpose and it survives compaction intact. The source
 * references let somebody *describe* what was sent without holding it -- how
 * many parts, how large each was, what kind of file. That is the half closest
 * to the user's own content, and it is the half that stops being worth its
 * retention once the operational window has passed.
 *
 * ## Why a marker rather than an inference
 *
 * `sourceRefs` is emptied rather than nulled, because the column is NOT NULL,
 * and an empty array is exactly what a request with no source parts would
 * store. Without `compactedAt` the two would be indistinguishable, and a
 * manifest that read as "this dispatch described nothing" would be a false
 * record of a real request -- the misrepresentation §5 forbids. The database
 * enforces the pairing in both directions.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * MANIFEST-02's `detailed_manifest_retention_days_max <= 90`.
 *
 * The same window the other security audit trails use
 * (`EXPORT_AUDIT_RETENTION_MS`), and deliberately the gate's ceiling rather
 * than something under it: shortening it is a policy decision with its own
 * review, and picking a number below the stated maximum here would quietly
 * make that decision by accident.
 */
export const MANIFEST_DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export const MANIFEST_DETAIL_RETENTION_DAYS =
  MANIFEST_DETAIL_RETENTION_MS / (24 * 60 * 60 * 1_000);

/**
 * How far before the ceiling the sweep actually compacts.
 *
 * A sweep that targeted exactly ninety days would leave every row sitting at
 * ninety-point-something until the next run, and on a daily schedule that is a
 * day of quiet violation. The headroom is the sweep interval: compact at
 * eighty-nine so the ceiling is met even if a run is missed by a cycle.
 *
 * Raise this if the sweep runs less often than daily. The relationship is the
 * point -- headroom is not a safety margin somebody picked, it is the interval
 * the schedule actually runs at.
 */
export const MANIFEST_COMPACTION_HEADROOM_MS = 24 * 60 * 60 * 1_000;

export const MANIFEST_COMPACTION_TARGET_MS =
  MANIFEST_DETAIL_RETENTION_MS - MANIFEST_COMPACTION_HEADROOM_MS;

/**
 * How many rows one sweep will compact.
 *
 * Bounded because this runs beside every other maintenance step on a shared
 * connection: a backlog is compacted over several runs rather than in one
 * statement that holds locks while a chat request waits behind it. The step
 * returns the count, so a backlog that is not shrinking is visible.
 */
export const MANIFEST_COMPACTION_BATCH = 500;

/**
 * Why a manifest's detail went.
 *
 * `aged` is the retention sweep. The other two are §5's privacy transitions,
 * which outrank the retention window entirely -- they do not wait ninety days
 * and they do not ask whether the row is old.
 *
 * Account deletion is deliberately absent. It removes the row through the
 * cascade rather than compacting it, so no compacted manifest is ever left to
 * carry it, and a value nothing can produce would be a category that is always
 * zero for a reason nobody could work out from the data.
 */
export const MANIFEST_COMPACTION_REASONS = [
  "aged",
  "memory_deleted",
  "memory_superseded",
] as const;

export type ManifestCompactionReason = (typeof MANIFEST_COMPACTION_REASONS)[number];

/**
 * What survives compaction, as a list rather than as whatever the update
 * happens not to mention.
 *
 * An allowlist because the failure is silent and additive: a column added
 * later that carries a message id, a memory id or a summary label would keep
 * being written past the retention window simply because nobody thought to
 * clear it. Naming what stays makes the next column's author decide, and the
 * test below fails when a new column belongs to neither list.
 */
export const MANIFEST_COMPACTION_KEEPS = [
  "id",
  "attemptId",
  "userId",
  "state",
  "tokenizerVersion",
  "tokenCount",
  "contextWindowTokens",
  "plannerVersion",
  "templateVersion",
  "adapterVersion",
  "structuredOptionsHash",
  "effectiveRequestHash",
  "contentHashVersion",
  "hashAlgorithm",
  "hashKeyId",
  "finalizedAt",
  "notDispatchedReason",
  "compactedAt",
  "compactionReason",
  "createdAt",
  "updatedAt",
] as const;

/**
 * What compaction clears.
 *
 * `summaryVersion` is here and not above, which is the entry worth explaining.
 * It names the template a truncated conversation was condensed with -- a fact
 * about how the user's own text was reduced, not about which adapter spoke to
 * which provider. It sits with the source references, not with the versions.
 */
export const MANIFEST_COMPACTION_CLEARS = [
  "sourceRefs",
  "inclusionRange",
  "truncationPoints",
  "summaryVersion",
] as const;

export type ManifestCompactionResult = {
  compacted: number;
  /** Rows still past the window after this batch. Zero means caught up. */
  remaining: number;
};

/**
 * Compacts manifests whose detail has outlived the retention window.
 *
 * `updateMany` with `compactedAt: null` in the filter, so a row cannot be
 * compacted twice and two overlapping sweeps cannot both count the same row.
 * Age is measured from `createdAt` rather than from `finalizedAt`: a draft
 * that was never finalized is still a record of an attempt, and leaving it
 * uncompacted forever because it never reached a provider would keep detail
 * about exactly the requests that failed.
 */
/** Everything `MANIFEST_COMPACTION_CLEARS` names, plus the marker and reason. */
export const compactionPatch = (now: Date, reason: ManifestCompactionReason) => ({
  sourceRefs: [],
  inclusionRange: Prisma.DbNull,
  truncationPoints: Prisma.DbNull,
  summaryVersion: null,
  compactedAt: now,
  compactionReason: reason,
});

/**
 * §5's privacy transition: memory deletion and supersession outrank the
 * retention window.
 *
 * Scoped to the whole account's detailed manifests rather than to the
 * manifests that used the deleted memory, because nothing links the two. A
 * manifest records digests of what was sent; a memory item is a row in another
 * table; and `Message.memoryUsedCount` is a count, not an attribution. With no
 * relation to follow, the choice is between compacting more than strictly
 * necessary and compacting nothing -- and §5 says this outranks retention, so
 * it is the first.
 *
 * That is deliberately conservative and deliberately cheap to make precise
 * later: when an authorized-source relation exists, the `where` narrows and
 * nothing else here changes. Building it now means the propagation is in place
 * before memory injection ships rather than after.
 */
export const compactManifestsForMemoryChange = async (
  userId: string,
  reason: Extract<ManifestCompactionReason, "memory_deleted" | "memory_superseded">,
  now: Date = new Date()
): Promise<number> => {
  const result = await prisma.contextManifest.updateMany({
    where: { userId, compactedAt: null },
    data: compactionPatch(now, reason),
  });
  return result.count;
};

export const compactAgedContextManifests = async (
  now: Date = new Date(),
  batchSize: number = MANIFEST_COMPACTION_BATCH
): Promise<ManifestCompactionResult> => {
  const cutoff = new Date(now.getTime() - MANIFEST_COMPACTION_TARGET_MS);

  const candidates = await prisma.contextManifest.findMany({
    where: { compactedAt: null, createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  if (candidates.length === 0) {
    return { compacted: 0, remaining: 0 };
  }

  const result = await prisma.contextManifest.updateMany({
    where: { id: { in: candidates.map((row) => row.id) }, compactedAt: null },
    data: compactionPatch(now, "aged"),
  });

  const remaining = await prisma.contextManifest.count({
    where: { compactedAt: null, createdAt: { lt: cutoff } },
  });

  return { compacted: result.count, remaining };
};

/**
 * MANIFEST-02's retention evidence.
 *
 * Three numbers, because the one this started with could not support the
 * claim. "How old is the oldest row still holding detail" is a snapshot: a row
 * that sat at ninety-five days and was then compacted disappears from it, and
 * with it the record that the ceiling was ever breached. A compliance metric
 * that forgets its own violations is not one.
 *
 * So the worst case is measured on both sides -- what compacted rows actually
 * experienced, and what uncompacted rows are experiencing now -- and the
 * breaches are counted rather than inferred.
 *
 * Measured in milliseconds and compared in milliseconds. Flooring to days is
 * how 90.9 becomes 90 and a violation becomes a pass.
 */
export type ManifestRetentionMetrics = {
  /** Worst retention any compacted manifest actually got, in ms. */
  worstCompletedRetentionMs: number | null;
  /** Worst retention currently in progress, in ms. */
  worstOpenRetentionMs: number | null;
  /** Rows that were, or are, past the ceiling. */
  violations: number;
  detailedRows: number;
  compactedRows: number;
};

/**
 * The retention start is `finalizedAt` where there is one and `createdAt`
 * otherwise. A draft that never finalized is still a record with detail in it,
 * and measuring it from a timestamp it does not have would exclude exactly the
 * rows nothing ever closed.
 */
export const manifestRetentionMetrics = async (
  now: Date = new Date()
): Promise<ManifestRetentionMetrics> => {
  const rows = await prisma.$queryRaw<
    {
      worst_completed: bigint | null;
      worst_open: bigint | null;
      violations: bigint;
      detailed_rows: bigint;
      compacted_rows: bigint;
    }[]
  >`
    SELECT
      MAX(EXTRACT(EPOCH FROM ("compactedAt" - COALESCE("finalizedAt", "createdAt"))) * 1000)
        FILTER (WHERE "compactedAt" IS NOT NULL)::bigint AS worst_completed,
      MAX(EXTRACT(EPOCH FROM (${now}::timestamp - COALESCE("finalizedAt", "createdAt"))) * 1000)
        FILTER (WHERE "compactedAt" IS NULL)::bigint AS worst_open,
      COUNT(*) FILTER (
        WHERE EXTRACT(EPOCH FROM (
          COALESCE("compactedAt", ${now}::timestamp) - COALESCE("finalizedAt", "createdAt")
        )) * 1000 > ${MANIFEST_DETAIL_RETENTION_MS}
      )::bigint AS violations,
      COUNT(*) FILTER (WHERE "compactedAt" IS NULL)::bigint AS detailed_rows,
      COUNT(*) FILTER (WHERE "compactedAt" IS NOT NULL)::bigint AS compacted_rows
    FROM "ContextManifest"
  `;
  const row = rows[0];
  return {
    worstCompletedRetentionMs:
      row?.worst_completed === null || row?.worst_completed === undefined
        ? null
        : Number(row.worst_completed),
    worstOpenRetentionMs:
      row?.worst_open === null || row?.worst_open === undefined
        ? null
        : Number(row.worst_open),
    violations: Number(row?.violations ?? 0),
    detailedRows: Number(row?.detailed_rows ?? 0),
    compactedRows: Number(row?.compacted_rows ?? 0),
  };
};

/**
 * MANIFEST-02's first metric, with the denominator it needs.
 *
 * "The sweep compacted N rows" is not a success rate. A rate needs a window, a
 * count of runs that were supposed to happen, and a count that finished --
 * and the third is the only one the row count says anything about. A sweep
 * that threw on every run still reports a compaction count of zero, which
 * reads identically to a sweep that found nothing to do.
 *
 * The compaction rides the `retention_cleanup` job, so that job's own run
 * history is the record. Failures include runs still marked `running` past
 * the window: a job that never reported is a job that did not succeed, and
 * counting it as neither would make the rate a measure of the runs that
 * managed to write a result.
 */
export const RETENTION_JOB_KEY = "retention_cleanup";

export type ManifestCompactionJobHealth = {
  windowDays: number;
  runs: number;
  succeeded: number;
  failed: number;
  /** Null rather than 100 when nothing ran: no runs is not a clean record. */
  successPercent: number | null;
};

export const manifestCompactionJobHealth = async (
  windowDays = 30,
  now: Date = new Date()
): Promise<ManifestCompactionJobHealth> => {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000);
  const grouped = await prisma.scheduledJobRun.groupBy({
    by: ["status"],
    where: { jobKey: RETENTION_JOB_KEY, startedAt: { gte: since } },
    _count: { _all: true },
  });

  const byStatus = Object.fromEntries(
    grouped.map((row) => [row.status, row._count._all])
  );
  const succeeded = byStatus.succeeded ?? byStatus.success ?? byStatus.completed ?? 0;
  const runs = grouped.reduce((total, row) => total + row._count._all, 0);

  return {
    windowDays,
    runs,
    succeeded,
    failed: runs - succeeded,
    // A rate over no runs is not 100%, it is unmeasured. Reporting the first
    // would make a job nobody scheduled look like a job that never failed.
    successPercent: runs === 0 ? null : (succeeded / runs) * 100,
  };
};
