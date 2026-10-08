/**
 * The sre-ops daily digest intake (docs/policy/sre-ops.md §1 item 3, §3 rules
 * 4, 7, 8 and 10, §6, §10).
 *
 * The digest service only names a closed owner date; the app builds the
 * digest from its own reads, so a caller can neither invent nor hide
 * anything in it:
 *
 *   1. The chain is trusted, read for that date (§3 rule 7); anything else
 *      stores nothing and answers the reason. The read carries the date's
 *      reserved items, final because the date is closed (the advance parser
 *      admits a reservation only for today, or yesterday within a run
 *      deadline of midnight).
 *   2. The readiness checks that are not page keys come from the same
 *      function /api/ready runs, at submission time.
 *   3. The shared store writes the row and its system audit entry in one
 *      transaction. Its admission arms that transaction with the
 *      digest_submit timers and start budget (§6 items 1-4); its last write
 *      is this agent's run guard row, whose deferred trigger refuses the
 *      COMMIT once the database clock is past the deadline (§6 item 5) -- so
 *      a late digest leaves no row, shared or own. The answer is given only
 *      after the separate short deadline check.
 *
 * The idempotency key and the run guard key are both the owner date, so a
 * repeated run is `replayed`.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";
import { readOpsObserverState, type OpsObserverDailyBudget } from "@/lib/opsObserverStore";
import { OpsObserverLateError, armOpsObserverTransaction, assertNotLate } from "@/lib/opsObserverTransaction";
import { computeReadinessChecks } from "@/lib/readinessChecks";
import {
  DIGEST_KIND,
  DIGEST_SCHEMA_VERSION,
  buildDigestPayload,
  digestIdempotencyKey,
  parseDigestPayload,
} from "@/scripts/ops-observer/digest-schema-core.mjs";
import { digestReadinessNames } from "@/scripts/ops-observer/envelope-schema-core.mjs";
import { settleWithin } from "@/scripts/ops-observer/snapshot-core.mjs";

export type OpsObserverDigestResult =
  | { result: "created" | "replayed"; itemId: string }
  | { result: "conflict" | "refused" }
  | { result: "untrusted"; trust: string };

/** The PostgreSQL SQLSTATE an error carries, by code only. */
function sqlStateOf(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  for (const candidate of [cause?.originalCode, cause?.code, e?.code]) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return null;
}

export async function submitOpsObserverDigest(
  input: { runDeadline: Date; ownerDate: string },
  client: PrismaClient = prisma,
): Promise<OpsObserverDigestResult> {
  const state = await readOpsObserverState(input.runDeadline, client, input.ownerDate);
  if (state.trust !== "trusted" || !("budget" in state) || !state.budget) {
    return { result: "untrusted", trust: state.trust };
  }
  const budget: OpsObserverDailyBudget = state.budget;

  const readiness = (await settleWithin(computeReadinessChecks())) as
    | { status: "fulfilled"; value: { checks?: Record<string, unknown> } | null }
    | { status: "rejected"; reason: unknown };
  const checks = readiness.status === "fulfilled" ? (readiness.value?.checks ?? null) : null;
  const payload = buildDigestPayload({
    ownerDate: input.ownerDate,
    mode: state.mode,
    readiness: checks ?? "unknown",
    digestNames: checks ? digestReadinessNames({ readiness: checks }) : [],
    budget,
  });
  // The app's own shape: what it would refuse from anyone, it refuses from itself.
  if (!parseDigestPayload(payload).ok) return { result: "refused" };

  const runId = digestIdempotencyKey(input.ownerDate);
  const deadlineIso = input.runDeadline.toISOString();
  let recorded;
  try {
    recorded = await recordAgentDigestItem(
      {
        agentKey: "sre-ops",
        kind: DIGEST_KIND,
        schemaVersion: DIGEST_SCHEMA_VERSION,
        idempotencyKey: runId,
        payload,
      },
      client,
      async (tx) => {
        await armOpsObserverTransaction(tx, "digest_submit", input.runDeadline);
        return null;
      },
      // The last write: this agent's run guard, checked again at COMMIT.
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "OpsObserverRunGuard" ("runId", kind, "runDeadlineAt", "invariantVersion")
          VALUES (${runId}, ${DIGEST_KIND}, ${deadlineIso}::timestamptz, 0)`;
        return null;
      },
    );
  } catch (error) {
    // The deferred deadline check (OB012) or the start budget (OB001): late.
    const state = sqlStateOf(error);
    if (state === "OB012" || state === "OB001") throw new OpsObserverLateError();
    throw error;
  }
  if (recorded.status === "refused" || recorded.status === "not_admitted") return { result: "refused" };
  if (recorded.status === "conflict") return { result: "conflict" };
  await assertNotLate(input.runDeadline, client);
  return { result: recorded.status, itemId: recorded.id };
}
