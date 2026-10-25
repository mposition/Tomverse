import "server-only";

import type { Prisma } from "@prisma/client";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { selectAmuxSessionCheckoutReference,
  type AmuxSessionCheckoutReference } from
  "./ideaSessionCheckoutReferenceCore.ts";
import { readAmuxSessionReferencePin } from
  "./ideaSessionReferencePinRead.ts";
import { inspectSealedAmuxIdeaSessionInput } from
  "./ideaSessionSubmissionCore.ts";

const PIN_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Release one repository identity only for the exact in-flight claim. The
 * intake audit supplies the SHA; the sealed, digest-checked idea supplies the
 * repository/PR identity. Neither a queue hint nor the caller names a repo. */
export async function readAmuxSessionCheckoutReference(input: {
  reservationId: string; ideaId: string; claimId: string;
  referenceOrdinal: number; requiredBudgetMode?: "bounded" | "max_shadow";
}): Promise<AmuxSessionCheckoutReference | null> {
  const pin = await readAmuxSessionReferencePin(input);
  if (!pin || !pin.pinnedCommitSha) return null;
  const expectedPin = { referenceCount: pin.referenceCount,
    pinnedCommitSha: pin.pinnedCommitSha };
  const keys = await loadAmuxContentKeyRing([{ ideaId: input.ideaId,
    purpose: "idea_raw", subjectId: input.ideaId }]);
  return prisma.$transaction((tx) =>
    readAmuxSessionCheckoutReferenceInTx(tx, input, expectedPin, keys),
  { maxWait: 2_000, timeout: 5_000 });
}

/** Recheck claim and audit after loading the external content key. Keeping the
 * audit check in this snapshot prevents a forged pin from the caller of this
 * transaction primitive from selecting an arbitrary SHA. */
export async function readAmuxSessionCheckoutReferenceInTx(
  tx: Prisma.TransactionClient,
  input: { reservationId: string; ideaId: string; claimId: string;
    referenceOrdinal: number; requiredBudgetMode?: "bounded" | "max_shadow" },
  pin: { referenceCount: number; pinnedCommitSha: string },
  keys: AmuxContentKeys,
): Promise<AmuxSessionCheckoutReference | null> {
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
        budgetClaims: { some: { id: input.claimId, status: "in_flight",
          closedAt: null, resolutionAuditLogId: null,
          ...(input.requiredBudgetMode ? {
            budgetMode: input.requiredBudgetMode } : {}) } },
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
        !Array.isArray(pins) || pins.length !== pin.referenceCount ||
        !pins.every((sha) => typeof sha === "string" && PIN_SHA.test(sha)) ||
        pins[input.referenceOrdinal] !== pin.pinnedCommitSha ||
        !Number.isSafeInteger(values.repositoryCount) ||
        !Number.isSafeInteger(values.pullRequestCount) ||
        (values.repositoryCount as number) < 0 ||
        (values.pullRequestCount as number) < 0 ||
        (values.repositoryCount as number) +
          (values.pullRequestCount as number) !== pins.length) return null;
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
      if (!inspected.ok) return null;
      if (inspected.counts.repositoryCount !== values.repositoryCount ||
          inspected.counts.pullRequestCount !== values.pullRequestCount ||
          inspected.counts.ideaBytes !== values.ideaBytes) return null;
      return selectAmuxSessionCheckoutReference({ idea: inspected.input,
        referenceCount: pin.referenceCount,
        pinnedCommitSha: pin.pinnedCommitSha,
        referenceOrdinal: input.referenceOrdinal });
    } finally { plain.fill(0); }
}
