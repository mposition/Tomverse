import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest, type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxContentKeyRing, loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { inspectAmuxIdeaSourceScope } from "./ideaSourceScopeCore.ts";
import {
  AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV,
  sourceScopePreviewPermitted,
  type AmuxSourceScopePreviewRequest,
} from "./ideaSourceScopePreviewCore.ts";

export class AmuxSourceScopePreviewError extends Error {
  constructor(readonly code: "preview_disabled" | "not_found" | "idea_unavailable" |
    "scope_rejected" | "preview_unavailable", readonly status: number) {
    super(code);
    this.name = "AmuxSourceScopePreviewError";
  }
}

const ownerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxSourceScopePreviewError("not_found", 404);
  }
  return id;
};

export type AmuxSourceScopePreview = {
  ideaId: string;
  canonicalScopeJson: string;
  fileCount: number;
  collectionVerified: false;
  transferAuthorized: false;
};

/** Public-path transaction protection; exported only for synthetic DB proof. */
export async function configureAmuxSourceScopeReadOnlyTransaction(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
}

/** A synthetic-test seam. This reads one owned, audited idea and never writes. */
export async function previewAmuxSourceScopeInTransaction(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  request: AmuxSourceScopePreviewRequest,
  keys: AmuxContentKeys,
): Promise<AmuxSourceScopePreview> {
  const times = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = times[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxSourceScopePreviewError("preview_unavailable", 503);
  }
  const idea = await tx.amuxIdeaSubmission.findFirst({
    where: { id: request.ideaId, actorUserId },
    select: {
      id: true, state: true, analysisDeadlineAt: true, rawCiphertext: true,
      rawKeyId: true, rawKeyVersion: true, rawDigest: true,
      rawDigestKeyId: true, rawPurgedAt: true,
    },
  });
  if (!idea) throw new AmuxSourceScopePreviewError("not_found", 404);
  if (idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      idea.rawPurgedAt !== null || !idea.rawCiphertext || !idea.rawKeyId ||
      !idea.rawKeyVersion || !idea.rawDigest || !idea.rawDigestKeyId) {
    throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  }
  const audit = await tx.adminAuditLog.findFirst({
    where: { action: "AMUX_V4_IDEA_SUBMITTED", targetType: "AmuxIdeaSubmission",
      targetId: idea.id, actorUserId },
    select: { id: true },
  });
  if (!audit) throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  let plain: Buffer;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion }, "idea_raw", idea.id, keys);
  } catch {
    // A rotated-away key or unreadable envelope must not fall back to the
    // browser's copy of the idea. Read-key rotation is a separate live gate.
    throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  }
  if (!verifyAmuxContentDigest(plain, "idea_raw", idea.id,
    idea.rawDigest, idea.rawDigestKeyId, keys)) {
    throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  }
  const declared = inspectAmuxIdeaInput(plain.toString("utf8"));
  if (!declared.ok) throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  const scope = inspectAmuxIdeaSourceScope(request.scopeJson, declared.input);
  if (!scope.ok) throw new AmuxSourceScopePreviewError("scope_rejected", 400);
  return {
    ideaId: idea.id,
    canonicalScopeJson: scope.canonicalJson,
    fileCount: scope.fileCount,
    collectionVerified: false,
    transferAuthorized: false,
  };
}

/** No GitHub read, source approval, transfer receipt, model call or DB write. */
export async function previewAmuxSourceScope(
  session: Session,
  request: AmuxSourceScopePreviewRequest,
): Promise<AmuxSourceScopePreview> {
  const actorUserId = ownerId(session);
  if (!sourceScopePreviewPermitted(process.env[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV])) {
    throw new AmuxSourceScopePreviewError("preview_disabled", 503);
  }
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: request.ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new AmuxSourceScopePreviewError("not_found", 404);
  let keys: AmuxContentKeys;
  try {
    const global = loadCurrentAmuxContentKeys(process.env);
    const identity = { ideaId: request.ideaId, purpose: "idea_raw" as const,
      subjectId: request.ideaId };
    const unit = await loadAmuxContentUnitKeys(identity);
    keys = amuxContentKeyRing(global, [{ identity, keys: unit }]);
  } catch {
    throw new AmuxSourceScopePreviewError("idea_unavailable", 409);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await configureAmuxSourceScopeReadOnlyTransaction(tx);
      return previewAmuxSourceScopeInTransaction(tx, actorUserId, request, keys);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof AmuxSourceScopePreviewError) throw error;
    throw new AmuxSourceScopePreviewError("preview_unavailable", 503);
  }
}
