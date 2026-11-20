import "server-only";

import type { Session } from "next-auth";

import {
  acknowledgeEngineeringAgentDecision, decideEngineeringAgentT2Draft, runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

/**
 * After the owner settles a card (legacyCardOwnerService.ts), the engineering
 * agent's own owner items for that card's runs have nothing left to decide:
 * an open T2 draft is rejected and an open decision acknowledged, each through
 * the engineering store's existing audited writer in its own transaction. A
 * publish item is left to its own state machine. This runs after the card's
 * transaction commits and never undoes it: an item that moved meanwhile, or a
 * store refusal, is counted and left for the engineering console.
 */
export async function closeEngineeringOwnerItemsForSettledCard(input: {
  session: Session; request: Request; taskId: string;
}): Promise<{ draftsRejected: number; decisionsAcknowledged: number; left: number }> {
  const items = await prisma.engineeringAgentWorkItem.findMany({
    where: { state: "open", kind: { in: ["t2_draft", "decision"] }, run: { cardId: input.taskId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200,
    select: { id: true, kind: true, patchDigest: true, baseSha: true },
  });
  const result = { draftsRejected: 0, decisionsAcknowledged: 0, left: 0 };
  for (const item of items) {
    try {
      if (item.kind === "decision") {
        await runEngineeringAgentTransaction(prisma, (tx) => acknowledgeEngineeringAgentDecision(tx,
          { session: input.session, request: input.request, workItemId: item.id }));
        result.decisionsAcknowledged += 1;
      } else if (item.patchDigest !== null && item.baseSha !== null) {
        const { patchDigest, baseSha } = item;
        await runEngineeringAgentTransaction(prisma, (tx) => decideEngineeringAgentT2Draft(tx,
          { session: input.session, request: input.request, workItemId: item.id, decision: "rejected",
            patchDigest, baseSha }));
        result.draftsRejected += 1;
      } else result.left += 1;
    } catch { result.left += 1; }
  }
  return result;
}
