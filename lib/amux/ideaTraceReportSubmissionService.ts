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

/**
 * Who hands an idea to the idea lane with no session, and the one audit
 * action each writes (lib/adminAuditSystemActors.ts scopes the same pairs).
 */
const SYSTEM_IDEA_SOURCES = {
  "trace-report-analysis": {
    action: "trace_report_analysis.idea_submitted",
    summary: "Handed one verified trace report's fix to the idea lane.",
  },
  "develop-ci-repair": {
    action: "develop_ci_repair.idea_submitted",
    summary: "Handed one failing develop CI head to the idea lane.",
  },
} as const;

export type SystemIdeaSource = keyof typeof SYSTEM_IDEA_SOURCES;

type SystemIdea = {
  source: SystemIdeaSource;
  ownerUserId: string;
  inspected: Extract<IdeaSubmissionInspection, { ok: true }>;
  /** Identifiers only; never idea text. */
  metadata: Record<string, string | number>;
  /**
   * The source's own limits, read again inside the transaction that writes
   * the idea, after any lock it takes: false refuses the idea and writes nothing.
   */
  admit?: (tx: Prisma.TransactionClient) => Promise<boolean>;
};

/** The source's own limit refused the idea inside its transaction; nothing was written. */
export class SystemIdeaRefused extends Error {
  constructor() {
    super("system_idea_refused");
    this.name = "SystemIdeaRefused";
  }
}

/** Transaction body, for synthetic DB tests; the entry below owns the latch and the keys. */
export async function commitSystemIdea(
  tx: Prisma.TransactionClient,
  input: SystemIdea & { ideaId: string; keys: AmuxContentKeys },
): Promise<{ ideaId: string }> {
  const { ideaId, keys } = input;
  const source = SYSTEM_IDEA_SOURCES[input.source];
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${IDEA_SUBMISSION_STATEMENT_TIMEOUT}, true)`;
  if (input.admit && !(await input.admit(tx))) throw new SystemIdeaRefused();
  const submittedAt = await databaseNow(tx);
  const { data, sealed } = prepareIdeaSubmissionStorage({ inspected: input.inspected, ideaId, keys, submittedAt });
  await tx.amuxIdeaSubmission.create({ data: { ...data, actorUserId: input.ownerUserId } });
  await writeSystemAuditLog({
    tx,
    systemActor: input.source,
    action: source.action,
    targetType: "AmuxIdeaSubmission",
    targetId: ideaId,
    summary: source.summary,
    metadata: {
      requestId: input.inspected.requestId,
      ...input.metadata,
      authorizedByUserId: input.ownerUserId,
      rawDigest: sealed.digest,
      rawDigestKeyId: sealed.digestKeyId,
      ideaBytes: input.inspected.counts.ideaBytes,
    },
  });
  return { ideaId };
}

/**
 * An idea a system pass hands to the idea lane. No session: the idea's data
 * owner is the owner who turned that pass on, and the audit says the system
 * wrote it, under that owner's standing choice. The caller checked they still
 * are an owner. An idea this request already made is returned, not made again.
 */
export async function submitSystemIdea(input: SystemIdea): Promise<{ ideaId: string }> {
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
    return await prisma.$transaction((tx) => commitSystemIdea(tx, { ...input, ideaId, keys }), {
      ...AMUX_IDEA_STANDARD_TRANSACTION,
    });
  } catch (error) {
    // A lost answer or a racing pass: if the row is there, this was the same idea.
    const row = await seen().catch(() => null);
    if (row) return { ideaId: row.id };
    throw error;
  }
}

type TraceReportIdea = {
  ownerUserId: string;
  caseId: string;
  inspected: Extract<IdeaSubmissionInspection, { ok: true }>;
};

/** A verified trace report's fix (docs/policy/trace-feedback-automation.md §8a). */
export const commitTraceReportIdea = (
  tx: Prisma.TransactionClient,
  input: TraceReportIdea & { ideaId: string; keys: AmuxContentKeys },
) =>
  commitSystemIdea(tx, {
    source: "trace-report-analysis",
    ownerUserId: input.ownerUserId,
    inspected: input.inspected,
    metadata: { caseId: input.caseId },
    ideaId: input.ideaId,
    keys: input.keys,
  });

export const submitIdeaFromTraceReport = (input: TraceReportIdea) =>
  submitSystemIdea({
    source: "trace-report-analysis",
    ownerUserId: input.ownerUserId,
    inspected: input.inspected,
    metadata: { caseId: input.caseId },
  });
