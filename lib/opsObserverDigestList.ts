/**
 * The recent kept sre-ops daily digests, newest first, for the SRE page's date
 * list. Same discipline as `readOpsObserverDigestItem`: this agent's rows of the
 * shared table only, one bounded `state_read` transaction, a body only while it
 * is inside its retention by the database clock, a body that no longer parses to
 * the closed shape shown as absent, and the deadline checked before anything is
 * returned. Read only.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { OpsObserverDigestView } from "@/lib/opsObserverDigest";
import { assertNotLate, withOpsObserverTransaction } from "@/lib/opsObserverTransaction";
import { DIGEST_KIND, parseStoredDigestPayload } from "@/scripts/ops-observer/digest-schema-core.mjs";

/** How many digests the date list holds; the screen says so. */
export const OPS_OBSERVER_DIGEST_LIST_LIMIT = 14;

export async function listOpsObserverDigests(
  limit: number = OPS_OBSERVER_DIGEST_LIST_LIMIT,
  client: PrismaClient = prisma,
  runDeadline: Date = new Date(Date.now() + 120_000),
): Promise<OpsObserverDigestView[]> {
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx): Promise<OpsObserverDigestView[]> => {
      const rows = await tx.$queryRaw<{ id: string; createdAt: Date; schemaVersion: number; payload: unknown }[]>`
        SELECT id::text AS id, "createdAt", "schemaVersion",
               CASE WHEN "retentionUntil" > clock_timestamp() THEN payload END AS payload
          FROM "AgentDigestItem"
         WHERE "agentKey" = 'sre-ops' AND kind = ${DIGEST_KIND}
         ORDER BY "createdAt" DESC
         LIMIT ${limit}`;
      return rows.map((row) => {
        const parsed =
          row.payload === null
            ? null
            : (parseStoredDigestPayload(row.payload, row.schemaVersion) as
                | { ok: true; payload: unknown; countsComplete: boolean }
                | { ok: false; error: string });
        return {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          payload: parsed && parsed.ok ? (parsed.payload as OpsObserverDigestView["payload"]) : null,
          countsComplete: parsed && parsed.ok ? parsed.countsComplete : true,
        };
      });
    },
    client,
  );
  await assertNotLate(runDeadline, client);
  return result;
}
