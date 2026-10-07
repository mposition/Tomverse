/**
 * The sre-ops daily digest intake (docs/policy/sre-ops.md §1 item 3, §3 rules
 * 4, 7 and 10, §6 item 5, §10).
 *
 * The digest service sends one closed payload per owner date. The app keeps it
 * only when it agrees with what the app itself reads:
 *
 *   1. The chain is trusted, read for that owner date (§3 rule 7); anything
 *      else stores nothing and answers the reason.
 *   2. The payload's mode is the chain's, and its reservation list is exactly
 *      the date's reserved items as the app reads them -- so the digest can
 *      neither invent nor hide a would-have-paged message.
 *   3. The shared store writes the row and its system audit entry in one
 *      transaction, whose last statement refuses the commit once the database
 *      clock is past the run's deadline; the answer is returned only after the
 *      separate short deadline check.
 *
 * The idempotency key is the owner date, so a repeated run is `replayed` and a
 * different payload for a date already kept is `conflict`.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";
import { readOpsObserverState, type OpsObserverDailyBudget } from "@/lib/opsObserverStore";
import { assertNotLate } from "@/lib/opsObserverTransaction";
import {
  DIGEST_KIND,
  DIGEST_SCHEMA_VERSION,
  digestIdempotencyKey,
} from "@/scripts/ops-observer/digest-schema-core.mjs";

export type OpsObserverDigestPayload = {
  ownerDate: string;
  mode: "shadow" | "live";
  readiness: "unknown" | Record<string, boolean>;
  reserved: { key: string; kind: string; capped: boolean }[];
  channelCheckTaken: boolean;
};

export type OpsObserverDigestResult =
  | { result: "created" | "replayed"; itemId: string }
  | { result: "conflict" | "mode_mismatch" | "budget_mismatch" | "late" | "refused" }
  | { result: "untrusted"; trust: string };

const stable = (items: { key: string; kind: string; capped: boolean }[]) =>
  JSON.stringify([...items].map((i) => [i.key, i.kind, i.capped]).sort());

export async function submitOpsObserverDigest(
  input: { runDeadline: Date; ownerDate: string; payload: OpsObserverDigestPayload },
  client: PrismaClient = prisma,
): Promise<OpsObserverDigestResult> {
  const state = await readOpsObserverState(input.runDeadline, client, input.ownerDate);
  if (state.trust !== "trusted" || !("budget" in state) || !state.budget) {
    return { result: "untrusted", trust: state.trust };
  }
  if (state.mode !== input.payload.mode) return { result: "mode_mismatch" };
  const budget: OpsObserverDailyBudget = state.budget;
  if (
    stable(budget.reservedToday) !== stable(input.payload.reserved) ||
    budget.channelCheckTaken !== input.payload.channelCheckTaken
  ) {
    return { result: "budget_mismatch" };
  }

  const deadlineIso = input.runDeadline.toISOString();
  const recorded = await recordAgentDigestItem(
    {
      agentKey: "sre-ops",
      kind: DIGEST_KIND,
      schemaVersion: DIGEST_SCHEMA_VERSION,
      idempotencyKey: digestIdempotencyKey(input.ownerDate),
      payload: input.payload,
    },
    client,
    undefined,
    // The transaction's last statement: past the deadline on the database's
    // own clock, the row and its audit entry roll back together (§6 item 5).
    async (tx) => {
      const [row] = await tx.$queryRaw<{ late: boolean }[]>`
        SELECT clock_timestamp() > ${deadlineIso}::timestamptz AS late`;
      return row?.late === false ? null : "late";
    },
  );
  if (recorded.status === "not_admitted") return { result: recorded.reason === "late" ? "late" : "refused" };
  if (recorded.status === "refused") return { result: "refused" };
  if (recorded.status === "conflict") return { result: "conflict" };
  await assertNotLate(input.runDeadline, client);
  return { result: recorded.status, itemId: recorded.id };
}
