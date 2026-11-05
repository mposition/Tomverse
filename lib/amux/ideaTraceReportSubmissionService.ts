import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import type { AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxContentKeyRing, createAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { AMUX_IDEA_STANDARD_TRANSACTION } from "./ideaRequestTimeoutsCore.ts";
import {
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionWritePermitted,
  type IdeaSubmissionInspection,
} from "./ideaSubmissionCore.ts";
import {
  IDEA_SUBMISSION_STATEMENT_TIMEOUT,
  IdeaSubmissionError,
  databaseNow,
  prepareIdeaSubmissionStorage,
} from "./ideaSubmissionService.ts";

type TraceReportIdea = {
  ownerUserId: string;
  caseId: string;
  inspected: Extract<IdeaSubmissionInspection, { ok: true }>;
};

/** Transaction body, for synthetic DB tests; the entry below owns the latch and the keys. */
export async function commitTraceReportIdea(
  tx: Prisma.TransactionClient,
  input: TraceReportIdea & { ideaId: string; keys: AmuxContentKeys },
): Promise<{ ideaId: string }> {
  const { ideaId, keys } = input;
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${IDEA_SUBMISSION_STATEMENT_TIMEOUT}, true)`;
  const submittedAt = await databaseNow(tx);
  const { data, sealed } = prepareIdeaSubmissionStorage({ inspected: input.inspected, ideaId, keys, submittedAt });
  await tx.amuxIdeaSubmission.create({ data: { ...data, actorUserId: input.ownerUserId } });
  await writeSystemAuditLog({
    tx,
    systemActor: "trace-report-analysis",
    action: "trace_report_analysis.idea_submitted",
    targetType: "AmuxIdeaSubmission",
    targetId: ideaId,
    summary: "Handed one verified trace report's fix to the idea lane.",
    metadata: {
      requestId: input.inspected.requestId,
      caseId: input.caseId,
      authorizedByUserId: input.ownerUserId,
      rawDigest: sealed.digest,
      rawDigestKeyId: sealed.digestKeyId,
      ideaBytes: input.inspected.counts.ideaBytes,
    },
  });
  return { ideaId };
}

/**
 * A fix the trace report analysis hands to the idea lane
 * (docs/policy/trace-feedback-automation.md §8a). No session: the idea's data
 * owner is the owner who chose that mode, and the audit says the system wrote
 * it, under that owner's standing choice. The caller checked they still are an
 * owner. An idea this request already made is returned, not made again.
 */
export async function submitIdeaFromTraceReport(input: TraceReportIdea): Promise<{ ideaId: string }> {
  const { requestId } = input.inspected;
  const seen = () => prisma.amuxIdeaSubmission.findUnique({ where: { requestId }, select: { id: true } });
  const existing = await seen();
  if (existing) return { ideaId: existing.id };
  if (!ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV])) {
    throw new IdeaSubmissionError("submission_disabled", 503);
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaSubmissionError("audit_unavailable", 503);
  }
  const global = loadCurrentAmuxContentKeys(process.env);
  const ideaId = randomUUID();
  const keyIdentity = { ideaId, purpose: "idea_raw" as const, subjectId: ideaId };
  let keys: AmuxContentKeys;
  try {
    const unit = await createAmuxContentUnitKeys(keyIdentity);
    keys = amuxContentKeyRing(global, [{ identity: keyIdentity, keys: unit }]);
  } catch {
    throw new IdeaSubmissionError("key_store_unavailable", 503);
  }
  try {
    return await prisma.$transaction((tx) => commitTraceReportIdea(tx, { ...input, ideaId, keys }), {
      ...AMUX_IDEA_STANDARD_TRANSACTION,
    });
  } catch (error) {
    // A lost answer or a racing pass: if the row is there, this was the same idea.
    const row = await seen().catch(() => null);
    if (row) return { ideaId: row.id };
    throw error;
  }
}
