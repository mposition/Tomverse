export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { recordChatUnifiedOptimizerAmuxCandidate,
  chatUnifiedOptimizerAmuxCandidateRequestId } from
  "@/lib/chatUnifiedOptimizerAmuxCandidateStore";
import { readChatUnifiedOptimizerAmuxSourcePin } from
  "@/lib/chatUnifiedOptimizerAmuxSourcePin";
import { CHAT_UNIFIED_OPTIMIZER_PURPOSE,
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerTerminalDigest } from
  "@/lib/chatUnifiedOptimizerLedgerCore";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const WRITE_ENV = "TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE";
const id = z.string().uuid();

export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || !params.has("attemptId"))
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  const attemptId = id.safeParse(params.get("attemptId"));
  if (!attemptId.success)
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const cycle = await prisma.chatUnifiedOptimizerCycle.findUnique({
      where: { registrationRequestId:
        chatUnifiedOptimizerAmuxCandidateRequestId(attemptId.data,
          "registration") },
      select: { id: true, purpose: true, candidate: {
        select: { id: true, candidateDigest: true, bundleDigest: true,
          sourceCommitSha: true, sourceRepositoryId: true,
          sourceBlobSha: true, sourceSha256: true } },
        runs: { where: { ordinal: 1 }, select: { id: true, ordinal: true, jobs: {
          where: { role: "candidate_author" },
          select: { id: true, role: true, state: true, terminalOutcome: true,
            claimRequestId: true, claimRequestDigest: true,
            claimToken: true, terminalRequestId: true,
            terminalRequestDigest: true, terminalAuditLogId: true,
            evidence: { select: { jobId: true, runId: true,
              cycleId: true, candidateId: true, outcome: true,
              evidenceRef: true, payloadDigest: true,
              terminalAuditLogId: true } } },
        } } } },
    });
    if (!cycle) return amuxJsonNoStore({ status: "absent" });
    const sourcePin = readChatUnifiedOptimizerAmuxSourcePin();
    const run = cycle.runs[0];
    const job = run?.jobs[0];
    const ref = job?.evidence?.evidenceRef ?? "";
    const claimRequestId = chatUnifiedOptimizerAmuxCandidateRequestId(
      attemptId.data, "claim");
    const terminalRequestId = chatUnifiedOptimizerAmuxCandidateRequestId(
      attemptId.data, "terminal");
    if (cycle.purpose !== CHAT_UNIFIED_OPTIMIZER_PURPOSE ||
        cycle.runs.length !== 1 || run?.ordinal !== 1 ||
        run.jobs.length !== 1 || job?.role !== "candidate_author" ||
        !cycle.candidate ||
        cycle.candidate.sourceRepositoryId !== BigInt(sourcePin.repositoryId) ||
        cycle.candidate.sourceCommitSha !== sourcePin.commitSha ||
        cycle.candidate.sourceBlobSha !== sourcePin.blobSha ||
        cycle.candidate.sourceSha256 !== sourcePin.sha256 ||
        job?.state !== "succeeded" ||
        job.terminalOutcome !== "succeeded" ||
        job.claimRequestId !== claimRequestId ||
        job.claimRequestDigest !== chatUnifiedOptimizerClaimDigest({
          requestId: claimRequestId, jobId: job.id }) ||
        !job.claimToken ||
        job.terminalRequestId !== terminalRequestId ||
        job.terminalRequestDigest !== chatUnifiedOptimizerTerminalDigest({
          requestId: terminalRequestId, jobId: job.id,
          claimToken: job.claimToken, outcome: "succeeded",
          evidenceRef: ref,
          evidencePayloadDigest: job.evidence?.payloadDigest ?? null }) ||
        job.evidence?.jobId !== job.id ||
        job.evidence.runId !== run.id ||
        job.evidence.cycleId !== cycle.id ||
        job.evidence.candidateId !== cycle.candidate.id ||
        job.evidence.outcome !== "succeeded" ||
        !job.terminalAuditLogId ||
        job.evidence.terminalAuditLogId !== job.terminalAuditLogId ||
        !/^[0-9a-f]{64}$/.test(job.evidence.payloadDigest) ||
        !/^optimizer:proposal-result:[0-9a-f]{64}$/.test(ref))
      return amuxJsonNoStore({ status: "incomplete", cycleId: cycle.id,
        authorshipVerified: false }, 409);
    return amuxJsonNoStore({ status: "recorded", attemptId: attemptId.data,
      cycleId: cycle.id,
      resultSha256: ref.slice("optimizer:proposal-result:".length),
      candidateDigest: cycle.candidate.candidateDigest,
      bundleDigest: cycle.candidate.bundleDigest,
      authorshipVerified: false });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[WRITE_ENV] !== "enabled")
    return amuxJsonNoStore({ available: false,
      reason: "amux_candidate_write_disabled" }, 409);
  if (request.headers.get("content-type")?.split(";")[0]?.trim()
    .toLowerCase() !== "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let input: unknown;
  try { input = await readLimitedJson(request, 131_072, z.unknown()); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const sourcePin = readChatUnifiedOptimizerAmuxSourcePin();
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !("sourcePin" in input) ||
        canonicalBenchmarkJson((input as { sourcePin?: unknown }).sourcePin) !==
          canonicalBenchmarkJson(sourcePin))
      return amuxJsonNoStore({ error: "source_pin_mismatch" }, 409);
    const attemptId = id.safeParse((input as Record<string, unknown>).attemptId);
    if (!attemptId.success)
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
    const result = await recordChatUnifiedOptimizerAmuxCandidate(input);
    if (result.outcome !== "recorded")
      return amuxJsonNoStore({ status: "stopped_for_readback",
        stage: result.stage, readbackOutcome: result.readbackOutcome }, 503);
    return amuxJsonNoStore({ status: "recorded", cycleId: result.cycleId,
      attemptId: attemptId.data,
      resultSha256: result.proposalValidationReceipt.resultSha256,
      candidateDigest: result.proposalValidationReceipt.candidateDigest,
      bundleDigest: result.proposalValidationReceipt.bundleDigest,
      authorshipVerified: false, completion: result.completion });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}
