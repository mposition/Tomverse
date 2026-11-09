import "server-only";

import {
  EngineeringAgentGitHubReadError,
  readEngineeringAgentBranchPresent,
  readEngineeringAgentPullMerge,
} from "@/lib/engineeringAgentGitHubRead";
import {
  EngineeringAgentStoreRefusedError,
  moveEngineeringAgentBinding,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

/**
 * Frees the owner's PR queue (engineering-agent.md §12). A binding holds a
 * slot while its pull request is open or its branch remains: `open -> closed`
 * once the pull request is closed, `closed -> pruned` once the branch is gone.
 *
 * Production 2026-11-09: nothing called these moves, so PR #3147 (merged
 * 2026-10-30, branch deleted) held the only slot of the first T1 window and
 * every v22 Task since 2026-11-07 started without publication
 * (`run_admission_owner_queue_full`).
 *
 * A merge is the approval observer's to record first, since it completes the
 * card in the same transaction; an open binding is closed here only once that
 * merge is recorded, or when its pull request closed without one. A read that
 * fails decides nothing; the binding is looked at again next round.
 */

export type EngineeringAgentBindingReleaseOutcome =
  | "pruned"
  | "closed"
  | "pull_open"
  | "merge_unrecorded"
  | "branch_remains"
  | "refused"
  | "unreadable";

type Ports = {
  pull: (prNumber: number) => Promise<{ state: "open" | "closed"; merged: boolean }>;
  branchPresent: (ref: string) => Promise<boolean>;
};

const livePorts: Ports = {
  pull: (prNumber) => readEngineeringAgentPullMerge(prNumber),
  branchPresent: (ref) => readEngineeringAgentBranchPresent(ref),
};

// The queue holds at most a few bindings; the ceiling only stops a runaway round.
const ROUND_CEILING = 50;

export async function releaseEngineeringAgentBindings(
  ports: Ports = livePorts,
): Promise<Array<{ bindingId: string; outcome: EngineeringAgentBindingReleaseOutcome }>> {
  const bindings = await prisma.engineeringAgentBinding.findMany({
    where: { state: { in: ["open", "closed"] }, supersededAt: null },
    select: { id: true, prNumber: true, ref: true, state: true, mergeObservation: true },
    orderBy: { id: "asc" },
    take: ROUND_CEILING,
  });
  const results: Array<{ bindingId: string; outcome: EngineeringAgentBindingReleaseOutcome }> = [];
  const move = (bindingId: string, to: "closed" | "pruned") =>
    runEngineeringAgentTransaction(prisma, (tx) => moveEngineeringAgentBinding(tx, { bindingId, to }));
  for (const binding of bindings) {
    let closedNow = false;
    try {
      if (binding.state === "open") {
        if (binding.mergeObservation === null) {
          const pull = await ports.pull(binding.prNumber);
          if (pull.state === "open") {
            results.push({ bindingId: binding.id, outcome: "pull_open" });
            continue;
          }
          if (pull.merged) {
            results.push({ bindingId: binding.id, outcome: "merge_unrecorded" });
            continue;
          }
        }
        await move(binding.id, "closed");
        closedNow = true;
      }
      if (await ports.branchPresent(binding.ref)) {
        results.push({ bindingId: binding.id, outcome: closedNow ? "closed" : "branch_remains" });
        continue;
      }
      await move(binding.id, "pruned");
      results.push({ bindingId: binding.id, outcome: "pruned" });
    } catch (error) {
      // A store refusal (the maintenance switch off, a concurrent move) is
      // the binding's answer this round; it never hides the observer's.
      if (error instanceof EngineeringAgentStoreRefusedError) {
        results.push({ bindingId: binding.id, outcome: closedNow ? "closed" : "refused" });
        continue;
      }
      if (!(error instanceof EngineeringAgentGitHubReadError)) throw error;
      results.push({ bindingId: binding.id, outcome: closedNow ? "closed" : "unreadable" });
    }
  }
  return results;
}
