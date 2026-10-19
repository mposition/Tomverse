import "server-only";

import type { Prisma } from "@prisma/client";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { loadAmuxContentKeyRing,
  type AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import { amuxSessionPageKeyIdentities, buildAmuxSessionPagePrompt,
  readAmuxSessionPageContextInTx } from "./ideaSessionAnalysisPlanService.ts";
import { readAmuxSessionReferencePin } from
  "./ideaSessionReferencePinRead.ts";
import { inspectSealedAmuxIdeaSessionInput } from
  "./ideaSessionSubmissionCore.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Transaction primitive for a verified content key; useful for isolated DB
 * integration without a production object store. */
export async function readAmuxV19MaxIdeaInTx(
  tx: Prisma.TransactionClient,
  input: { reservationId: string; ideaId: string; claimId: string },
  keys: AmuxContentKeys,
): Promise<{ idea: string } | null> {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '3000', true) AS idle_limit,
             set_config('TimeZone', 'UTC', true) AS transaction_zone
    `;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
    const latestScope = await tx.amuxIdeaOperatingScopeSetting.findFirst({
      orderBy: { version: "desc" }, select: { id: true },
    });
    if (!latestScope) return null;
    const reservation = await tx.amuxIdeaSessionAnalysisReservation.findFirst({
      where: { id: input.reservationId, ideaId: input.ideaId,
        operatingScopeSettingId: latestScope.id, status: "queued",
        modelProvider: "anthropic",
        budgetClaims: { some: { id: input.claimId, status: "in_flight",
          closedAt: null, resolutionAuditLogId: null,
          budgetMode: "max_shadow" } },
        idea: { submissionOrigin: "session",
          state: { in: ["submitted", "analyzing"] },
          cancelledAt: null, analysisCompletedAt: null,
          analysisDeadlineAt: { gt: now }, rawPurgedAt: null,
          rawCiphertext: { not: null }, sourceProvenanceCiphertext: { not: null } } },
      select: { idea: { select: { id: true, submissionAuditLogId: true,
        rawCiphertext: true, rawKeyId: true, rawKeyVersion: true,
        rawDigest: true, rawDigestKeyId: true } } },
    });
    const idea = reservation?.idea;
    if (!idea?.submissionAuditLogId || !idea.rawCiphertext ||
        !idea.rawKeyId || !idea.rawKeyVersion || !idea.rawDigest ||
        !idea.rawDigestKeyId) return null;
    const audit = await tx.adminAuditLog.findUnique({
      where: { id: idea.submissionAuditLogId },
      select: { id: true, action: true, targetType: true, targetId: true,
        entryHash: true, actorUserId: true, actorEmail: true,
        ipAddress: true, userAgent: true, metadata: true },
    });
    const metadata = audit?.metadata;
    if (!audit?.entryHash || auditRowActorKind(audit) !== "system" ||
        audit.action !== "amux.idea.session_submitted" ||
        audit.targetType !== "AmuxIdeaSubmission" ||
        audit.targetId !== idea.id || !metadata ||
        typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const values = metadata as Record<string, unknown>;
    const pins = values.pinnedCommitShas;
    if (values.rawDigest !== idea.rawDigest ||
        values.rawDigestKeyId !== idea.rawDigestKeyId ||
        !Array.isArray(pins) ||
        !Number.isSafeInteger(values.repositoryCount) ||
        !Number.isSafeInteger(values.pullRequestCount) ||
        (values.repositoryCount as number) < 0 ||
        (values.pullRequestCount as number) < 0 ||
        pins.length !== (values.repositoryCount as number) +
          (values.pullRequestCount as number) ||
        !pins.every((pin) => typeof pin === "string" && SHA.test(pin))) {
      return null;
    }
    let plain: Buffer;
    try {
      plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
        keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
      "idea_raw", idea.id, keys);
    } catch { return null; }
    try {
      if (!verifyAmuxContentDigest(plain, "idea_raw", idea.id,
        idea.rawDigest, idea.rawDigestKeyId, keys)) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(plain.toString("utf8")); }
      catch { return null; }
      const inspected = inspectSealedAmuxIdeaSessionInput(parsed);
      if (!inspected.ok ||
          inspected.counts.ideaBytes !== values.ideaBytes ||
          inspected.counts.repositoryCount !== values.repositoryCount ||
          inspected.counts.pullRequestCount !== values.pullRequestCount) {
        return null;
      }
      return { idea: inspected.input.idea };
    } finally { plain.fill(0); }
}

/** The v4 prompt for the page this exact claim analyses: page 0 opens the
 * plan, a later page continues the previous page's unfinished output. The
 * claim's invocation ordinal must be that page, so a claim can never be
 * pointed at another page's context. The app stores the same prompt as the
 * page's preview payload when the result arrives. */
export async function readAmuxV19MaxPagePrompt(input: {
  reservationId: string; ideaId: string; claimId: string;
}): Promise<{ prompt: string } | null> {
  const pin = await readAmuxSessionReferencePin({ ...input,
    referenceOrdinal: 0 });
  if (!pin) return null;
  let previousPage: AmuxContentKeyIdentity[];
  try { previousPage = await amuxSessionPageKeyIdentities(prisma, input.ideaId); }
  catch { return null; }
  const keys = await loadAmuxContentKeyRing([{ ideaId: input.ideaId,
    purpose: "idea_raw", subjectId: input.ideaId }, ...previousPage]);
  return prisma.$transaction((tx) =>
    readAmuxV19MaxPagePromptInTx(tx, input, keys),
  { maxWait: 2_000, timeout: 5_000 });
}

export async function readAmuxV19MaxPagePromptInTx(
  tx: Prisma.TransactionClient,
  input: { reservationId: string; ideaId: string; claimId: string },
  keys: AmuxContentKeys,
): Promise<{ prompt: string } | null> {
  const read = await readAmuxV19MaxIdeaInTx(tx, input, keys);
  if (!read) return null;
  const [idea, claim, clock] = [
    await tx.amuxIdeaSubmission.findUnique({ where: { id: input.ideaId },
      select: { actorUserId: true, currentSourcePlanRevisionId: true } }),
    await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
      where: { id: input.claimId }, select: { invocationOrdinal: true } }),
    await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `,
  ];
  const now = clock[0]?.now;
  if (!idea || !claim || !(now instanceof Date)) return null;
  let context;
  try {
    context = await readAmuxSessionPageContextInTx(tx, { ideaId: input.ideaId,
      actorUserId: idea.actorUserId, planId: idea.currentSourcePlanRevisionId,
      now, keys });
  } catch { return null; }
  if (context.chunkIndex !== claim.invocationOrdinal) return null;
  const built = buildAmuxSessionPagePrompt({ claimId: input.claimId,
    idea: read.idea, context });
  return built.status === "prompt_candidate" ? { prompt: built.prompt } : null;
}
