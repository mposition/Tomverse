import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { AMUX_V20_REGISTRATION_REFUSAL_ACTION,
  AMUX_V20_REGISTRATION_REFUSAL_SUMMARY,
  AMUX_V20_REGISTRATION_REFUSAL_TARGET,
  amuxV20RegistrationRefusalMetadata,
  amuxV20RegistrationRefusalView,
  isAmuxV20RegistrationRefusalAttemptKind,
  isAmuxV20RegistrationRefusalGrade,
  isAmuxRegistrationRefusalCode,
  type AmuxV20RegistrationRefusalAttemptKind,
  type AmuxV20RegistrationRefusalRecord,
  type AmuxRegistrationRefusalCode,
  type AmuxV20RegistrationRefusalView } from
  "./ideaRegistrationRefusalCore.ts";
import type { AmuxExecutionGrade } from "./executionGradeCore.ts";
import { amuxRegistrationAuthorityActor,
  isAmuxSystemRegistrationAuthority,
  type AmuxRegistrationAuditAuthority,
  writeAmuxRegistrationAudit } from "./ideaRegistrationAuditAuthority.ts";

const ID = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class AmuxV20RegistrationRefusalStoreError extends Error {
  constructor(readonly code: "forbidden" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxV20RegistrationRefusalStoreError";
  }
}

type RecordInput = AmuxRegistrationAuditAuthority & {
  requestId: string;
  attemptKind: AmuxV20RegistrationRefusalAttemptKind;
  refusalCode: AmuxRegistrationRefusalCode;
  ideaId: string;
  draftUnitId: string;
  analysisPreviewId: string;
  proposedExecutionGrade: AmuxExecutionGrade | null;
  finalExecutionGrade: AmuxExecutionGrade | null;
};

const matchesInput = (row: AmuxV20RegistrationRefusalRecord, input: RecordInput,
  actorUserId: string, sourcePlanRevisionId?: string) =>
  row.requestId === input.requestId && row.attemptKind === input.attemptKind &&
  row.state === "awaiting_operator" && row.refusalCode === input.refusalCode &&
  row.ideaId === input.ideaId && row.draftUnitId === input.draftUnitId &&
  row.actorUserId === actorUserId &&
  row.analysisPreviewId === input.analysisPreviewId &&
  (sourcePlanRevisionId === undefined ||
    row.sourcePlanRevisionId === sourcePlanRevisionId) &&
  row.proposedExecutionGrade === input.proposedExecutionGrade &&
  row.finalExecutionGrade === input.finalExecutionGrade;

const validInput = (input: RecordInput) => UUID.test(input.requestId) &&
  isAmuxV20RegistrationRefusalAttemptKind(input.attemptKind) &&
  isAmuxRegistrationRefusalCode(input.refusalCode) &&
  ID.test(input.ideaId) && ID.test(input.draftUnitId) &&
  ID.test(input.analysisPreviewId) &&
  (input.proposedExecutionGrade === null ||
    isAmuxV20RegistrationRefusalGrade(input.proposedExecutionGrade)) &&
  (input.finalExecutionGrade === null ||
    isAmuxV20RegistrationRefusalGrade(input.finalExecutionGrade));

/** Persist the refusal after the registration transaction has rolled back.
 * The request id is the retry identity; an exact retry returns the first row. */
export async function recordAmuxV20RegistrationRefusal(
  input: RecordInput,
): Promise<AmuxV20RegistrationRefusalView> {
  let actorUserId: string;
  try { actorUserId = amuxRegistrationAuthorityActor(input); } catch {
    throw new AmuxV20RegistrationRefusalStoreError("forbidden");
  }
  if (!isAmuxSystemRegistrationAuthority(input)) {
    await assertRecentAdminAuthentication(input.session);
  }
  if (!validInput(input)) {
    throw new AmuxV20RegistrationRefusalStoreError("integrity_unavailable");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const existing = await tx.amuxIdeaRegistrationRefusal.findUnique({
        where: { requestId: input.requestId },
      });
      if (existing) {
        if (!matchesInput(existing, input, actorUserId)) {
          throw new AmuxV20RegistrationRefusalStoreError("integrity_unavailable");
        }
        return amuxV20RegistrationRefusalView(existing);
      }
      const units = await tx.$queryRaw<Array<{ id: string; ideaId: string;
        actorUserId: string; chunkIndex: number; unitKind: string }>>`
        SELECT "id", "ideaId", "actorUserId", "chunkIndex", "unitKind"
        FROM "AmuxIdeaDraftUnit"
        WHERE "id" = ${input.draftUnitId} FOR KEY SHARE
      `;
      const unit = units[0];
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: input.analysisPreviewId },
        select: { ideaId: true, chunkIndex: true, sourcePlanRevisionId: true },
      });
      const idea = await tx.amuxIdeaSubmission.findFirst({
        where: { id: input.ideaId, actorUserId }, select: { id: true },
      });
      if (!idea || units.length !== 1 || !unit || unit.ideaId !== input.ideaId ||
          unit.actorUserId !== actorUserId || unit.unitKind !== "card" ||
          !preview || !preview.sourcePlanRevisionId ||
          preview.ideaId !== input.ideaId ||
          preview.chunkIndex !== unit.chunkIndex) {
        throw new AmuxV20RegistrationRefusalStoreError("integrity_unavailable");
      }
      const clock = await tx.$queryRaw<Array<{ attemptedAt: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "attemptedAt"
      `;
      const attemptedAt = clock[0]?.attemptedAt;
      if (!(attemptedAt instanceof Date) ||
          !Number.isFinite(attemptedAt.getTime())) {
        throw new AmuxV20RegistrationRefusalStoreError("integrity_unavailable");
      }
      const id = randomUUID();
      const row = { requestId: input.requestId,
        attemptKind: input.attemptKind, state: "awaiting_operator",
        refusalCode: input.refusalCode, ideaId: input.ideaId,
        draftUnitId: input.draftUnitId, actorUserId,
        analysisPreviewId: input.analysisPreviewId,
        sourcePlanRevisionId: preview.sourcePlanRevisionId,
        proposedExecutionGrade: input.proposedExecutionGrade,
        finalExecutionGrade: input.finalExecutionGrade, attemptedAt };
      const auditLogId = await writeAmuxRegistrationAudit({ tx,
        authority: input, action: AMUX_V20_REGISTRATION_REFUSAL_ACTION,
        targetType: AMUX_V20_REGISTRATION_REFUSAL_TARGET, targetId: id,
        summary: AMUX_V20_REGISTRATION_REFUSAL_SUMMARY,
        metadata: amuxV20RegistrationRefusalMetadata({ id, ...row }) });
      const created = await tx.amuxIdeaRegistrationRefusal.create({ data: {
        id, ...row, auditLogId,
      } });
      return amuxV20RegistrationRefusalView(created);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof AmuxV20RegistrationRefusalStoreError) throw error;
    const existing = await prisma.amuxIdeaRegistrationRefusal.findUnique({
      where: { requestId: input.requestId },
    }).catch(() => null);
    if (existing && matchesInput(existing, input, actorUserId)) {
      return amuxV20RegistrationRefusalView(existing);
    }
    // A callback error proves rollback; a post-callback error was read back
    // above. Neither is reported as a successful refusal without its row.
    throw new AmuxV20RegistrationRefusalStoreError("integrity_unavailable");
  }
}

