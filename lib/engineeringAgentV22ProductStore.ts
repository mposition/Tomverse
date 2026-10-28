import "server-only";

import { ENGINEERING_AGENT_COMMIT_IDENTITY,
  ENGINEERING_AGENT_V22_TIER_PENDING_REASON } from
  "@/lib/engineeringAgentCore";
import { issueEngineeringAgentCapability,
  openEngineeringAgentWorkItem,
  resolveEngineeringAgentV22TierPendingDraft,
  type EngineeringAgentTransaction } from
  "@/lib/engineeringAgentStore";

type Patch = { text: string; sha256: string; baseSha: string };
type Candidate = { expectedTreeId: string;
  baseCommitterDate: string | null; imageProofDigest: string };
type Ports = { open: typeof openEngineeringAgentWorkItem;
  resolve: typeof resolveEngineeringAgentV22TierPendingDraft;
  issue: typeof issueEngineeringAgentCapability };
const livePorts: Ports = { open: openEngineeringAgentWorkItem,
  resolve: resolveEngineeringAgentV22TierPendingDraft,
  issue: issueEngineeringAgentCapability };

/** Settlement keeps every v22 patch private: a draft whose tier is read later
 * when the run may still publish (§4), otherwise an ordinary draft. Reading
 * the tier needs the base tree and GitHub, which settlement has no time for. */
export async function openEngineeringAgentV22Product(
  tx: EngineeringAgentTransaction,
  input: { runId: string; patch: Patch; tierPending: boolean },
  ports: Pick<Ports, "open"> = livePorts,
): Promise<{ id: string; kind: "t2_draft";
  patchDigest: string; baseSha: string }> {
  const { runId, patch } = input;
  const opened = await ports.open(tx, {
    kind: "t2_draft", causeKey: `t2_draft:${runId}`,
    runId, patchBody: patch.text,
    patchDigest: patch.sha256, baseSha: patch.baseSha,
    reason: input.tierPending ? ENGINEERING_AGENT_V22_TIER_PENDING_REASON :
      "tier_evidence_unavailable",
  });
  return { id: opened.workItemId, kind: "t2_draft",
    patchDigest: patch.sha256, baseSha: patch.baseSha };
}

/** The caller holds one engineering transaction. A failed capability issue
 * aborts the promotion too, never leaving a queued item without authority. */
export async function resolveEngineeringAgentV22Product(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string; runId: string; taskId: string;
    patchDigest: string; baseSha: string; candidate: Candidate | null;
    reason: string },
  ports: Pick<Ports, "resolve" | "issue"> = livePorts,
) {
  const { candidate } = input;
  if (candidate && !candidate.baseCommitterDate)
    throw new Error("v22_publish_candidate_missing");
  const resolved = await ports.resolve(tx, {
    workItemId: input.workItemId, patchDigest: input.patchDigest,
    baseSha: input.baseSha, reason: input.reason,
    promote: candidate ? { expectedTreeId: candidate.expectedTreeId,
      imageProofDigest: candidate.imageProofDigest } : null,
  });
  if (candidate && "publishWorkItemId" in resolved)
    await ports.issue(tx, { workItemId: resolved.publishWorkItemId,
      capability: { baseSha: input.baseSha,
        patchDigest: input.patchDigest,
        expectedTreeId: candidate.expectedTreeId,
        commit: { identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
          baseCommitterDate: candidate.baseCommitterDate!,
          runId: input.runId, cardRef: input.taskId },
      },
    });
  return resolved;
}
