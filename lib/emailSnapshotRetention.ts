import "server-only";

import { prisma } from "@/lib/prisma";
import { snapshotPurgeCutoffs } from "@/lib/emailSnapshotRetentionCore";

/**
 * Clears the personalisation inputs of deliveries whose window has passed.
 *
 * Contract: docs/policy/email-notifications.md §10.3 rule 3, §13.2.
 *
 * A purge moves a delivery from the reproducible window to the verify-only
 * one. The row stays, `renderedHash` stays, and the fact that a notice was
 * sent stays -- which is what rule 4 asks for when a deletion request arrives:
 * clear the snapshot, keep the proof of notice.
 *
 * Age is measured from the send, falling back to when the row was written. A
 * delivery that never sent holds the same personal data, and keeping it
 * forever because the send failed would be the wrong way round.
 *
 * One statement per classification rather than one with a CASE, because the
 * windows are per classification and a single query would hide which of them
 * took a row.
 */
export async function purgeExpiredRenderSnapshots(now: Date = new Date()) {
  let cleared = 0;
  for (const { classification, cutoff } of snapshotPurgeCutoffs(now)) {
    // The cutoff is computed in TypeScript and bound as a timestamp rather
    // than assembled in SQL. `make_interval(days => $1)` binds its argument as
    // text and fails wherever the planner cannot infer otherwise, which is how
    // the same expression worked here and threw in the admin count query.
    const affected = await prisma.$executeRaw`
      UPDATE "EmailDelivery" AS d
         SET "renderDataSnapshot" = NULL,
             "snapshotPurgedAt" = ${now}
        FROM "TemplateVersion" AS v
        JOIN "EmailTemplate" AS t ON t."id" = v."templateId"
       WHERE d."templateVersionId" = v."id"
         AND t."classification" = ${classification}
         AND d."renderDataSnapshot" IS NOT NULL
         AND COALESCE(d."sentAt", d."createdAt") < ${cutoff}
    `;
    cleared += Number(affected);
  }
  return cleared;
}
