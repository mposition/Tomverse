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
import type { CodePreviewKind } from "@/lib/chatArtifactPreview";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { HTML_PREVIEW_MAX_BYTES } from "@/lib/htmlArtifactPreview";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";
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
  const refuse = (facts: Parameters<typeof artifactShareRefusal>[0]): PrepareOutcome | null => {
    const refusal = artifactShareRefusal(facts);
    return refusal ? { ok: false, ...refusal } : null;
  };
  // The switches and the plan first, so a closed feature reads nothing else.
  const gated = refuse({
    ...gates,
    sourceFound: true,
    conversation: { isChatKind: true, temporary: false, locked: false, continuesImport: false },
    researchPrivate: false,
    contentBytes: 1,
  });
  if (gated) return gated;

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
    const usable =
      artifact?.objectKey &&
      ARTIFACT_SHARE_FILE_FORMATS.has(artifact.format.toLowerCase()) &&
      artifact.conversation.userId === userId;
    const base = {
      ...gates,
      sourceFound: Boolean(usable),
      conversation: usable && artifact ? factsOf(artifact.conversation) : null,
      researchPrivate: usable && artifact ? await researchRunUsesPrivateSources(artifact.message.researchRunId) : false,
    };
    const before = refuse({ ...base, contentBytes: artifact?.byteSize ?? 0 });
    if (before || !artifact?.objectKey) return before ?? { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 };
    // The same non-destructive read as the download route, bounded by the preview's own limit.
    const bytes = await readOwnR2ObjectBytes(artifact.objectKey, {
      maxBytes: Math.max(1, Math.min(artifact.byteSize, HTML_PREVIEW_MAX_BYTES)),
    });
    const content = new TextDecoder("utf-8").decode(bytes);
    const after = refuse({ ...base, contentBytes: Buffer.byteLength(content, "utf8") });
    if (after) return after;
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
  const found = Boolean(shareable && message && answerContainsCode(message.content, content));
  const outcome = refuse({
    ...gates,
    sourceFound: found,
    conversation: found && message ? factsOf(message.conversation) : null,
    researchPrivate: found && message ? await researchRunUsesPrivateSources(message.researchRunId) : false,
    contentBytes: Buffer.byteLength(content, "utf8"),
  });
  if (outcome || !message || !shareable) return outcome ?? { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 };
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
 * Publishes the prepared page, or answers the live link this source already
 * has. An expired link for the same source is replaced in the same
 * transaction, so a source never has two rows.
 *
 * The conversation's lock and temporary state are checked again in the
 * statement that writes: a lock set between the read above and this write
 * leaves nothing published.
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
  return prisma.$transaction(async (tx) => {
    const existing = await tx.artifactShare.findUnique({
      where: { sourceKey: prepared.sourceKey },
      select: { id: true, token: true, userId: true, createdAt: true, expiresAt: true },
    });
    // A source key names ids only one account holds; a row of anyone else's is never touched.
    if (existing && existing.userId !== userId) return null;
    if (existing && existing.expiresAt > now) return { share: viewOf(existing), created: false };
    if (existing) await tx.artifactShare.delete({ where: { id: existing.id } });
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
      RETURNING "id", "token", "createdAt", "expiresAt"
    `);
    const row = inserted[0];
    return row ? { share: viewOf(row), created: true } : null;
  });
}

/** The caller's live link for a source, or null. */
export async function findArtifactShare(userId: string, sourceKey: string, now: Date = new Date()) {
  const row = await prisma.artifactShare.findFirst({
    where: { sourceKey, userId, expiresAt: { gt: now } },
    select: { id: true, token: true, createdAt: true, expiresAt: true },
  });
  return row ? viewOf(row) : null;
}

/** Removes the caller's link. Nothing else can: the id is matched with its owner. */
export async function revokeArtifactShare(userId: string, shareId: string) {
  const removed = await prisma.artifactShare.deleteMany({ where: { id: shareId, userId } });
  return removed.count > 0;
}

/**
 * What the public page shows for a token: a link that has not expired, whose
 * conversation is still not locked and not temporary. Reads no session and no
 * cookie -- it takes nothing but the token.
 */
export async function readPublicArtifactShare(token: string, now: Date = new Date()): Promise<PublicArtifactShare | null> {
  if (!isStrongShareToken(token)) return null;
  const row = await prisma.artifactShare.findFirst({
    where: { token, expiresAt: { gt: now }, conversation: { password: null, temporaryExpiresAt: null } },
    select: { previewKind: true, language: true, title: true, content: true, expiresAt: true },
  });
  if (!row) return null;
  const shareable = shareableCodeLanguage(row.language);
  if (!shareable || shareable.previewKind !== row.previewKind || Buffer.byteLength(row.content, "utf8") > HTML_PREVIEW_MAX_BYTES) {
    return null;
  }
  return { previewKind: shareable.previewKind, language: shareable.language, title: row.title, content: row.content, expiresAt: row.expiresAt };
}
