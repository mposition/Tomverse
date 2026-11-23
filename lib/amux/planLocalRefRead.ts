import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "./dbBoundary.ts";
import { amuxPlanCardRefsOf, EMPTY_AMUX_PLAN_CARD_REFS,
  type AmuxPlanCardRefs } from "./planLocalRefCore.ts";

/**
 * The cards an idea's plan registered, by the local id the plan named them
 * with (planLocalRefCore.ts). One statement. A read that fails leaves the
 * text as written: resolving the ids helps whoever reads the card, and is
 * never a reason to hold a delivery or a review back.
 */
export async function readAmuxPlanCardRefs(ideaId: string | null): Promise<AmuxPlanCardRefs> {
  if (!ideaId) return EMPTY_AMUX_PLAN_CARD_REFS;
  try {
    const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.planLocalRefRead, (tx) =>
      tx.$queryRaw<Array<{ localRef: string | null; displayKey: string | null; workItemId: string | null }>>`
        SELECT u."localRef", w."displayKey", w."id" AS "workItemId"
        FROM "AmuxIdeaDraftUnit" u
        JOIN "AmuxIdeaUnitDecision" d ON d."draftUnitId" = u."id"
        JOIN "AmuxWorkItem" w ON w."id" = d."registeredWorkItemId"
        WHERE u."ideaId" = ${ideaId} AND u."unitKind" = 'card' AND u."localRef" IS NOT NULL`);
    return amuxPlanCardRefsOf(rows);
  } catch {
    return EMPTY_AMUX_PLAN_CARD_REFS;
  }
}
