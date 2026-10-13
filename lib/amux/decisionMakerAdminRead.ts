import "server-only";

import type { Prisma } from "@prisma/client";

import {
  DM_ADMIN_REQUEST_LIST_LIMIT,
  dmAdminRequestRowFromRow,
  type DmAdminRequestList,
} from "@/lib/amux/decisionMakerAdminCore";
import { readDecisionMakerResultDetailsForAdmin } from "@/lib/amux/decisionMakerBodyStore";
import { readDecisionMakerJudgmentsForAdmin } from "@/lib/amux/decisionMakerJudgmentStore";
import { readRecentDecisionMakerRequestLedger } from "@/lib/amux/decisionMakerRequestStore";

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
  readonly code: "state_unreadable";

  constructor(code: DecisionMakerAdminReadError["code"]) {
    super(code);
    this.name = "DecisionMakerAdminReadError";
    this.code = code;
  }
}

export async function listDecisionMakerRequestsForAdmin(client: LedgerReader): Promise<DmAdminRequestList> {
  const ledger = await readRecentDecisionMakerRequestLedger(client, { limit: DM_ADMIN_REQUEST_LIST_LIMIT });
  const ids = ledger.rows.map((row) => row.id);
  if (!ids.every((id): id is string => typeof id === "string")) throw new DecisionMakerAdminReadError("state_unreadable");
  const details = await readDecisionMakerResultDetailsForAdmin(client, ids);
  const judgments = await readDecisionMakerJudgmentsForAdmin(client, ids);
  return {
    dbNowMs: ledger.dbNowMs,
    rows: ledger.rows.map((row) => {
      const id = row.id as string;
      // Every terminal result has its detail, written in its own transaction
      // and of its own kind (§6, stage S1d); a result without one, a detail
      // without a result, or a detail of another kind is a ledger nobody can
      // read, not a proposal with nothing to mark.
      const detail = details.get(id);
      if ((row.resultKind !== null) !== (detail !== undefined) || (detail && detail.resultKind !== row.resultKind)) {
        throw new DecisionMakerAdminReadError("state_unreadable");
      }
      const value = dmAdminRequestRowFromRow({
        ...row,
        outputKind: detail?.outputKind ?? null,
        irreversible: detail?.irreversible ?? null,
        ...judgments.get(id),
      });
      if (!value) throw new DecisionMakerAdminReadError("state_unreadable");
      return value;
    }),
  };
}
