import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { amuxNodeTitleSelect, readAmuxNodeTitles } from "@/lib/amux/adminExecutionRead";
import { amuxCanonicalJson } from "@/lib/amux/boardImportCore";
import { allocateAmuxCardDisplayKey } from "@/lib/amux/cardDisplayKeyAllocator";
import {
  amuxCardDisplayKeyBackfillBinding,
  planAmuxCardDisplayKeyBackfill,
  type AmuxBackfillPlan,
} from "@/lib/amux/cardDisplayKeyBackfillCore";
import { prisma } from "@/lib/prisma";

/**
 * The card number backfill (docs/policy/amux-card-display-key.md §5): the
 * owner sees the plan, and applying it writes exactly that plan in one
 * transaction with a human audit entry, or nothing.
 */

export const AMUX_CARD_DISPLAY_BACKFILL_AUDIT_ACTION = "amux.card_display_key.backfill";

export class AmuxCardDisplayKeyBackfillError extends Error {
  constructor(readonly code: "plan_changed" | "nothing_to_apply" | "write_conflict",
    readonly httpStatus: number) {
    super(code);
  }
}

type Reader = Pick<Prisma.TransactionClient, "amuxPortfolioNode" | "amuxWorkItem" | "amuxCardDisplayKeyCounter">;

async function readPlan(db: Reader): Promise<{ plan: AmuxBackfillPlan; digest: string }> {
  const [features, cards, counters, held] = await Promise.all([
    db.amuxPortfolioNode.findMany({ where: { level: "feature" },
      select: { ...amuxNodeTitleSelect, displayPrefix: true, createdAt: true } }),
    db.amuxWorkItem.findMany({ where: { displayKey: null },
      select: { id: true, displayKey: true, sourceSystem: true,
        parentFeatureNodeId: true, createdAt: true } }),
    db.amuxCardDisplayKeyCounter.findMany({ select: { prefix: true, lastNumber: true } }),
    db.amuxPortfolioNode.findMany({ where: { displayPrefix: { not: null } },
      select: { displayPrefix: true } }),
  ]);
  // Only Features still without a prefix need their title.
  const untitled = features.filter((feature) => feature.displayPrefix === null);
  const titles = await readAmuxNodeTitles(untitled);
  const titleById = new Map(untitled.map((feature, index) => [feature.id, titles[index] ?? null]));
  const plan = planAmuxCardDisplayKeyBackfill({
    features: features.map((feature) => ({ id: feature.id,
      title: titleById.get(feature.id) ?? null,
      displayPrefix: feature.displayPrefix,
      createdAt: feature.createdAt.toISOString() })),
    cards: cards.map((card) => ({ ...card, createdAt: card.createdAt.toISOString() })),
    counters: Object.fromEntries(counters.map((row) => [row.prefix, row.lastNumber])),
    takenPrefixes: held.flatMap((row) => row.displayPrefix === null ? [] : [row.displayPrefix]),
  });
  const digest = createHash("sha256")
    .update(amuxCanonicalJson(amuxCardDisplayKeyBackfillBinding(plan)), "utf8")
    .digest("hex");
  return { plan, digest };
}

/** The dry run: what the backfill would write now, and the digest an apply must name. */
export function previewAmuxCardDisplayKeyBackfill() {
  return readPlan(prisma);
}

export async function applyAmuxCardDisplayKeyBackfill(input: {
  session: Session; request: Request; expectedDigest: string;
}): Promise<{ auditId: string; features: number; cards: number; unresolved: number }> {
  return prisma.$transaction(async (tx) => {
    // One backfill at a time; a card writer allocating meanwhile simply moves
    // the counters, which changes the plan and refuses this apply.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('amux-card-display-key-backfill'))`;
    const { plan, digest } = await readPlan(tx);
    if (digest !== input.expectedDigest) throw new AmuxCardDisplayKeyBackfillError("plan_changed", 409);
    if (plan.features.length === 0 && plan.cards.length === 0) {
      throw new AmuxCardDisplayKeyBackfillError("nothing_to_apply", 409);
    }
    const perPrefix: Record<string, number> = {};
    for (const card of plan.cards) perPrefix[card.prefix] = (perPrefix[card.prefix] ?? 0) + 1;
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: AMUX_CARD_DISPLAY_BACKFILL_AUDIT_ACTION,
      targetType: "AmuxCardDisplayKeyBackfill", targetId: digest,
      summary: "Applied an owner-approved AMUX card number backfill.",
      metadata: { planDigest: digest, planVersion: plan.version,
        featurePrefixes: plan.features.map(({ id, prefix }) => ({ id, prefix })),
        cardCount: plan.cards.length, cardsPerPrefix: perPrefix,
        unresolvedCount: plan.unresolved.length },
    });
    // Raw UPDATEs so `updatedAt` and every other column stay as they were (§5).
    for (const feature of plan.features) {
      const written = await tx.$executeRaw`
        UPDATE "AmuxPortfolioNode" SET "displayPrefix" = ${feature.prefix}
        WHERE "id" = ${feature.id} AND "level" = 'feature' AND "displayPrefix" IS NULL`;
      if (written !== 1) throw new AmuxCardDisplayKeyBackfillError("write_conflict", 409);
    }
    for (const card of plan.cards) {
      const displayKey = await allocateAmuxCardDisplayKey(tx, card.prefix);
      if (displayKey !== card.displayKey) throw new AmuxCardDisplayKeyBackfillError("write_conflict", 409);
      const written = await tx.$executeRaw`
        UPDATE "AmuxWorkItem" SET "displayKey" = ${displayKey}
        WHERE "id" = ${card.id} AND "displayKey" IS NULL`;
      if (written !== 1) throw new AmuxCardDisplayKeyBackfillError("write_conflict", 409);
    }
    return { auditId, features: plan.features.length, cards: plan.cards.length,
      unresolved: plan.unresolved.length };
  }, { maxWait: 5_000, timeout: 120_000 });
}
