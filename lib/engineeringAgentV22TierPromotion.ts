import "server-only";

import { ENGINEERING_AGENT_POLICY_VERSION,
  ENGINEERING_AGENT_V22_TIER_PENDING_REASON } from "@/lib/engineeringAgentCore";
import { runEngineeringAgentTransaction } from "@/lib/engineeringAgentStore";
import { loadEngineeringAgentV22Candidate } from
  "@/lib/engineeringAgentV22CandidateLoad";
import { resolveEngineeringAgentV22Product } from
  "@/lib/engineeringAgentV22ProductStore";
import { v22PublishCandidateMatches } from
  "@/lib/engineeringAgentV22PublicationDecision";
import { loadEngineeringAgentV22StoredCandidate } from
  "@/lib/engineeringAgentV22StoredCandidate";
import { prisma } from "@/lib/prisma";

type Pending = { workItemId: string; runId: string; attemptId: string;
  taskId: string; modeAtStart: string; patchDigest: string; baseSha: string };
type Stored = Awaited<ReturnType<typeof loadEngineeringAgentV22StoredCandidate>>;
type Ports = {
  readPending: () => Promise<Pending | null>;
  loadStored: (pending: Pending) => Promise<Stored>;
  resolve: (input: Parameters<typeof resolveEngineeringAgentV22Product>[1]) =>
    ReturnType<typeof resolveEngineeringAgentV22Product>;
};

const REASON = /^[a-z_]{1,64}$/;

async function readPending(): Promise<Pending | null> {
  const item = await prisma.engineeringAgentWorkItem.findFirst({
    where: { kind: "t2_draft", state: "open",
      reason: ENGINEERING_AGENT_V22_TIER_PENDING_REASON },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, patchDigest: true, baseSha: true,
      run: { select: { id: true, amuxAttemptId: true, cardId: true,
        modeAtStart: true } } },
  });
  if (!item?.run || !item.patchDigest || !item.baseSha) return null;
  return { workItemId: item.id, runId: item.run.id,
    attemptId: item.run.amuxAttemptId, taskId: item.run.cardId,
    modeAtStart: item.run.modeAtStart, patchDigest: item.patchDigest,
    baseSha: item.baseSha };
}

/** The run has ended, so the draft still pending is the snapshot the
 * candidate's reads are repeated against. Develop may have moved since
 * settlement; the base need only be one of its commits. */
const loadStored = (pending: Pending) =>
  loadEngineeringAgentV22StoredCandidate(pending.attemptId, {
    readSnapshot: async () => {
      const item = await prisma.engineeringAgentWorkItem.findUnique({
        where: { id: pending.workItemId },
        select: { state: true, reason: true } });
      return item?.state === "open" &&
        item.reason === ENGINEERING_AGENT_V22_TIER_PENDING_REASON ?
        { runId: pending.runId, taskId: pending.taskId,
          baseSha: pending.baseSha } : null;
    },
    loadCandidate: (input) =>
      loadEngineeringAgentV22Candidate({ ...input, onDevelop: true }),
  });

const livePorts: Ports = {
  readPending, loadStored,
  resolve: (input) => runEngineeringAgentTransaction(prisma,
    (tx) => resolveEngineeringAgentV22Product(tx, input)),
};

/** One pending draft's tier, read outside any route budget (§4): T1 opens
 * the run's publish item with its capability, anything else leaves an
 * ordinary draft for the owner. A write the database refuses -- the pull
 * request queue is full -- leaves the draft pending for a later round. */
export async function promoteEngineeringAgentV22Draft(
  ports: Ports = livePorts,
): Promise<{ outcome: "none" | "promoted" | "kept" | "stale";
  reason?: string }> {
  const pending = await ports.readPending();
  if (!pending) return { outcome: "none" };
  const stored = await ports.loadStored(pending).catch(() => null);
  const promote = v22PublishCandidateMatches({
    policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
    modeAtStart: pending.modeAtStart, runId: pending.runId,
    taskId: pending.taskId, baseSha: pending.baseSha,
    patchDigest: pending.patchDigest, publication: stored,
  }) && stored?.ok === true ? stored : null;
  const named = stored === null ? null : !stored.ok ? stored.reason :
    stored.tier.tier !== "T1" ? "tier_two" : null;
  const reason = named && REASON.test(named) ? named : "tier_evidence_unavailable";
  const resolved = await ports.resolve({
    workItemId: pending.workItemId, runId: pending.runId,
    taskId: pending.taskId, patchDigest: pending.patchDigest,
    baseSha: pending.baseSha, reason,
    candidate: promote ? {
      expectedTreeId: promote.candidate.expectedTreeId,
      baseCommitterDate: promote.candidate.baseCommitterDate,
      imageProofDigest: promote.imageProofDigest!,
    } : null,
  });
  if ("publishWorkItemId" in resolved) return { outcome: "promoted" };
  return resolved.kept ? { outcome: "kept", reason } : { outcome: "stale" };
}

let running: Promise<unknown> | null = null;

/** The publisher's claim starts this after answering (§8): one round at a
 * time in this process, and a failure is logged, never retried here. */
export function startEngineeringAgentV22TierPromotion(): Promise<unknown> {
  running ??= promoteEngineeringAgentV22Draft()
    .then((result) => console.info(JSON.stringify({
      subsystem: "engineering_agent", event: "v22_tier_promotion", ...result })))
    .catch((error) => console.warn(JSON.stringify({
      subsystem: "engineering_agent", event: "v22_tier_promotion_failed",
      error: error instanceof Error ? error.name : "unknown",
      code: typeof error?.code === "string" ? error.code : null })))
    .finally(() => { running = null; });
  return running;
}
