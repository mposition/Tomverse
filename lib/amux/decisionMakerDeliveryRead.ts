import "server-only";

import type { Prisma } from "@prisma/client";

import { readDecisionMakerBodies, readDecisionMakerResultDetail } from "@/lib/amux/decisionMakerBodyStore";
import {
  dmDeliveryCandidate,
  type DmDeliveryBodies,
  type DmDeliveryCandidate,
  type DmDeliveryCursor,
} from "@/lib/amux/decisionMakerDeliveryCore";
import {
  DecisionMakerJudgmentWriteError,
  readNextDecisionMakerDeliveryJudgment,
} from "@/lib/amux/decisionMakerJudgmentStore";
import { readDecisionMakerRequestState } from "@/lib/amux/decisionMakerRequestStore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";

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
 * request state, 1 result detail, 1 bodies -- 5. The DB boundary is that 5,
 * setup and fence (`decisionMakerDeliveryCandidateRead`), pinned by
 * tests/amuxDecisionMakerDelivery.test.mjs. A read transaction is one
 * snapshot, so the five agree with each other.
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
  return candidate;
}
