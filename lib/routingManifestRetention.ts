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
 * How many rows one sweep will compact.
 *
 * Bounded because this runs beside every other maintenance step on a shared
 * connection: a backlog is compacted over several runs rather than in one
 * statement that holds locks while a chat request waits behind it. The step
 * returns the count, so a backlog that is not shrinking is visible.
 */
export const MANIFEST_COMPACTION_BATCH = 500;

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
export const compactAgedContextManifests = async (
  now: Date = new Date(),
  batchSize: number = MANIFEST_COMPACTION_BATCH
): Promise<ManifestCompactionResult> => {
  const cutoff = new Date(now.getTime() - MANIFEST_DETAIL_RETENTION_MS);

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
    data: {
      sourceRefs: [],
      inclusionRange: Prisma.DbNull,
      truncationPoints: Prisma.DbNull,
      compactedAt: now,
    },
  });

  const remaining = await prisma.contextManifest.count({
    where: { compactedAt: null, createdAt: { lt: cutoff } },
  });

  return { compacted: result.count, remaining };
};

/**
 * MANIFEST-02's second metric: the age of the oldest manifest still holding
 * its detail, in days.
 *
 * Reported rather than asserted here, because the gate's threshold belongs to
 * the gate registry and a library that also decided it would be two sources of
 * one number. `null` when nothing is uncompacted, which is a pass and not a
 * missing measurement -- the difference matters to whoever reads the report.
 */
export const oldestUncompactedManifestAgeDays = async (
  now: Date = new Date()
): Promise<number | null> => {
  const oldest = await prisma.contextManifest.findFirst({
    where: { compactedAt: null },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (!oldest) return null;
  return (now.getTime() - oldest.createdAt.getTime()) / (24 * 60 * 60 * 1_000);
};
