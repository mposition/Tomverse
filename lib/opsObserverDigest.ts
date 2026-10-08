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
 *      transaction. Its first statement is this agent's arming function with
 *      the digest_submit timers and start budget, and its Prisma timeout is
 *      digest_submit's (§6 items 1-4); its last write is this agent's run
 *      guard row, whose deferred trigger refuses the COMMIT once the database
 *      clock is past the deadline (§6 item 5) -- so a late digest leaves no
 *      row, shared or own. The answer is given only after the separate short
 *      deadline check.
 *
 * A date is kept once. The readiness is read at submission time, so a retry
 * builds different bytes; the date already kept is therefore answered with
 * the item that holds it (`replayed`), never rebuilt and never a conflict.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";
import { readOpsObserverState, type OpsObserverDailyBudget } from "@/lib/opsObserverStore";
import { OpsObserverLateError, armOpsObserverTransaction, assertNotLate } from "@/lib/opsObserverTransaction";
import { TRANSACTION_BOUNDS } from "@/scripts/ops-observer/transaction-bounds-core.mjs";
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
  | { result: "refused" }
  | { result: "untrusted"; trust: string };

/**
 * Whether an error is one of this agent's deadline refusals: the deferred
 * check at COMMIT (OB012) or the start budget (OB001). Only this agent's
 * "OB" codes are matched, so a Prisma code such as P2010 is never mistaken
 * for one; a driver that loses the database code answers 500, not 409.
 */
function isDeadlineRefusal(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  return [cause?.originalCode, cause?.code, e?.code].some((code) => code === "OB012" || code === "OB001");
}

/** The item already kept for a date, if any (a plain read of the shared table). */
async function keptItem(client: PrismaClient, idempotencyKey: string): Promise<string | null> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "AgentDigestItem"
     WHERE "agentKey" = 'sre-ops' AND "idempotencyKey" = ${idempotencyKey}`;
  return rows[0]?.id ?? null;
}

export async function submitOpsObserverDigest(
  input: { runDeadline: Date; ownerDate: string },
  client: PrismaClient = prisma,
): Promise<OpsObserverDigestResult> {
  const runId = digestIdempotencyKey(input.ownerDate);
  const state = await readOpsObserverState(input.runDeadline, client, input.ownerDate);
  if (state.trust !== "trusted" || !("budget" in state) || !state.budget) {
    return { result: "untrusted", trust: state.trust };
  }
  const budget: OpsObserverDailyBudget = state.budget;
  // Kept already: answer it as it is, after the same trust and deadline checks.
  const existing = await keptItem(client, runId);
  if (existing) {
    await assertNotLate(input.runDeadline, client);
    return { result: "replayed", itemId: existing };
  }

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
      undefined,
      // The last write: this agent's run guard, checked again at COMMIT.
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "OpsObserverRunGuard" ("runId", kind, "runDeadlineAt", "invariantVersion")
          VALUES (${runId}, ${DIGEST_KIND}, ${deadlineIso}::timestamptz, 0)`;
        return null;
      },
      // The first statement: this agent's arming function; and its timeout.
      {
        arm: async (tx) => {
          await armOpsObserverTransaction(tx, "digest_submit", input.runDeadline);
        },
        prismaTimeoutMs: TRANSACTION_BOUNDS.digest_submit.prismaTimeoutMs,
      },
    );
  } catch (error) {
    if (isDeadlineRefusal(error)) throw new OpsObserverLateError();
    throw error;
  }
  if (recorded.status === "refused" || recorded.status === "not_admitted") return { result: "refused" };
  // A concurrent run kept the date first: answer its item.
  if (recorded.status === "conflict") {
    await assertNotLate(input.runDeadline, client);
    return { result: "replayed", itemId: recorded.id };
  }
  await assertNotLate(input.runDeadline, client);
  return { result: recorded.status, itemId: recorded.id };
}
