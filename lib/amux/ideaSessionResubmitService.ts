import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import type { IdeaInput } from "./ideaInputCore.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { closeAmuxIdeasForOwner } from "./ideaOwnerCloseService.ts";
import { AMUX_IDEA_RESUBMIT_ACTION, amuxIdeaResubmitRequestId,
  inspectAmuxIdeaResubmission, runAmuxIdeaResubmit,
  type AmuxIdeaResubmitOutcome, type AmuxIdeaResubmitRefusal,
  type AmuxIdeaResubmitSteps } from "./ideaSessionResubmitCore.ts";
import { amuxIdeaSessionPrewriteStatus,
  inspectSealedAmuxIdeaSessionInput } from "./ideaSessionSubmissionCore.ts";
import { AmuxIdeaSessionSubmissionError, readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession } from "./ideaSessionSubmissionService.ts";

type Db = Pick<Prisma.TransactionClient, "amuxIdeaSubmission" | "amuxIdeaAnalysisChunk">;

export class AmuxIdeaResubmitError extends Error {
  constructor(readonly code: "forbidden" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaResubmitError";
  }
}

/**
 * The old idea's sealed input, read the way the analysis reads it: opened,
 * digest-checked and structurally inspected. Only a session idea of this
 * owner that waits after an analysis with no plan to register qualifies (its
 * newest page, if any, never left `pending`), and only while its body is kept.
 * The key is loaded after those checks, so a purged idea's retired key is never
 * asked for.
 */
export async function readAmuxResubmittableIdeaInput(db: Db,
  input: { ideaId: string; actorUserId: string },
  loadKeys: () => Promise<AmuxContentKeys>,
): Promise<{ ok: true; input: IdeaInput } | { ok: false; reason: AmuxIdeaResubmitRefusal }> {
  const idea = await db.amuxIdeaSubmission.findUnique({ where: { id: input.ideaId },
    select: { id: true, actorUserId: true, state: true, submissionOrigin: true,
      cancelledAt: true, rawPurgedAt: true, rawCiphertext: true, rawKeyId: true,
      rawKeyVersion: true, rawDigest: true, rawDigestKeyId: true } });
  // Another owner's idea is indistinguishable from a missing one.
  if (!idea || idea.actorUserId !== input.actorUserId) return { ok: false, reason: "not_found" };
  const latest = await db.amuxIdeaAnalysisChunk.findFirst({ where: { ideaId: idea.id },
    orderBy: { chunkIndex: "desc" }, select: { state: true } });
  if (idea.submissionOrigin !== "session" || idea.state !== "awaiting_owner" ||
      idea.cancelledAt !== null || (latest !== null && latest.state !== "pending")) {
    return { ok: false, reason: "not_resubmittable" };
  }
  if (idea.rawPurgedAt !== null || !idea.rawCiphertext) return { ok: false, reason: "raw_purged" };
  if (!idea.rawKeyId || !idea.rawKeyVersion || !idea.rawDigest || !idea.rawDigestKeyId) {
    throw new AmuxIdeaResubmitError("integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  let plain: Buffer;
  try {
    keys = await loadKeys();
    plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion }, "idea_raw", idea.id, keys);
  } catch { throw new AmuxIdeaResubmitError("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(plain, "idea_raw", idea.id, idea.rawDigest,
      idea.rawDigestKeyId, keys)) throw new AmuxIdeaResubmitError("integrity_unavailable");
    let parsed: unknown;
    try { parsed = JSON.parse(plain.toString("utf8")); }
    catch { throw new AmuxIdeaResubmitError("integrity_unavailable"); }
    const inspected = inspectSealedAmuxIdeaSessionInput(parsed);
    if (!inspected.ok) throw new AmuxIdeaResubmitError("integrity_unavailable");
    return { ok: true, input: inspected.input };
  } finally { plain.fill(0); }
}

/** One intake write of the resubmission; a refusal before the intake
 * transaction is an answer, anything else is read back by the caller. */
export async function submitAmuxIdeaResubmission(requestId: string,
  input: IdeaInput): Promise<{ ideaId: string } | { refused: string }> {
  const inspected = inspectAmuxIdeaResubmission(requestId, input);
  if (!inspected.ok) return { refused: inspected.code };
  // As on the Admin input: the analysis reads its references from checkouts.
  if (inspected.counts.repositoryCount + inspected.counts.pullRequestCount === 0) {
    return { refused: "references_required" };
  }
  try {
    return { ideaId: (await submitAmuxIdeaFromSession({ inspected })).ideaId };
  } catch (error) {
    if (error instanceof AmuxIdeaSessionSubmissionError &&
        amuxIdeaSessionPrewriteStatus(error.code) !== undefined) {
      return { refused: error.code };
    }
    throw error;
  }
}

/** Records who resubmitted the old idea as which new one, then closes it with
 * the existing owner close (whose reason is kept only as a digest). A failed
 * audit leaves the old idea open; the next click writes it again. */
export async function closeResubmittedAmuxIdea(input: { session: Session;
  request: Request; previousIdeaId: string; ideaId: string }): Promise<boolean> {
  await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: AMUX_IDEA_RESUBMIT_ACTION, targetType: "AmuxIdeaSubmission",
      targetId: input.previousIdeaId,
      summary: "Owner submitted one AMUX session idea again with its kept text and references.",
      metadata: { ideaId: input.ideaId,
        requestId: amuxIdeaResubmitRequestId(input.previousIdeaId) } });
  }, { maxWait: 5_000, timeout: 15_000 });
  const [outcome] = await closeAmuxIdeasForOwner({ session: input.session,
    request: input.request, ideaIds: [input.previousIdeaId],
    reason: `Resubmitted as AMUX idea ${input.ideaId}.` });
  return outcome?.result === "closed" || outcome?.result === "already_closed";
}

/** The owner's "submit again with the same content" from an idea's detail. */
export async function resubmitAmuxSessionIdeaForOwner(input: { session: Session;
  request: Request; ideaId: string }): Promise<AmuxIdeaResubmitOutcome> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxIdeaResubmitError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  const steps: AmuxIdeaResubmitSteps = {
    readBack: readAmuxIdeaSessionSubmissionRequest,
    readInput: (ideaId) => readAmuxResubmittableIdeaInput(prisma, { ideaId, actorUserId },
      () => loadAmuxContentKeyRing([{ ideaId, purpose: "idea_raw", subjectId: ideaId }])),
    submit: submitAmuxIdeaResubmission,
    close: (previousIdeaId, ideaId) => closeResubmittedAmuxIdea({ session: input.session,
      request: input.request, previousIdeaId, ideaId }),
  };
  return runAmuxIdeaResubmit(steps, input.ideaId);
}
