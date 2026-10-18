import "server-only";

import type { Prisma } from "@prisma/client";

import {
  DM_ADMIN_REQUEST_LIST_LIMIT,
  dmAdminRequestRowFromRow,
  dmAdminRequestStatus,
  dmAdminSwitchLatchesFromRows,
  type DmAdminRequestList,
  type DmAdminRequestRow,
  type DmAdminSwitchLatches,
} from "@/lib/amux/decisionMakerAdminCore";
import {
  readDecisionMakerBodies,
  readDecisionMakerResultDetail,
  readDecisionMakerResultDetailsForAdmin,
} from "@/lib/amux/decisionMakerBodyStore";
import { parseDmCardText, type DmCard } from "@/lib/amux/decisionMakerCore";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";
import { readDecisionMakerJudgmentsForAdmin } from "@/lib/amux/decisionMakerJudgmentStore";
import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import {
  readDecisionMakerRequestState,
  readRecentDecisionMakerRequestLedger,
} from "@/lib/amux/decisionMakerRequestStore";
import {
  decisionMakerSwitchStateFromRows,
  type DecisionMakerSwitchState,
} from "@/lib/amux/decisionMakerSwitchCore";
import { readDecisionMakerSwitchRowsForAdmin } from "@/lib/amux/decisionMakerSwitchStore";

/**
 * Admin's request list for the AMUX Decision Maker, stage S2
 * (docs/policy/amux-decision-maker.md §6, §12; §6's table keeps "DM 기록 열람"
 * open under the kill switch).
 *
 * No SQL here: each table is read only by the store that owns it (§10: "단일
 * writer 모듈이 위 표들에 쓴다", and the tests that keep every other module away
 * from them). The request store reads the newest requests and their events;
 * the body store their result details; the judgment store their judgments and
 * delivery events. Called inside the AMUX DB boundary
 * `decisionMakerRequestListRead`, whose REPEATABLE READ snapshot makes the three
 * statements one view of the ledger. The joined row is checked as a whole: one
 * the ledger could not have produced refuses the list.
 */

type LedgerReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerAdminReadError extends Error {
  readonly code: "state_unreadable" | "invalid_input";

  constructor(code: DecisionMakerAdminReadError["code"]) {
    super(code);
    this.name = "DecisionMakerAdminReadError";
    this.code = code;
  }
}

/**
 * The switch panel's read (stage S2-4c): the switch state and, for each
 * instance, why the system turned it off when it did and no person has
 * released it since. One statement inside the AMUX DB boundary
 * `decisionMakerSwitchRead`, the same count as the state alone, so both come
 * from one snapshot of the newest events. A row the table's CHECKs could not
 * have produced leaves `latches` null (no reason is shown); the state is
 * mapped exactly as every other reader maps it.
 */
export async function readDecisionMakerSwitchesForAdmin(
  client: LedgerReader,
): Promise<{ state: DecisionMakerSwitchState; latches: DmAdminSwitchLatches | null }> {
  const rows = await readDecisionMakerSwitchRowsForAdmin(client);
  const state = decisionMakerSwitchStateFromRows(rows);
  // A state the mapping refuses is unreadable (every field null): no reason is
  // read from rows that state could not trust either.
  return { state, latches: state.killSwitch === null ? null : dmAdminSwitchLatchesFromRows(rows) };
}

export async function listDecisionMakerRequestsForAdmin(client: LedgerReader): Promise<DmAdminRequestList> {
  const ledger = await readRecentDecisionMakerRequestLedger(client, { limit: DM_ADMIN_REQUEST_LIST_LIMIT });
  const ids = ledger.rows.map((row) => row.id);
  if (!ids.every((id): id is string => typeof id === "string")) throw new DecisionMakerAdminReadError("state_unreadable");
  const details = await readDecisionMakerResultDetailsForAdmin(client, ids);
  const judgments = await readDecisionMakerJudgmentsForAdmin(client, ids);
  return {
    dbNowMs: ledger.dbNowMs,
    rows: ledger.rows.map((row) => joinedRow(row, details.get(row.id as string), judgments.get(row.id as string))),
  };
}

/**
 * One ledger row joined with its result detail and its judgment and delivery
 * records, checked as a whole. Every terminal result has its detail, written
 * in its own transaction and of its own kind (§6, stage S1d); a result
 * without one, a detail without a result, or a detail of another kind is a
 * ledger nobody can read, not a proposal with nothing to mark.
 */
const joinedRow = (
  row: Record<string, unknown>,
  detail: { resultKind: string; outputKind: string | null; irreversible: boolean | null } | undefined,
  judgment: Record<string, unknown> | undefined,
): DmAdminRequestRow => {
  if ((row.resultKind !== null) !== (detail !== undefined) || (detail && detail.resultKind !== row.resultKind)) {
    throw new DecisionMakerAdminReadError("state_unreadable");
  }
  const value = dmAdminRequestRowFromRow({
    ...row,
    outputKind: detail?.outputKind ?? null,
    irreversible: detail?.irreversible ?? null,
    ...judgment,
  });
  if (!value) throw new DecisionMakerAdminReadError("state_unreadable");
  return value;
};

export type DmAdminRequestDetail = {
  /** The database clock when the detail was read. */
  dbNowMs: number;
  row: DmAdminRequestRow;
  /** The card as it was routed (its card_text body); null when routed to the operator, or purged or erased. */
  card: DmCard | null;
  /** A free_text proposal's answer; a select names optionId instead. */
  answer: string | null;
  optionId: string | null;
  rationale: string | null;
  /** Admin only (§6: "이관 사유는 Admin에만 보이고 카드에는 가지 않는다"). */
  escalationReason: string | null;
  /** A person's edited answer, after an edited confirmation. */
  operatorAnswer: string | null;
  snapshotTargetSha: string | null;
  /**
   * What a person's judgment of this proposal must name (§6: it is recorded
   * only on the values Admin showed). Set only while the request is an open
   * proposal whose bodies and transmission are all there; null when there is
   * nothing to judge now.
   */
  shown: DmShownProposal | null;
};

/**
 * One request for the person who judges it (§6, stage S2), in five statements
 * inside the AMUX DB boundary decisionMakerRequestDetailRead, each read by the
 * store that owns its table: the ledger row (the same read and the same checks
 * as the list), the result detail, the judgment and delivery records, the
 * bodies, and the request state for the transmission's snapshot values. Null
 * when no such request exists. The bodies are returned to the caller and
 * never logged here.
 */
export async function readDecisionMakerRequestDetailForAdmin(
  client: LedgerReader,
  requestId: string,
): Promise<DmAdminRequestDetail | null> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerAdminReadError("invalid_input");
  const ledger = await readRecentDecisionMakerRequestLedger(client, { requestId });
  if (ledger.rows.length === 0) return null;
  const ledgerRow = ledger.rows[0]!;
  if (ledger.rows.length !== 1 || ledgerRow.id !== requestId) throw new DecisionMakerAdminReadError("state_unreadable");
  const detail = await readDecisionMakerResultDetail(client, requestId);
  const judgments = await readDecisionMakerJudgmentsForAdmin(client, [requestId]);
  const bodies = await readDecisionMakerBodies(client, requestId);
  const state = await readDecisionMakerRequestState(client, requestId);
  if (!state) throw new DecisionMakerAdminReadError("state_unreadable");

  const row = joinedRow(ledgerRow, detail ?? undefined, judgments.get(requestId));
  const body = (field: string) => bodies.find((entry) => entry.field === field) ?? null;
  const cardText = body("card_text");
  const card = cardText === null ? null : parseDmCardText(cardText.text);
  if (cardText !== null && card === null) throw new DecisionMakerAdminReadError("state_unreadable");
  const answer = body("dm_answer");
  const rationale = body("dm_rationale");

  let shown: DmShownProposal | null = null;
  if (
    dmAdminRequestStatus(row, ledger.dbNowMs) === "proposal" &&
    detail !== null &&
    detail.irreversible !== null &&
    state.transmission !== null &&
    rationale !== null &&
    (detail.outputKind !== "free_text" || answer !== null)
  ) {
    shown = {
      answerDigest: detail.outputKind === "free_text" ? answer!.digest : null,
      rationaleDigest: rationale.digest,
      optionId: detail.optionId,
      irreversible: detail.irreversible,
      snapshotState: state.transmission.snapshotState,
      snapshotTargetSha: state.transmission.snapshotTargetSha,
      snapshotManifestDigest: state.transmission.snapshotManifestDigest,
    };
  }
  return {
    dbNowMs: ledger.dbNowMs,
    row,
    card,
    answer: answer?.text ?? null,
    optionId: detail?.optionId ?? null,
    rationale: rationale?.text ?? null,
    escalationReason: body("dm_escalation_reason")?.text ?? null,
    operatorAnswer: body("operator_answer")?.text ?? null,
    snapshotTargetSha: state.transmission?.snapshotTargetSha ?? null,
    shown,
  };
}
