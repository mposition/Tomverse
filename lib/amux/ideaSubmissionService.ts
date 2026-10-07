import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { sealAmuxContent, type AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxContentKeyRing, createAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { analysisDeadlineAt } from "./ideaRetentionCore.ts";
import {
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionWritePermitted,
  submissionFailureKind,
  type IdeaSubmissionInspection,
} from "./ideaSubmissionCore.ts";

const AUDIT_ACTION = "AMUX_V4_IDEA_SUBMITTED";
const TARGET_TYPE = "AmuxIdeaSubmission";
const STATEMENT_TIMEOUT = "5000";

export class IdeaSubmissionError extends Error {
  constructor(
    readonly code: "submission_disabled" | "forbidden" | "audit_unavailable" |
      "key_store_unavailable" | "request_already_seen" | "outcome_unknown",
    readonly status: number,
    readonly readBack?: "committed" | "partial" | "unavailable",
    readonly ideaId?: string,
  ) {
    super(code);
    this.name = "IdeaSubmissionError";
  }
}

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new IdeaSubmissionError("forbidden", 403);
  }
  return id;
};

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IdeaSubmissionError("audit_unavailable", 503);
  }
  return now;
};

export type CommittedIdeaSubmission = { ideaId: string; requestId: string; auditId: string };

/** Transaction body for synthetic DB tests. The public entry below owns the
 * closed shipment latch, owner step-up and key preflight. Never route here. */
export async function commitIdeaSubmission(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request: Request;
    inspected: Extract<IdeaSubmissionInspection, { ok: true }>;
    ideaId: string;
    keys: AmuxContentKeys;
  },
): Promise<CommittedIdeaSubmission> {
  const actorUserId = actorId(input.session);
  const existing = await tx.amuxIdeaSubmission.findUnique({
    where: { requestId: input.inspected.requestId },
    select: { id: true },
  });
  if (existing) throw new IdeaSubmissionError("request_already_seen", 409);

  const submittedAt = await databaseNow(tx);
  const analysisDeadline = analysisDeadlineAt(submittedAt);
  const body = Buffer.from(JSON.stringify(input.inspected.input), "utf8");
  const sealed = sealAmuxContent(body, "idea_raw", input.ideaId, input.keys);
  await tx.amuxIdeaSubmission.create({
    data: {
      id: input.ideaId,
      requestId: input.inspected.requestId,
      actorUserId,
      state: "submitted",
      rawCiphertext: new Uint8Array(sealed.ciphertext),
      rawKeyId: sealed.keyId,
      rawKeyVersion: sealed.keyVersion,
      rawDigest: sealed.digest,
      rawDigestKeyId: sealed.digestKeyId,
      submittedAt,
      analysisDeadlineAt: analysisDeadline,
      // This is eligibility, not the 24-hour latest-compliant SLA time.
      rawPurgeAfter: analysisDeadline,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    },
  });
  const auditId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: AUDIT_ACTION,
    targetType: TARGET_TYPE,
    targetId: input.ideaId,
    summary: "Submitted one AMUX v4 idea for bounded analysis.",
    metadata: {
      policyVersion: 7,
      requestId: input.inspected.requestId,
      rawDigest: sealed.digest,
      rawDigestKeyId: sealed.digestKeyId,
      ideaBytes: input.inspected.counts.ideaBytes,
      repositoryCount: input.inspected.counts.repositoryCount,
      pullRequestCount: input.inspected.counts.pullRequestCount,
      transferAuthorized: false,
      registeredCards: 0,
    },
    tx,
  });
  return { ideaId: input.ideaId, requestId: input.inspected.requestId, auditId };
}

/** Read-back is metadata-only and owner-scoped. Absence after an ambiguous
 * commit is not permission to blindly retry the submission. */
export async function readIdeaSubmissionRequest(
  session: Session,
  requestId: string,
): Promise<
  | { requestId: string; status: "absent" }
  | { requestId: string; status: "partial"; ideaId: string }
  | { requestId: string; status: "committed"; ideaId: string; hasExternalSources: boolean }
> {
  const actorUserId = actorId(session);
  const row = await prisma.amuxIdeaSubmission.findUnique({
    where: { requestId },
    select: { id: true, actorUserId: true },
  });
  if (!row || row.actorUserId !== actorUserId) return { requestId, status: "absent" };
  const audit = await prisma.adminAuditLog.findFirst({
    where: {
      action: AUDIT_ACTION,
      targetType: TARGET_TYPE,
      targetId: row.id,
      actorUserId,
    },
    select: { id: true, entryHash: true, metadata: true },
  });
  const metadata = audit?.metadata;
  if (!audit?.entryHash || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  const values = metadata as Record<string, unknown>;
  const repositoryCount = values.repositoryCount;
  const pullRequestCount = values.pullRequestCount;
  if (values.requestId !== requestId || values.transferAuthorized !== false ||
      !Number.isSafeInteger(repositoryCount) || (repositoryCount as number) < 0 ||
      !Number.isSafeInteger(pullRequestCount) || (pullRequestCount as number) < 0) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  return { requestId, status: "committed", ideaId: row.id,
    hasExternalSources: (repositoryCount as number) + (pullRequestCount as number) > 0 };
}

/** New v4 submission path. The hard code latch ships false. */
export async function submitIdea(input: {
  session: Session;
  request: Request;
  inspected: Extract<IdeaSubmissionInspection, { ok: true }>;
}): Promise<CommittedIdeaSubmission> {
  actorId(input.session);
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
    // No DB transaction was opened. An uncertain object-store PUT can leave
    // only an orphan key, never a committed user body.
    throw new IdeaSubmissionError("key_store_unavailable", 503);
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      const committed = await commitIdeaSubmission(tx, { ...input, ideaId, keys });
      callbackReturned = true;
      return committed;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    const kind = submissionFailureKind(callbackReturned, error);
    if (kind === "request_already_seen") {
      throw new IdeaSubmissionError("request_already_seen", 409);
    }
    if (kind === "definitive_failure") {
      throw error;
    }
    let readBack: IdeaSubmissionError["readBack"] = "unavailable";
    let seenIdeaId: string | undefined;
    try {
      const seen = await readIdeaSubmissionRequest(input.session, input.inspected.requestId);
      if (seen.status !== "absent") {
        readBack = seen.status;
        seenIdeaId = seen.ideaId;
      }
    } catch {
      // A second read can race COMMIT or fail independently; never infer absence.
    }
    throw new IdeaSubmissionError("outcome_unknown", 503, readBack, seenIdeaId);
  }
}
