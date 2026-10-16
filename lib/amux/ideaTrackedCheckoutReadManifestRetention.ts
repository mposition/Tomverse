import "server-only";

import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError, readAmuxContentPurgeOutcome,
  retireVerifiedAmuxContentKey,
  type AmuxRetirableContent } from "./ideaContentKeyRetirementService.ts";
import { AMUX_READ_MANIFEST_RETENTION_MS,
  commitAmuxDueReadManifestPurge } from
  "./ideaTrackedCheckoutReadManifestStore.ts";

const BATCH_SIZE = 8;

function keyIdentity(ideaId: string, manifestId: string): AmuxRetirableContent {
  return { ideaId, purpose: "repository_read_manifest", subjectId: manifestId };
}

/** A missing/uncertain S3 outcome stops this tick. Pending durable key
 * retirements are processed before another body is purged. */
export async function purgeDueAmuxReadManifests() {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: "repository_read_manifest", keyDeletedAt: null },
    orderBy: [{ bodyPurgedAt: "asc" }, { ideaId: "asc" }],
    take: BATCH_SIZE, select: { ideaId: true, subjectId: true },
  });
  let keysDeleted = 0;
  for (const row of pending) {
    await retireVerifiedAmuxContentKey(keyIdentity(row.ideaId, row.subjectId));
    keysDeleted += 1;
  }
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  const now = nowRows[0]?.now;
  if (!now) throw new AmuxContentRetirementError("integrity_unavailable");
  const due = await prisma.amuxIdeaTrackedCheckoutReadManifest.findMany({
    where: { ciphertext: { not: null }, bodyPurgedAt: null,
      idea: { submittedAt: { lte: new Date(now.getTime() - AMUX_READ_MANIFEST_RETENTION_MS) },
        retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now } } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE - pending.length, select: { id: true, ideaId: true },
  });
  let bodiesPurged = 0;
  for (const row of due) {
    const target = keyIdentity(row.ideaId, row.id);
    try {
      const result = await prisma.$transaction((tx) =>
        commitAmuxDueReadManifestPurge(tx, row.id),
      { maxWait: 3_000, timeout: 12_000 });
      if (result === "purged") {
        bodiesPurged += 1;
        await retireVerifiedAmuxContentKey(target);
        keysDeleted += 1;
      }
    } catch (error) {
      if (error instanceof AmuxContentRetirementError &&
          error.code === "key_store_unavailable") throw error;
      const readBack = await readAmuxContentPurgeOutcome(target)
        .catch(() => "unavailable" as const);
      throw new AmuxContentRetirementError("outcome_unknown", target, readBack);
    }
  }
  return { bodiesPurged, keysDeleted, scanned: pending.length + due.length,
    batchLimit: BATCH_SIZE };
}
