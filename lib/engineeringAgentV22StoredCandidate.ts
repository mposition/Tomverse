import "server-only";

import { AMUX_V22_ENGINEERING_PUBLICATION_ENV,
  amuxV22EngineeringPublicationEnabled } from
  "@/lib/amux/v22TaskExecutionCore";
import { readAmuxV22TaskPatchEvidence } from "@/lib/amux/v22TaskResultStore";
import { readAmuxV22PublicPrConsent } from "@/lib/amux/v22PublicPrConsent";
import type { TierVerdict } from "@/lib/agentPushPolicy";
import { loadEngineeringAgentV22Candidate } from
  "@/lib/engineeringAgentV22CandidateLoad";
import { loadEngineeringAgentV22BaseEvidence } from
  "@/lib/engineeringAgentV22BaseEvidence";
import { readEngineeringAgentGitBlob } from "@/lib/engineeringAgentGitHubRead";
import { decideEngineeringAgentV22Tier } from
  "@/lib/engineeringAgentV22Tier";
import { readEngineeringAgentSwitches } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

type Candidate = Awaited<ReturnType<typeof loadEngineeringAgentV22Candidate>>;
type Snapshot = { runId: string; taskId: string; baseSha: string } | null;
type Ports = {
  readSnapshot: (attemptId: string) => Promise<Snapshot>;
  readPatch: typeof readAmuxV22TaskPatchEvidence;
  readConsent: typeof readAmuxV22PublicPrConsent;
  readSwitch: () => Promise<boolean>;
  publicationEnabled: () => boolean;
  loadCandidate: typeof loadEngineeringAgentV22Candidate;
  readTier: (candidate: Extract<Candidate, { ok: true }>) =>
    Promise<{ tier: TierVerdict; imageProofDigest: string | null }>;
};

// The base commit is bound through `candidate.baseTree`; its own
// `.dockerignore` says which test sources its image leaves out. The field
// keeps its stored name, `imageProofDigest`, for the exclusion digest.
async function readTier(candidate: Extract<Candidate, { ok: true }>):
  Promise<{ tier: TierVerdict; imageProofDigest: string | null }> {
  const evidence = await loadEngineeringAgentV22BaseEvidence({
    tree: candidate.baseTree,
    fetchBlob: (oid, maxBytes) =>
      readEngineeringAgentGitBlob(oid, {}, maxBytes),
  });
  if (!evidence) return { tier: { tier: "T2", findings: [{
    reason: "slice_analysis_failed", path: null,
  }] }, imageProofDigest: null };
  const { deployExcluded, exclusionDigest, ...sources } = evidence;
  // Exact file paths, base and changed alike: the slice treats each entry as
  // that path or a directory above it, so a new test file a change adds is
  // excluded by the same rules as an existing one.
  const excluded = deployExcluded([...new Set([
    ...sources.baseFiles.map((file) => file.path),
    ...candidate.changes.flatMap((change) =>
      [change.path, change.previousPath ?? change.path]),
  ])]);
  return { tier: decideEngineeringAgentV22Tier({
    changes: candidate.changes, ...sources,
    deployExcludedPrefixes: excluded,
  }), imageProofDigest: exclusionDigest };
}

async function readSnapshot(attemptId: string): Promise<Snapshot> {
  const run = await prisma.engineeringAgentRun.findUnique({
    where: { amuxAttemptId: attemptId },
    select: { id: true, cardId: true, baseSha: true, status: true,
      modeAtStart: true, attempt: { select: { endedAt: true,
        v22AssignmentId: true, worker: true,
        task: { select: { id: true, status: true, owner: true,
          sourceSystem: true, taskRole: true, v22AssignmentId: true } } } } },
  });
  const attempt = run?.attempt;
  const task = attempt?.task;
  if (!run || run.status !== "active" || run.modeAtStart !== "t1" ||
      !attempt || attempt.endedAt !== null || !attempt.v22AssignmentId ||
      !task || run.cardId !== task.id ||
      task.sourceSystem !== "admin-idea-v4" ||
      task.taskRole !== "implement" || task.status !== "doing" ||
      task.owner !== attempt.worker ||
      task.v22AssignmentId !== attempt.v22AssignmentId)
    return null;
  return { runId: run.id, taskId: run.cardId, baseSha: run.baseSha };
}

const livePorts: Ports = {
  readSnapshot,
  readPatch: readAmuxV22TaskPatchEvidence,
  readConsent: readAmuxV22PublicPrConsent,
  readSwitch: async () =>
    (await readEngineeringAgentSwitches(prisma)).publishAllowed,
  publicationEnabled: () => amuxV22EngineeringPublicationEnabled(
    process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]),
  loadCandidate: loadEngineeringAgentV22Candidate,
  readTier,
};

/** This is a verified candidate, not T1 authority. Every read that could
 * change during GitHub I/O is repeated before returning the patch to the
 * deterministic tier gate. No patch or source text is sent to a client. A
 * caller after settlement names its own snapshot (the pending draft's run). */
export async function loadEngineeringAgentV22StoredCandidate(attemptId: string,
  given: Partial<Ports> = {}): Promise<
    { ok: true; runId: string; taskId: string; baseSha: string;
      patchBody: string; patchDigest: string;
      candidate: Extract<Candidate, { ok: true }>;
      tier: TierVerdict; imageProofDigest: string | null } |
    { ok: false; reason: string }
  > {
  const ports = { ...livePorts, ...given };
  const first = await ports.readSnapshot(attemptId);
  if (!first || !ports.publicationEnabled() ||
      !(await ports.readSwitch()) ||
      !(await ports.readConsent(first.taskId)))
    return { ok: false, reason: "publication_not_authorized" };
  const patch = await ports.readPatch(attemptId, first.taskId);
  if (!patch || patch.baseSha !== first.baseSha || !patch.files)
    return { ok: false, reason: "patch_unavailable" };
  const candidate = await ports.loadCandidate({ baseSha: first.baseSha,
    files: patch.files });
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  const tierEvidence = await ports.readTier(candidate);
  const current = await ports.readSnapshot(attemptId);
  if (!current || current.runId !== first.runId ||
      current.taskId !== first.taskId || current.baseSha !== first.baseSha ||
      !ports.publicationEnabled() || !(await ports.readSwitch()) ||
      !(await ports.readConsent(first.taskId)))
    return { ok: false, reason: "publication_state_changed" };
  return { ok: true, ...first, patchBody: patch.text,
    patchDigest: patch.sha256, candidate,
    tier: tierEvidence.tier,
    imageProofDigest: tierEvidence.imageProofDigest };
}

/** The internal preflight may report identifiers and digests, never the
 * decrypted patch, proposed file bytes, or policy change text. */
export function engineeringAgentV22CandidateSummary(
  value: Extract<Awaited<ReturnType<
    typeof loadEngineeringAgentV22StoredCandidate>>, { ok: true }>) {
  return { verified: true as const, queued: false as const,
    baseSha: value.baseSha, patchDigest: value.patchDigest,
    baseTreeId: value.candidate.baseRootTreeId,
    expectedTreeId: value.candidate.expectedTreeId,
    changedPaths: value.candidate.changes.map((entry) => entry.path) };
}
