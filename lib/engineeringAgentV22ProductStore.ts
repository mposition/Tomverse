import "server-only";

import { ENGINEERING_AGENT_COMMIT_IDENTITY } from
  "@/lib/engineeringAgentCore";
import { issueEngineeringAgentCapability,
  openEngineeringAgentWorkItem,
  type EngineeringAgentTransaction } from
  "@/lib/engineeringAgentStore";

type Patch = { text: string; sha256: string; baseSha: string };
type Candidate = { expectedTreeId: string;
  baseCommitterDate: string | null };
type Ports = { open: typeof openEngineeringAgentWorkItem;
  issue: typeof issueEngineeringAgentCapability };
const livePorts: Ports = { open: openEngineeringAgentWorkItem,
  issue: issueEngineeringAgentCapability };

/** The caller holds one AMUX/engineering transaction. A failed capability
 * issue must abort the publish item too, never leave a queued item without
 * authority or silently turn it into a T2 draft. */
export async function openEngineeringAgentV22Product(
  tx: EngineeringAgentTransaction,
  input: { runId: string; taskId: string; patch: Patch;
    publish: boolean; candidate: Candidate | null },
  ports: Ports = livePorts,
): Promise<{ id: string; kind: "publish" | "t2_draft";
  patchDigest: string; baseSha: string }> {
  const { runId, taskId, patch } = input;
  if (input.publish) {
    const candidate = input.candidate;
    if (!candidate?.baseCommitterDate)
      throw new Error("v22_publish_candidate_missing");
    const opened = await ports.open(tx, {
      kind: "publish", causeKey: `publish:${runId}`,
      runId, patchBody: patch.text,
      patchDigest: patch.sha256, baseSha: patch.baseSha,
      expectedTreeId: candidate.expectedTreeId,
    });
    await ports.issue(tx, { workItemId: opened.workItemId,
      capability: { baseSha: patch.baseSha,
        patchDigest: patch.sha256,
        expectedTreeId: candidate.expectedTreeId,
        commit: { identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
          baseCommitterDate: candidate.baseCommitterDate,
          runId, cardRef: taskId },
      },
    });
    return { id: opened.workItemId, kind: "publish",
      patchDigest: patch.sha256, baseSha: patch.baseSha };
  }
  const opened = await ports.open(tx, {
    kind: "t2_draft", causeKey: `t2_draft:${runId}`,
    runId, patchBody: patch.text,
    patchDigest: patch.sha256, baseSha: patch.baseSha,
    reason: "t1_evidence_unavailable",
  });
  return { id: opened.workItemId, kind: "t2_draft",
    patchDigest: patch.sha256, baseSha: patch.baseSha };
}
