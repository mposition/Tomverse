import { randomUUID } from "node:crypto";

import { amuxCliUsageReceiptDigest,
  makeAmuxCliUsageReceipt } from "./cliUsageLedgerCore.ts";

/** One common boundary for every AMUX CLI invocation. A15's task executor
 * supplies task_attempt binding; the existing idea executor supplies its hold.
 * No result is released to a caller after an unverified usage write. */
export async function executeAmuxCliWithUsageReceipt(input) {
  if (!input || typeof input.invoke !== "function" ||
      typeof input.record !== "function" ||
      typeof input.readBack !== "function") throw new TypeError("invalid CLI wrapper");
  const invocationId = input.invocationId ?? randomUUID();
  if (input.invocationId !== undefined &&
      input.binding?.kind === "task_attempt" &&
      invocationId !== input.binding.attemptId)
    throw new TypeError("task invocation must equal attempt ID");
  const startedAt = new Date().toISOString();
  let result;
  try { result = await input.invoke(); }
  catch { return { kind: "outcome_unknown" }; }
  const endedAt = new Date().toISOString();
  if (!result?.cliStarted) return { kind: "not_started", result };
  if (!result.usageObservation || !result.cliVersion ||
      !result.authentication) return { kind: "outcome_unknown" };
  let receipt;
  try {
    receipt = makeAmuxCliUsageReceipt({ invocationId,
      binding: input.binding, worker: input.worker,
      selectedModelId: input.selectedModelId,
      cliVersion: result.cliVersion,
      authentication: result.authentication,
      startedAt, endedAt,
      status: result.kind === "verified_success" ? "succeeded" :
        result.kind === "outcome_unknown" ? "outcome_unknown" : "failed",
      observation: result.usageObservation });
  } catch { return { kind: "outcome_unknown" }; }
  const digest = amuxCliUsageReceiptDigest(receipt);
  let saved = null;
  try { saved = await input.record(receipt); } catch { /* Read back once. */ }
  if (saved?.invocationId !== invocationId || saved?.receiptDigest !== digest) {
    let readBack = null;
    try { readBack = await input.readBack(invocationId); }
    catch { /* Never retry an unknown provider call. */ }
    if (readBack?.status !== "recorded" || readBack.receiptDigest !== digest)
      return { kind: "outcome_unknown" };
  }
  return { kind: "recorded", result, invocationId, receiptDigest: digest };
}
