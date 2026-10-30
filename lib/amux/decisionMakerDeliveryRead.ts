import "server-only";

import type { Prisma } from "@prisma/client";

import { readDecisionMakerBodies, readDecisionMakerResultDetail } from "@/lib/amux/decisionMakerBodyStore";
import {
  dmDeliveryCandidate,
  dmUnsettledDelivery,
  type DmDeliveryBodies,
  type DmDeliveryCandidate,
  type DmDeliveryCursor,
  type DmUnsettledDelivery,
} from "@/lib/amux/decisionMakerDeliveryCore";
import {
  DecisionMakerJudgmentWriteError,
  readNextDecisionMakerDeliveryJudgment,
  readNextDecisionMakerUnsettledDelivery,
} from "@/lib/amux/decisionMakerJudgmentStore";
import { readDecisionMakerRequestState } from "@/lib/amux/decisionMakerRequestStore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { isAmuxV22QuestionCard } from "@/lib/amux/v22OwnerQuestionDmService";

/**
 * Stage S2-2b3 (docs/policy/amux-decision-maker.md §2-7, §6, §7): the bridge's
 * read of the next operator-confirmed answer to deliver, composed from the
 * stores that own each table -- the switches from the switch store, the
 * confirmation from the judgment store, the request from the ledger's reader,
 * the result detail and the bodies from the body store. This file holds no
 * SQL and names no table; each store reads its own rows in one statement.
 *
 * §6's table: "bridge의 확정 답 조회·전달 — 거부" under the kill switch. The
 * kill switch is read first, and while it is on (or unreadable) nothing else
 * is read and no answer leaves the database. Reading an answer here releases
 * nothing: the bridge sends only after the delivery decision is recorded, and
 * that write reads the kill switch again under the audit chain lock.
 *
 * Statements, in this order on the caller's read transaction: 1 switch read
 * -- 1 under the kill switch; 1 confirmation read -- 2 when there is none; 1
 * request state, 1 result detail, 1 bodies -- 5; a ready one also asks
 * whether its card is a v22 worker's question card -- 6. Such a card is
 * answered in the app (lib/amux/v22OwnerQuestionDmService.ts) and never typed
 * into a session, so the walk steps past it as undeliverable. The DB boundary
 * is that 6, setup and fence (`decisionMakerDeliveryCandidateRead`), pinned
 * by tests/amuxDecisionMakerDelivery.test.mjs. A read transaction is one
 * snapshot, so the six agree with each other.
 *
 * The answer text is returned to the caller only; nothing here logs it.
 */

type DeliveryReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type DecisionMakerDeliveryRead =
  | { status: "kill_switch_on" }
  | { status: "none" }
  | DmDeliveryCandidate;

export async function readDecisionMakerDeliveryCandidate(
  client: DeliveryReader,
  input: { after: DmDeliveryCursor | null },
): Promise<DecisionMakerDeliveryRead> {
  let killSwitch: boolean | null;
  try {
    killSwitch = (await readDecisionMakerSwitchesOrThrow(client)).killSwitch;
  } catch {
    throw new DecisionMakerJudgmentWriteError("settings_unreadable");
  }
  // An unreadable switch store is not off.
  if (killSwitch === null) throw new DecisionMakerJudgmentWriteError("settings_unreadable");
  if (killSwitch) return { status: "kill_switch_on" };

  const judgment = await readNextDecisionMakerDeliveryJudgment(client, { after: input.after });
  if (!judgment) return { status: "none" };
  const state = await readDecisionMakerRequestState(client, judgment.requestId);
  const detail = await readDecisionMakerResultDetail(client, judgment.requestId);
  const stored = await readDecisionMakerBodies(client, judgment.requestId);
  const bodies: DmDeliveryBodies = {};
  for (const body of stored) {
    if (body.field === "dm_answer" || body.field === "operator_answer") bodies[body.field] = body.text;
  }
  const candidate = dmDeliveryCandidate({ judgment, state, detail, bodies });
  if (!candidate) throw new DecisionMakerJudgmentWriteError("state_unreadable");
  if (candidate.status === "ready" && await isAmuxV22QuestionCard(client, candidate.cardId)) {
    return { status: "undeliverable", requestId: candidate.requestId,
      judgedAtMs: candidate.judgedAtMs, reason: "v22_question_card" };
  }
  return candidate;
}

/**
 * Stage S2-2b4 (§9): the oldest delivery decision with no outcome, with §9's
 * binding -- what a bridge that stopped between a decision and its outcome
 * left behind, and settles at its next start from the local AMUX's own records
 * (the receipt of the request's message id, the question revision's answer
 * record), never by sending again. Two statements on the caller's read
 * transaction -- the decision from the judgment store, the request's state
 * from the ledger's reader -- so the DB boundary is 2 + setup + fence
 * (`decisionMakerDeliveryUnsettledRead`), pinned by
 * tests/amuxDecisionMakerDelivery.test.mjs. It returns no answer and reads no
 * switch: recording what already happened is allowed under the kill switch
 * (§6's table).
 */
export async function readDecisionMakerUnsettledDelivery(
  client: DeliveryReader,
): Promise<{ status: "none" } | DmUnsettledDelivery> {
  const decision = await readNextDecisionMakerUnsettledDelivery(client);
  if (!decision) return { status: "none" };
  const state = await readDecisionMakerRequestState(client, decision.requestId);
  const unsettled = dmUnsettledDelivery({ decision, state });
  if (!unsettled) throw new DecisionMakerJudgmentWriteError("state_unreadable");
  return unsettled;
}
