import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import {
  AMUX_SESSION_IDEA_SUBMITTED_ACTION,
  AMUX_SESSION_IDEA_SUBMITTED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
  auditRowActorKind,
} from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { sealAmuxContent, type AmuxContentKeys } from "./ideaCrypto.ts";
import {
  readCurrentAmuxIdeaFrontierSelection,
  readCurrentAmuxIdeaFrontierSelectionFromTx,
} from "./ideaFrontierCatalogRead.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxContentKeyRing, createAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { amuxIdeaReferencesOutsideScope,
  amuxOperatingScopeSelection } from "./ideaOperatingScopeCore.ts";
import { readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from "./ideaOperatingScopeStore.ts";
import { AMUX_IDEA_STANDARD_TRANSACTION } from "./ideaRequestTimeoutsCore.ts";
import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
import {
  AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
  AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION,
  AMUX_SESSION_ANALYSIS_RESERVATION_STATUS,
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
} from "./ideaSessionAnalysisReservationCore.ts";
import { commitAmuxSessionAnalysisReservation } from
  "./ideaSessionAnalysisReservationStore.ts";
import {
  AMUX_SESSION_INTAKE_ENV,
  amuxSessionIntakeWritePermitted,
  sameAmuxOperatingScopeAuthority,
  type AmuxIdeaSessionSubmissionInspection,
} from "./ideaSessionSubmissionCore.ts";
import { prepareIdeaSubmissionStorage } from "./ideaSubmissionService.ts";
import { AMUX_V4_IDEA_SUBMISSION_ENV,
  submissionFailureKind } from "./ideaSubmissionCore.ts";

const STATEMENT_TIMEOUT = "5000";
const POLICY_VERSION = 19;

export class AmuxIdeaSessionSubmissionError extends Error {
  constructor(
    readonly code:
      | "submission_disabled"
      | "audit_unavailable"
      | "scope_unavailable"
      | "outside_scope"
      | "model_not_approved"
      | "key_store_unavailable"
      | "request_already_seen"
      | "outcome_unknown",
    readonly readBack?: "committed" | "partial" | "unavailable",
    readonly ideaId?: string,
  ) {
    super(code);
    this.name = "AmuxIdeaSessionSubmissionError";
  }
}

export type CommittedAmuxIdeaSessionSubmission = {
  ideaId: string;
  requestId: string;
  auditId: string;
  operatingScopeSettingId: string;
};

export type CommittedAmuxIdeaSessionIntake =
  CommittedAmuxIdeaSessionSubmission & {
    reservationId: string;
    reservationAuditId: string;
  };

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxIdeaSessionSubmissionError("audit_unavailable");
  }
  return now;
};

const requireCurrentModel = async (
  authority: AmuxOperatingScopeAuthority,
  tx?: Prisma.TransactionClient,
) => {
  const selection = amuxOperatingScopeSelection(authority.scope);
  const model = tx
    ? await readCurrentAmuxIdeaFrontierSelectionFromTx(tx, selection)
    : await readCurrentAmuxIdeaFrontierSelection(selection);
  if (model.decision === "hold") {
    throw new AmuxIdeaSessionSubmissionError("scope_unavailable");
  }
  if (model.decision !== "selection_current") {
    throw new AmuxIdeaSessionSubmissionError("model_not_approved");
  }
  return model;
};

const requireInputWithinScope = (
  authority: AmuxOperatingScopeAuthority,
  inspected: Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }>,
) => {
  if (amuxIdeaReferencesOutsideScope(authority.scope, inspected.input).length > 0) {
    throw new AmuxIdeaSessionSubmissionError("outside_scope");
  }
};

/** Transaction primitive for DB tests and the future complete intake chain.
 * It rechecks scope and model after the canonical audit-chain lock. Never
 * expose it as a route by itself. */
export async function commitAmuxIdeaSessionSubmission(
  tx: Prisma.TransactionClient,
  input: {
    inspected: Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }>;
    expectedAuthority: AmuxOperatingScopeAuthority;
    ideaId: string;
    keys: AmuxContentKeys;
  },
): Promise<CommittedAmuxIdeaSessionSubmission> {
  await takeAuditChainLock(tx);
  const authority = await readAmuxOperatingScopeAuthority(tx);
  if (!authority || !sameAmuxOperatingScopeAuthority(authority, input.expectedAuthority)) {
    throw new AmuxIdeaSessionSubmissionError("scope_unavailable");
  }
  requireInputWithinScope(authority, input.inspected);
  await requireCurrentModel(authority, tx);
  const existing = await tx.amuxIdeaSubmission.findUnique({
    where: { requestId: input.inspected.requestId },
    select: { id: true },
  });
  if (existing) throw new AmuxIdeaSessionSubmissionError("request_already_seen");

  const submittedAt = await databaseNow(tx);
  const prepared = prepareIdeaSubmissionStorage({
    inspected: input.inspected, ideaId: input.ideaId, keys: input.keys, submittedAt,
  });
  const sourcePlain = Buffer.from(JSON.stringify(input.inspected.source), "utf8");
  const source = sealAmuxContent(sourcePlain, "idea_raw", input.ideaId, input.keys);
  const auditId = await writeSystemAuditLog({
    tx,
    systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
    action: AMUX_SESSION_IDEA_SUBMITTED_ACTION,
    targetType: AMUX_SESSION_IDEA_SUBMITTED_TARGET,
    targetId: input.ideaId,
    summary: "Stored one encrypted AMUX session idea under the current owner-approved operating scope.",
    metadata: {
      policyVersion: POLICY_VERSION,
      requestId: input.inspected.requestId,
      rawDigest: prepared.sealed.digest,
      rawDigestKeyId: prepared.sealed.digestKeyId,
      sourceProvenanceDigest: source.digest,
      sourceProvenanceDigestKeyId: source.digestKeyId,
      operatingScopeSettingId: authority.settingId,
      operatingScopeVersion: authority.version,
      modelProvider: authority.scope.model.provider,
      modelId: authority.scope.model.modelId,
      reasoningEffort: authority.scope.model.reasoningEffort,
      ideaBytes: input.inspected.counts.ideaBytes,
      repositoryCount: input.inspected.counts.repositoryCount,
      pullRequestCount: input.inspected.counts.pullRequestCount,
    },
  });
  await tx.amuxIdeaSubmission.create({ data: {
    ...prepared.data,
    actorUserId: authority.approvedByUserId,
    submissionOrigin: "session",
    sessionOperatingScopeSettingId: authority.settingId,
    submissionAuditLogId: auditId,
    sourceProvenanceCiphertext: new Uint8Array(source.ciphertext),
    sourceProvenanceKeyId: source.keyId,
    sourceProvenanceKeyVersion: source.keyVersion,
    sourceProvenanceDigest: source.digest,
    sourceProvenanceDigestKeyId: source.digestKeyId,
  } });
  return { ideaId: input.ideaId, requestId: input.inspected.requestId, auditId,
    operatingScopeSettingId: authority.settingId };
}

/** Metadata-only readback for one session request. It accepts only the
 * dedicated system audit and never returns the encrypted source labels. */
export async function readAmuxIdeaSessionSubmissionRequest(requestId: string): Promise<
  | { requestId: string; status: "absent" }
  | { requestId: string; status: "partial"; ideaId: string }
  | { requestId: string; status: "committed"; ideaId: string;
      reservationId: string; hasExternalSources: boolean }
> {
  if (!isAmuxIdeaRequestId(requestId)) return { requestId, status: "absent" };
  const row = await prisma.amuxIdeaSubmission.findUnique({
    where: { requestId },
    select: {
      id: true, submissionOrigin: true, sessionOperatingScopeSettingId: true,
      submissionAuditLogId: true, rawKeyId: true, rawKeyVersion: true,
      rawPurgedAt: true, rawDigest: true, rawDigestKeyId: true,
      sourceProvenanceCiphertext: true, sourceProvenanceKeyId: true,
      sourceProvenanceKeyVersion: true, sourceProvenanceDigest: true,
      sourceProvenanceDigestKeyId: true,
      actorUserId: true,
      sessionAnalysisReservation: true,
    },
  });
  if (!row || row.submissionOrigin !== "session" || !row.submissionAuditLogId) {
    return { requestId, status: "absent" };
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.submissionAuditLogId },
  });
  const metadata = audit?.metadata;
  if (!audit?.entryHash || auditRowActorKind(audit) !== "system" ||
      audit.action !== AMUX_SESSION_IDEA_SUBMITTED_ACTION ||
      audit.targetType !== AMUX_SESSION_IDEA_SUBMITTED_TARGET ||
      audit.targetId !== row.id || !metadata || typeof metadata !== "object" ||
      Array.isArray(metadata)) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  const values = metadata as Record<string, unknown>;
  const repositoryCount = values.repositoryCount;
  const pullRequestCount = values.pullRequestCount;
  const activeSource = row.rawPurgedAt === null &&
    row.sourceProvenanceCiphertext !== null &&
    row.sourceProvenanceKeyId === row.rawKeyId &&
    row.sourceProvenanceKeyVersion === row.rawKeyVersion;
  const purgedSource = row.rawPurgedAt !== null &&
    row.sourceProvenanceCiphertext === null &&
    row.sourceProvenanceKeyId === null &&
    row.sourceProvenanceKeyVersion === null;
  if (values.policyVersion !== POLICY_VERSION || values.requestId !== requestId ||
      values.rawDigest !== row.rawDigest || values.rawDigestKeyId !== row.rawDigestKeyId ||
      values.sourceProvenanceDigest !== row.sourceProvenanceDigest ||
      values.sourceProvenanceDigestKeyId !== row.sourceProvenanceDigestKeyId ||
      values.operatingScopeSettingId !== row.sessionOperatingScopeSettingId ||
      !Number.isSafeInteger(repositoryCount) || (repositoryCount as number) < 0 ||
      !Number.isSafeInteger(pullRequestCount) || (pullRequestCount as number) < 0 ||
      (!activeSource && !purgedSource)) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  const reservation = row.sessionAnalysisReservation;
  if (!reservation || reservation.requestId !== requestId ||
      reservation.ideaId !== row.id ||
      reservation.actorUserId !== row.actorUserId ||
      reservation.operatingScopeSettingId !== row.sessionOperatingScopeSettingId ||
      reservation.status !== AMUX_SESSION_ANALYSIS_RESERVATION_STATUS) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  const reservationAudit = await prisma.adminAuditLog.findUnique({
    where: { id: reservation.reservationAuditLogId },
  });
  const reservationMetadata = reservationAudit?.metadata;
  if (!reservationAudit?.entryHash ||
      auditRowActorKind(reservationAudit) !== "system" ||
      reservationAudit.action !== AMUX_SESSION_ANALYSIS_RESERVED_ACTION ||
      reservationAudit.targetType !== AMUX_SESSION_ANALYSIS_RESERVED_TARGET ||
      reservationAudit.targetId !== reservation.id ||
      reservationAudit.summary !== AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY ||
      !reservationMetadata || typeof reservationMetadata !== "object" ||
      Array.isArray(reservationMetadata)) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  const reservationValues = reservationMetadata as Record<string, unknown>;
  const expectedReservationValues = {
    systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
    actorScope: AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
    policyVersion: AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION,
    reservationId: reservation.id,
    ideaId: row.id,
    requestId,
    submissionAuditId: row.submissionAuditLogId,
    operatingScopeSettingId: row.sessionOperatingScopeSettingId,
    dataOwnerUserId: row.actorUserId,
    modelProvider: reservation.modelProvider,
    modelId: reservation.modelId,
    reasoningEffort: reservation.reasoningEffort,
  };
  if (Object.keys(reservationValues).length !==
        Object.keys(expectedReservationValues).length ||
      Object.entries(expectedReservationValues).some(([key, value]) =>
        reservationValues[key] !== value)) {
    return { requestId, status: "partial", ideaId: row.id };
  }
  return { requestId, status: "committed", ideaId: row.id,
    reservationId: reservation.id,
    hasExternalSources: (repositoryCount as number) + (pullRequestCount as number) > 0 };
}

/** Default-off write service. It atomically stores the encrypted submission
 * and its append-only queue identity. There is intentionally no POST route
 * until direct-read source evidence and the system transfer/cost gates form a
 * complete analysis boundary; this queue receipt reserves no money. */
export async function submitAmuxIdeaFromSession(input: {
  inspected: Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }>;
}): Promise<CommittedAmuxIdeaSessionIntake> {
  if (!amuxSessionIntakeWritePermitted(
    process.env[AMUX_SESSION_INTAKE_ENV],
    process.env[AMUX_V4_IDEA_SUBMISSION_ENV],
  )) throw new AmuxIdeaSessionSubmissionError("submission_disabled");
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxIdeaSessionSubmissionError("audit_unavailable");
  }
  const existing = await readAmuxIdeaSessionSubmissionRequest(input.inspected.requestId);
  if (existing.status !== "absent") {
    throw new AmuxIdeaSessionSubmissionError(
      "request_already_seen", existing.status, existing.ideaId,
    );
  }
  const expectedAuthority = await prisma.$transaction((tx) =>
    readAmuxOperatingScopeAuthority(tx), { ...AMUX_IDEA_STANDARD_TRANSACTION });
  if (!expectedAuthority) throw new AmuxIdeaSessionSubmissionError("scope_unavailable");
  requireInputWithinScope(expectedAuthority, input.inspected);
  await requireCurrentModel(expectedAuthority);

  const global = loadCurrentAmuxContentKeys(process.env);
  const ideaId = randomUUID();
  const keyIdentity = { ideaId, purpose: "idea_raw" as const, subjectId: ideaId };
  let keys: AmuxContentKeys;
  try {
    const unit = await createAmuxContentUnitKeys(keyIdentity);
    keys = amuxContentKeyRing(global, [{ identity: keyIdentity, keys: unit }]);
  } catch {
    throw new AmuxIdeaSessionSubmissionError("key_store_unavailable");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      const committed = await commitAmuxIdeaSessionSubmission(tx, {
        ...input, expectedAuthority, ideaId, keys,
      });
      const reservation = await commitAmuxSessionAnalysisReservation(tx, {
        ideaId: committed.ideaId,
        requestId: committed.requestId,
        submissionAuditId: committed.auditId,
        authority: expectedAuthority,
      });
      callbackReturned = true;
      return { ...committed, reservationId: reservation.reservationId,
        reservationAuditId: reservation.reservationAuditId };
    }, { ...AMUX_IDEA_STANDARD_TRANSACTION });
  } catch (error) {
    if (error instanceof AmuxIdeaSessionSubmissionError &&
        error.code === "request_already_seen") {
      const seen = await readAmuxIdeaSessionSubmissionRequest(input.inspected.requestId);
      throw new AmuxIdeaSessionSubmissionError(
        "request_already_seen",
        seen.status === "absent" ? "unavailable" : seen.status,
        seen.status === "absent" ? undefined : seen.ideaId,
      );
    }
    const kind = submissionFailureKind(callbackReturned, error);
    if (kind === "definitive_failure") throw error;
    let readBack: AmuxIdeaSessionSubmissionError["readBack"] = "unavailable";
    let seenIdeaId: string | undefined;
    try {
      const seen = await readAmuxIdeaSessionSubmissionRequest(input.inspected.requestId);
      if (seen.status !== "absent") {
        readBack = seen.status;
        seenIdeaId = seen.ideaId;
      }
    } catch {
      // Readback may race COMMIT or fail independently; never infer absence.
    }
    throw new AmuxIdeaSessionSubmissionError("outcome_unknown", readBack, seenIdeaId);
  }
}
