import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  ARTIFACT_SHARE_FILE_FORMATS,
  answerContainsCode,
  artifactShareRefusal,
  artifactShareSourceKey,
  artifactShareTtlDays,
  shareableCodeLanguage,
  type ArtifactShareLanguage,
  type ArtifactShareRefusalCode,
} from "@/lib/artifactShareAccess";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { BoundedBufferError } from "@/lib/boundedBuffer";
import type { CodePreviewKind } from "@/lib/chatArtifactPreview";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { HTML_PREVIEW_MAX_BYTES } from "@/lib/htmlArtifactPreview";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import { createShareToken, isStrongShareToken } from "@/lib/shareTokens";

/**
 * Making, finding, opening and removing share links for previewed pages.
 *
 * Policy: docs/policy/generated-artifacts.md section 19. What is published is
 * read here, on the server, from the source the caller owns -- the generated
 * file's own bytes, or a code block whose text the stored answer contains --
 * never a page the browser supplies. Edits made in the panel are therefore not
 * shareable, by construction.
 */

export type ArtifactShareSourceInput =
  | { kind: "artifact"; artifactId: string }
  | { kind: "code_block"; messageId: string; language: string; code: string };

export type ArtifactShareView = { id: string; token: string; createdAt: string; expiresAt: string };

export type PublicArtifactShare = {
  previewKind: CodePreviewKind;
  language: ArtifactShareLanguage;
  title: string | null;
  content: string;
  expiresAt: Date;
};

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const conversationFacts = {
  userId: true,
  kind: true,
  temporaryExpiresAt: true,
  password: true,
  continuationBridge: { select: { id: true } },
} as const;

type ConversationRow = {
  userId: string;
  kind: string;
  temporaryExpiresAt: Date | null;
  password: string | null;
  continuationBridge: { id: string } | null;
};

const factsOf = (conversation: ConversationRow) => ({
  isChatKind: isChatConversationKind(conversation.kind),
  temporary: conversation.temporaryExpiresAt !== null,
  locked: conversation.password !== null,
  continuesImport: conversation.continuationBridge !== null,
});

/**
 * Whether a Research answer drew on private sources: any manifest entry that
 * is not a public URL, or a current report revision marked as containing
 * private material. An engine-1 run, which had no private sources, is not.
 */
export async function researchRunUsesPrivateSources(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const run = await prisma.researchPreviewRun.findUnique({
    where: { id: runId },
    select: { inputManifest: true, currentReportRevision: true },
  });
  if (!run) return false;
  const entries = (run.inputManifest as { entries?: unknown } | null)?.entries;
  if (Array.isArray(entries) && entries.some((entry) => (entry as { type?: unknown } | null)?.type !== "url")) return true;
  if (!run.currentReportRevision) return false;
  const revision = await prisma.researchReportRevision.findUnique({
    where: { runId_revision: { runId, revision: run.currentReportRevision } },
    select: { containsPrivate: true },
  });
  return revision?.containsPrivate === true;
}

type Prepared = {
  conversationId: string;
  messageId: string;
  artifactId: string | null;
  sourceKey: string;
  previewKind: CodePreviewKind;
  language: ArtifactShareLanguage;
  title: string | null;
  content: string;
};

export type PrepareOutcome =
  | { ok: true; prepared: Prepared }
  | { ok: false; code: ArtifactShareRefusalCode; status: number };

type Refusal = { code: ArtifactShareRefusalCode; status: number };

const OPEN_CONVERSATION = { isChatKind: true, temporary: false, locked: false, continuesImport: false };

/** The switches and the plan alone, decided before anything about a source is read. */
const gateRefusal = (gates: { sharingAvailable: boolean; planAllowsSharing: boolean }) =>
  artifactShareRefusal({ ...gates, sourceFound: true, conversation: OPEN_CONVERSATION, researchPrivate: false, contentBytes: 1 });

/** The size rule alone, for a file whose bytes are known only after every other rule passed. */
const sizeRefusal = (contentBytes: number) =>
  artifactShareRefusal({
    sharingAvailable: true,
    planAllowsSharing: true,
    sourceFound: true,
    conversation: OPEN_CONVERSATION,
    researchPrivate: false,
    contentBytes,
  });

/**
 * Every rule a link has to satisfy, for making it and for every read of it:
 * the same facts, gathered from the database the same way, decided by the one
 * function `artifactShareRefusal`. A rule added there applies to both at once.
 *
 * The facts read from the source's own rows (the conversation's kind, lock,
 * temporary state and continuation bridge, the size) are decided first; the
 * owner's plan and the answer's Research run cost reads of their own and are
 * fetched only when nothing cheaper has refused.
 */
async function shareRefusal(input: {
  sharingAvailable: boolean;
  /** Already read by the caller when making a link; read here from the owner when opening one. */
  planAllowsSharing?: boolean;
  ownerId: string;
  found: boolean;
  conversation: ConversationRow | null;
  researchRunId: string | null;
  contentBytes: number;
}): Promise<Refusal | null> {
  const conversation = input.found && input.conversation?.userId === input.ownerId ? input.conversation : null;
  const facts = {
    sharingAvailable: input.sharingAvailable,
    planAllowsSharing: input.planAllowsSharing ?? true,
    sourceFound: conversation !== null,
    conversation: conversation ? factsOf(conversation) : null,
    researchPrivate: false,
    contentBytes: input.contentBytes,
  };
  const early = artifactShareRefusal(facts);
  if (early) return early;
  const planAllowsSharing = input.planAllowsSharing ?? (await getUserBillingPlan(input.ownerId)).allowSharing;
  return artifactShareRefusal({
    ...facts,
    planAllowsSharing,
    researchPrivate: await researchRunUsesPrivateSources(input.researchRunId),
  });
}

/**
 * Reads the source the caller owns and decides whether it may be published.
 * `sharingAvailable` and `planAllowsSharing` are the caller's to read; every
 * other fact comes from the database here. A file's bytes are read only once
 * every other rule has passed.
 */
export async function prepareArtifactShare(
  userId: string,
  input: ArtifactShareSourceInput,
  gates: { sharingAvailable: boolean; planAllowsSharing: boolean }
): Promise<PrepareOutcome> {
  // The switches and the plan first, so a closed feature reads nothing else.
  const gated = gateRefusal(gates);
  if (gated) return { ok: false, ...gated };

  if (input.kind === "artifact") {
    const artifact = await prisma.messageArtifact.findFirst({
      // Ownership is part of the lookup, as in /api/artifacts/{id}.
      where: { id: input.artifactId, userId, status: "ready" },
      select: {
        id: true,
        messageId: true,
        conversationId: true,
        format: true,
        filename: true,
        byteSize: true,
        objectKey: true,
        conversation: { select: conversationFacts },
        message: { select: { researchRunId: true } },
      },
    });
    const usable = Boolean(artifact?.objectKey && ARTIFACT_SHARE_FILE_FORMATS.has(artifact.format.toLowerCase()));
    const before = await shareRefusal({
      ...gates,
      ownerId: userId,
      found: usable,
      conversation: artifact?.conversation ?? null,
      researchRunId: artifact?.message.researchRunId ?? null,
      contentBytes: artifact?.byteSize ?? 0,
    });
    if (before) return { ok: false, ...before };
    if (!artifact?.objectKey) return { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 };
    // The same non-destructive read as the download route, bounded by the preview's own limit -- not by the size
    // the row recorded. An object larger than the limit is refused as too large rather than cut short, and bytes
    // that are not whole UTF-8 are refused rather than published with replacement characters.
    let bytes: Buffer;
    try {
      bytes = await readOwnR2ObjectBytes(artifact.objectKey, { maxBytes: HTML_PREVIEW_MAX_BYTES });
    } catch (error) {
      const tooLarge = error instanceof BoundedBufferError ? sizeRefusal(HTML_PREVIEW_MAX_BYTES + 1) : null;
      if (tooLarge) return { ok: false, ...tooLarge };
      throw error;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 };
    }
    const after = sizeRefusal(bytes.byteLength);
    if (after) return { ok: false, ...after };
    const format = artifact.format.toLowerCase() as ArtifactShareLanguage;
    return {
      ok: true,
      prepared: {
        conversationId: artifact.conversationId,
        messageId: artifact.messageId,
        artifactId: artifact.id,
        sourceKey: artifactShareSourceKey({ kind: "artifact", artifactId: artifact.id }),
        previewKind: "html",
        language: format,
        title: artifact.filename,
        content,
      },
    };
  }

  const shareable = shareableCodeLanguage(input.language);
  const content = input.code.replace(/\r\n?/g, "\n");
  const message = shareable
    ? await prisma.message.findFirst({
        where: { id: input.messageId, role: "assistant", conversation: { userId } },
        select: { id: true, content: true, conversationId: true, researchRunId: true, conversation: { select: conversationFacts } },
      })
    : null;
  const outcome = await shareRefusal({
    ...gates,
    ownerId: userId,
    found: Boolean(shareable && message && answerContainsCode(message.content, content)),
    conversation: message?.conversation ?? null,
    researchRunId: message?.researchRunId ?? null,
    contentBytes: Buffer.byteLength(content, "utf8"),
  });
  if (outcome) return { ok: false, ...outcome };
  if (!message || !shareable) return { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 };
  return {
    ok: true,
    prepared: {
      conversationId: message.conversationId,
      messageId: message.id,
      artifactId: null,
      sourceKey: artifactShareSourceKey({ kind: "code_block", messageId: message.id, contentHash: sha256Hex(content) }),
      previewKind: shareable.previewKind,
      language: shareable.language,
      title: null,
      content,
    },
  };
}

const viewOf = (row: { id: string; token: string; createdAt: Date; expiresAt: Date }): ArtifactShareView => ({
  id: row.id,
  token: row.token,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

/**
 * The one way a link is removed: its owner stops sharing it, or it has
 * expired. The row and the page it held go together, and every removal is
 * recorded the same way, under `artifact.share.revoke` with its reason.
 */
async function removeArtifactShares(
  condition: Prisma.Sql,
  record: { reason: "OWNER_STOPPED" | "EXPIRED"; request?: Request }
): Promise<number> {
  const removed = await prisma.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
    DELETE FROM "ArtifactShare" WHERE ${condition} RETURNING "id", "userId"
  `);
  for (const row of removed) {
    logSecurityAuditEvent("artifact.share.revoke", {
      userId: row.userId,
      resourceId: row.id,
      request: record.request,
      outcome: "success",
      reason: record.reason,
    });
  }
  return removed.length;
}

const expiredAt = (now: Date) => Prisma.sql`"expiresAt" <= ${now.toISOString()}::timestamp(3)`;

/** Removes the caller's expired link for a source, if it has one. */
const removeExpiredForSource = (userId: string, sourceKey: string, now: Date) =>
  removeArtifactShares(Prisma.sql`"sourceKey" = ${sourceKey} AND "userId" = ${userId} AND ${expiredAt(now)}`, { reason: "EXPIRED" });

/**
 * Publishes the prepared page, or answers the live link this source already
 * has. An expired link for the same source is removed first, the way stopping
 * a share removes one, so a source never has two rows.
 *
 * The conversation facts the decision read from its row -- lock, temporary
 * state, kind and continuation bridge -- are checked again in the statement
 * that writes: a conversation that changed between the read above and this
 * write leaves nothing published. (The owner's plan and the Research run are
 * not conversation facts; every public read decides them again.)
 */
export async function publishArtifactShare(
  userId: string,
  prepared: Prepared,
  now: Date = new Date()
): Promise<{ share: ArtifactShareView; created: boolean } | null> {
  try {
    return await publishOnce(userId, prepared, now);
  } catch (error) {
    // Two presses at once: the second insert meets the first's unique source key. Its link is the answer.
    const existing = await findArtifactShare(userId, prepared.sourceKey, now);
    if (existing) return { share: existing, created: false };
    throw error;
  }
}

async function publishOnce(userId: string, prepared: Prepared, now: Date) {
  const expiresAt = new Date(now.getTime() + artifactShareTtlDays(process.env) * 24 * 60 * 60 * 1000);
  await removeExpiredForSource(userId, prepared.sourceKey, now);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.artifactShare.findUnique({
      where: { sourceKey: prepared.sourceKey },
      select: { id: true, token: true, userId: true, createdAt: true, expiresAt: true },
    });
    // A source key names ids only one account holds; a row of anyone else's is never touched.
    if (existing && existing.userId !== userId) return null;
    // Live, because every row of this source expired by `now` was removed above.
    if (existing) return existing.expiresAt > now ? { share: viewOf(existing), created: false } : null;
    const token = createShareToken();
    const inserted = await tx.$queryRaw<Array<{ id: string; token: string; createdAt: Date; expiresAt: Date }>>(Prisma.sql`
      INSERT INTO "ArtifactShare" ("id", "token", "userId", "conversationId", "messageId", "artifactId", "sourceKey",
        "sourceKind", "previewKind", "language", "title", "content", "createdAt", "expiresAt")
      SELECT ${randomUUID()}, ${token}, ${userId}, conversation."id", ${prepared.messageId},
        ${prepared.artifactId}, ${prepared.sourceKey}, ${prepared.artifactId ? "artifact" : "code_block"},
        ${prepared.previewKind}, ${prepared.language}, ${prepared.title}, ${prepared.content},
        ${now.toISOString()}::timestamp(3), ${expiresAt.toISOString()}::timestamp(3)
      FROM "Conversation" conversation
      WHERE conversation."id" = ${prepared.conversationId}
        AND conversation."userId" = ${userId}
        AND conversation."password" IS NULL
        AND conversation."temporaryExpiresAt" IS NULL
        -- isChatConversationKind (lib/conversationKindGuard.ts): no kind, or "chat".
        AND COALESCE(conversation."kind", '') IN ('chat', '')
        AND NOT EXISTS (
          SELECT 1 FROM "ConversationContinuationBridge" bridge WHERE bridge."conversationId" = conversation."id"
        )
      RETURNING "id", "token", "createdAt", "expiresAt"
    `);
    const row = inserted[0];
    return row ? { share: viewOf(row), created: true } : null;
  });
}

/**
 * The caller's live link for a source, or null. An expired one is removed
 * here: the owner's panel does not show it, so nothing else would let them
 * take it away.
 */
export async function findArtifactShare(userId: string, sourceKey: string, now: Date = new Date()) {
  await removeExpiredForSource(userId, sourceKey, now);
  const row = await prisma.artifactShare.findFirst({
    where: { sourceKey, userId, expiresAt: { gt: now } },
    select: { id: true, token: true, createdAt: true, expiresAt: true },
  });
  return row ? viewOf(row) : null;
}

/** Removes the caller's link. Nothing else can: the id is matched with its owner. */
export async function revokeArtifactShare(userId: string, shareId: string, request?: Request) {
  const removed = await removeArtifactShares(Prisma.sql`"id" = ${shareId} AND "userId" = ${userId}`, {
    reason: "OWNER_STOPPED",
    request,
  });
  return removed > 0;
}

const EXPIRED_SWEEP_BATCH = 500;
const EXPIRED_SWEEP_MAX_BATCHES = 20;

/**
 * The maintenance sweep's part: every link past its expiry, removed the way
 * stopping one is, in bounded batches so one run cannot hold the table.
 */
export async function deleteExpiredArtifactShares(now: Date = new Date()): Promise<{ count: number }> {
  let count = 0;
  for (let batch = 0; batch < EXPIRED_SWEEP_MAX_BATCHES; batch += 1) {
    const removed = await removeArtifactShares(
      Prisma.sql`"id" IN (SELECT "id" FROM "ArtifactShare" WHERE ${expiredAt(now)} ORDER BY "expiresAt" LIMIT ${EXPIRED_SWEEP_BATCH})`,
      { reason: "EXPIRED" }
    );
    count += removed;
    if (removed < EXPIRED_SWEEP_BATCH) break;
  }
  return { count };
}

/**
 * What the public page shows for a token: a link that has not expired and
 * that would still be allowed to be made now. Every rule of making a link is
 * decided again, by the same `shareRefusal`, from the rows the link points
 * at -- its conversation (kind, lock, temporary, continuation bridge), its
 * answer's Research run and its owner's plan -- plus the switches the caller
 * passes in. A link whose source stopped qualifying is closed, not deleted,
 * as a lock closes one: it opens again if the source qualifies again before
 * it expires. An expired link is deleted when it is met here.
 *
 * Reads no session and no cookie: it takes the token and follows the
 * database from the link's own row.
 */
export async function readPublicArtifactShare(
  token: string,
  gates: { sharingAvailable: boolean },
  now: Date = new Date()
): Promise<PublicArtifactShare | null> {
  // The switch first, so a closed feature reads no link at all.
  if (!isStrongShareToken(token) || gateRefusal({ sharingAvailable: gates.sharingAvailable, planAllowsSharing: true })) return null;
  const row = await prisma.artifactShare.findFirst({
    where: { token },
    select: {
      id: true,
      userId: true,
      previewKind: true,
      language: true,
      title: true,
      content: true,
      expiresAt: true,
      conversation: { select: conversationFacts },
      message: { select: { researchRunId: true } },
    },
  });
  if (!row) return null;
  if (row.expiresAt <= now) {
    // Expired: not shown, and removed now, the way stopping a share removes one.
    await removeArtifactShares(Prisma.sql`"id" = ${row.id} AND ${expiredAt(now)}`, { reason: "EXPIRED" });
    return null;
  }
  const refusal = await shareRefusal({
    sharingAvailable: gates.sharingAvailable,
    ownerId: row.userId,
    found: true,
    conversation: row.conversation,
    researchRunId: row.message.researchRunId,
    contentBytes: Buffer.byteLength(row.content, "utf8"),
  });
  if (refusal) return null;
  const shareable = shareableCodeLanguage(row.language);
  if (!shareable || shareable.previewKind !== row.previewKind || Buffer.byteLength(row.content, "utf8") > HTML_PREVIEW_MAX_BYTES) {
    return null;
  }
  return { previewKind: shareable.previewKind, language: shareable.language, title: row.title, content: row.content, expiresAt: row.expiresAt };
}
