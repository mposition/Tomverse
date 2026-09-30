export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import {
  isAmuxOrchestratorUuid,
  parseAmuxOrchestratorHaltRecord,
} from "@/lib/amux/orchestratorHaltCore";
import {
  openAmuxOrchestratorHalt,
  readAmuxOrchestratorHaltStateResolved,
} from "@/lib/amux/orchestratorHaltService";
import type { AmuxOrchestratorHaltRow } from "@/lib/amux/orchestratorHaltStore";

/**
 * The orchestrator's halt record and halt state
 * (docs/policy/development-agent-orchestration.md, version 20, section 5).
 *
 * `POST` opens one halt with the system audit `amux.orchestrator.halted` in
 * the same transaction; sending the same `halt_key` again returns the halt
 * already recorded. It inserts only: there is no field, action or path here
 * that clears a halt, which only a person can do from the Admin console.
 *
 * `GET` first applies the resolver to admissions past their deadline, then
 * returns the open halts, the undecided admissions (count, latest deadline and
 * how long until it has passed plus the grace), the requests a person has to
 * confirm, and -- for each `halt_key` asked about -- whether that halt is
 * recorded and cleared by a person. An empty list is not a clear: the
 * orchestrator releases a halt it recorded only on reading it as cleared.
 */

const OPERATION = "orchestrator_halt";

/** The halt keys one state read may ask about. */
const MAX_HALT_KEYS = 16;

const recordSchema = z
  .object({
    halt_key: z.string(),
    reason_code: z.string(),
    request_id: z.string().nullable().optional(),
  })
  .strict();

const haltBody = (halt: AmuxOrchestratorHaltRow) => ({
  halt_id: halt.haltId,
  halt_key: halt.haltKey,
  reason_code: halt.reasonCode,
  request_id: halt.requestId,
  opened_at: halt.openedAt,
});

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 1_024, recordSchema);
      const record = parseAmuxOrchestratorHaltRecord(body);
      if (!record) return amuxJsonNoStore({ error: "Invalid request." }, 400);
      const { halt, created } = await openAmuxOrchestratorHalt(record);
      return amuxJsonNoStore({ ...haltBody(halt), cleared: halt.cleared, created });
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse(OPERATION, error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

export async function GET(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  const params = new URL(request.url).searchParams;
  const haltKeys = params.getAll("halt_key");
  if (
    [...params.keys()].some((key) => key !== "halt_key") ||
    haltKeys.length > MAX_HALT_KEYS ||
    !haltKeys.every(isAmuxOrchestratorUuid) ||
    new Set(haltKeys).size !== haltKeys.length
  ) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }

  return withAmuxRouteBudget(async () => {
    try {
      const state = await readAmuxOrchestratorHaltStateResolved(haltKeys);
      return amuxJsonNoStore({
        open_halt_count: state.openHaltCount,
        open_halts: state.openHalts.map(haltBody),
        pending_count: state.pendingCount,
        latest_deadline_at: state.latestDeadlineAt,
        retry_after_ms: state.retryAfterMs,
        human_required_count: state.humanRequiredCount,
        human_required: state.humanRequired.map((row) => ({
          request_id: row.requestId,
          call_kind: row.callKind,
          receipt_count: row.receiptCount,
        })),
        halts: state.halts.map((row) => ({
          halt_key: row.haltKey,
          halt_id: row.haltId,
          cleared: row.cleared,
        })),
      });
    } catch (error) {
      return amuxInternalErrorResponse(OPERATION, error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
