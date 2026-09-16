import "server-only";

import type { Prisma } from "@prisma/client";

import {
  holdSuppressionFenceExclusive,
  readSuppressionAuthority,
} from "@/lib/emailSuppressionAuthority";
import {
  isActiveCause,
  SUPPRESSION_READ_AUTHORITY_KEY,
  suppressionParity,
  type ParityFinding,
} from "@/lib/emailSuppressionAuthorityCore";
import { markCauseWriter, recordSuppressionCause } from "@/lib/emailSuppressionCauses";
import { prisma } from "@/lib/prisma";

/**
 * The deploy B gate and switch: compare, optionally repair, then move the read
 * authority to causes -- all under the exclusive fence.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.
 *
 * Every suppression writer takes the same fence in shared mode, so while this
 * holds it nothing can write under one authority and commit under the other,
 * and the comparison it reads is the state the switch applies to.
 */

export type CutoverReport = {
  authorityBefore: "entry" | "causes";
  authorityAfter: "entry" | "causes";
  entries: number;
  activeCauses: number;
  unsafe: ParityFinding[];
  stricter: number;
  repairedCauses: number;
  switched: boolean;
  refusal: "unsafe_mismatches" | null;
};

const loadParity = async (tx: Prisma.TransactionClient, now: Date) => {
  const [entries, causes] = await Promise.all([
    tx.suppressionEntry.findMany({
      select: {
        id: true,
        emailAddress: true,
        scope: true,
        purposeKey: true,
        reason: true,
        source: true,
        sourceStream: true,
        sourceDomain: true,
        sourceClassification: true,
        sourceDeliveryId: true,
        sourceMessageId: true,
        occurredAt: true,
        expiresAt: true,
        updatedAt: true,
      },
    }),
    tx.suppressionCause.findMany({
      where: { releasedAt: null },
      select: {
        emailAddress: true,
        scope: true,
        purposeKey: true,
        reason: true,
        sourceStream: true,
        expiresAt: true,
        releasedAt: true,
      },
    }),
  ]);
  return {
    entries,
    causes,
    parity: suppressionParity({
      entries: entries as Parameters<typeof suppressionParity>[0]["entries"],
      causes: causes as Parameters<typeof suppressionParity>[0]["causes"],
      now,
    }),
  };
};

export async function runSuppressionCutover(input: {
  apply: boolean;
  repair: boolean;
  now?: Date;
}): Promise<CutoverReport> {
  const now = input.now ?? new Date();
  return prisma.$transaction(
    async (tx) => {
      await holdSuppressionFenceExclusive(tx);
      const authorityBefore = await readSuppressionAuthority(tx);

      let { entries, causes, parity } = await loadParity(tx, now);
      let repairedCauses = 0;

      // Repair adds the entry's own reason as a cause wherever the causes would
      // let through what the entry stops. It never releases a cause: a cause
      // stricter than the entry is the history the entry's merge rule lost.
      if (input.repair && parity.unsafe.length > 0) {
        await markCauseWriter(tx);
        const unsafeSelectors = new Set(
          parity.unsafe.map((f) => `${f.emailAddress}\u0000${f.scope}\u0000${f.purposeKey}`)
        );
        for (const entry of entries) {
          const key = `${entry.emailAddress}\u0000${entry.scope}\u0000${entry.purposeKey}`;
          if (!unsafeSelectors.has(key)) continue;
          const wrote = await recordSuppressionCause(tx, {
            emailAddress: entry.emailAddress,
            scope: entry.scope as "global" | "purpose",
            purposeKey: entry.purposeKey,
            reason: entry.reason,
            source: entry.source,
            sourceEventKey: `reconcile:entry:${entry.id}:${entry.updatedAt.getTime()}`,
            sourceStream: entry.sourceStream,
            sourceDomain: entry.sourceDomain,
            sourceClassification: entry.sourceClassification,
            sourceDeliveryId: entry.sourceDeliveryId,
            sourceMessageId: entry.sourceMessageId,
            occurredAt: entry.occurredAt,
            expiresAt: entry.expiresAt,
          });
          if (wrote) repairedCauses += 1;
        }
        ({ entries, causes, parity } = await loadParity(tx, now));
      }

      const refusal = parity.unsafe.length > 0 ? ("unsafe_mismatches" as const) : null;
      const switched = input.apply && refusal === null && authorityBefore !== "causes";
      if (switched) {
        await tx.appSetting.upsert({
          where: { key: SUPPRESSION_READ_AUTHORITY_KEY },
          create: { key: SUPPRESSION_READ_AUTHORITY_KEY, value: "causes" },
          update: { value: "causes" },
        });
      }

      return {
        authorityBefore,
        authorityAfter: switched ? "causes" : authorityBefore,
        entries: entries.length,
        activeCauses: causes.filter((cause) => isActiveCause(cause, now)).length,
        unsafe: parity.unsafe,
        stricter: parity.stricter.length,
        repairedCauses,
        switched,
        refusal,
      };
    },
    // The exclusive fence waits for in-flight writers; give it room.
    { timeout: 60_000, maxWait: 30_000 }
  );
}
