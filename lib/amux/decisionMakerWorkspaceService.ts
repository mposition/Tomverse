import "server-only";

import type { Prisma } from "@prisma/client";

import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import { readDecisionMakerRequestCardId } from "@/lib/amux/decisionMakerRequestStore";
import {
  amuxDmWorkspaceEnabled,
  dmWorkspaceAcceptFiles,
  type DmWorkspaceEvidenceName,
  type DmWorkspaceExclusion,
  type DmWorkspaceFile,
} from "@/lib/amux/decisionMakerWorkspaceCore";
import { readAmuxDmOwnerSettlementPullEvidence } from "@/lib/amux/dmOwnerSettlementRead";
import { parseAmuxV22Conclusion } from "@/lib/amux/v22ConclusionCore";
import { openCompletionCriteria } from "@/lib/amux/v22ResultReviewService";
import { openAmuxV22TaskResultRow, v22TaskResultIdeaId } from "@/lib/amux/v22TaskResultStore";
import { isSnapshotTargetSha } from "@/lib/amux/decisionMakerCore";

/**
 * The evidence of a Decision Maker request's workspace
 * (lib/amux/decisionMakerWorkspaceCore.ts), read when the bridge is about to
 * send the request, not stored anywhere new: the card the request was routed
 * for names, by its local card id, the one source row the app filed it from,
 * and the evidence is read again from that row -- whole.
 *
 *   T2 draft (EngineeringAgentDmReview)       PATCH.diff; the commit the draft was made on
 *   owner settlement (AmuxDmOwnerSettlement)  CRITERIA.md, FINDINGS.md, a review PR's PATCH.diff
 *   result review (AmuxV22ResultReview)       CRITERIA.md, FINDINGS.md
 *   anything else (a worker's own typed ask)   no evidence; develop's public head
 *
 * Every file passes the workspace's checks (`dmWorkspaceAcceptFiles`: closed
 * names, text, the secret path list and the secret scan) here and again in the
 * broker. Nothing is logged but counts.
 */

export type DmWorkspaceEvidence = {
  /** The commit the evidence belongs to, or null for develop's public head. */
  targetSha: string | null;
  files: DmWorkspaceFile[];
  excluded: Partial<Record<DmWorkspaceExclusion, number>>;
};

type SealedResult = {
  attemptId: string | null; resultIdeaId: string | null; ciphertext: Uint8Array | null; keyId: string | null;
  keyVersion: number | null; digest: string | null; digestKeyId: string | null; sourceSha256: string | null;
  bodyPurgedAt: Date | null;
};
type SealedBody = {
  taskId: string; sourceSnapshot: Prisma.JsonValue; bodyCiphertext: Uint8Array | null; bodyKeyId: string | null;
  bodyKeyVersion: number | null; bodyDigest: string | null; bodyDigestKeyId: string | null;
};

export type DmWorkspaceSource =
  | { kind: "none" }
  | { kind: "t2_draft"; patchBody: string | null; baseSha: string | null }
  | ({ kind: "settlement"; settlementKind: string; pullPatch: string | null } & SealedBody & SealedResult)
  | ({ kind: "result_review" } & SealedBody & SealedResult);

/**
 * The request's card and the one row it was filed from. Null for a request
 * that does not exist. At most four statements past the boundary's own.
 */
export async function readDecisionMakerWorkspaceSource(tx: Prisma.TransactionClient, requestId: string):
  Promise<DmWorkspaceSource | null> {
  if (!isDmRequestId(requestId)) return null;
  const cardId = await readDecisionMakerRequestCardId(tx, requestId);
  if (cardId === null) return null;
  const request = { cardId };
  const rows = await tx.$queryRaw<Array<{
    source: "t2_draft" | "settlement" | "result_review"; patchBody: string | null; baseSha: string | null;
    settlementKind: string | null; bindingId: string | null;
  } & Partial<SealedBody> & Partial<SealedResult>>>`
    SELECT 't2_draft' AS "source", w."patchBody", w."baseSha", NULL::text AS "settlementKind",
      NULL::text AS "bindingId", NULL::text AS "taskId", NULL::jsonb AS "sourceSnapshot",
      NULL::bytea AS "bodyCiphertext", NULL::text AS "bodyKeyId", NULL::int AS "bodyKeyVersion",
      NULL::text AS "bodyDigest", NULL::text AS "bodyDigestKeyId", NULL::text AS "attemptId",
      NULL::text AS "resultIdeaId", NULL::bytea AS "ciphertext", NULL::text AS "keyId", NULL::int AS "keyVersion",
      NULL::text AS "digest", NULL::text AS "digestKeyId", NULL::text AS "sourceSha256",
      NULL::timestamp AS "bodyPurgedAt"
    FROM "EngineeringAgentDmReview" d JOIN "EngineeringAgentWorkItem" w ON w."id" = d."workItemId"
    WHERE d."localCardId" = ${request.cardId}
    UNION ALL
    SELECT 'settlement', NULL, NULL, s."kind", s."bindingId", w."id", w."sourceSnapshot",
      w."v4BodyCiphertext", w."v4BodyKeyId", w."v4BodyKeyVersion", w."v4BodyDigest", w."v4BodyDigestKeyId",
      s."attemptId", r."ideaId", r."ciphertext", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxDmOwnerSettlement" s JOIN "AmuxWorkItem" w ON w."id" = s."taskId"
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = s."attemptId" AND r."taskId" = s."taskId"
    WHERE s."localCardId" = ${request.cardId}
    UNION ALL
    SELECT 'result_review', NULL, NULL, NULL, NULL, w."id", w."sourceSnapshot",
      w."v4BodyCiphertext", w."v4BodyKeyId", w."v4BodyKeyVersion", w."v4BodyDigest", w."v4BodyDigestKeyId",
      v."attemptId", r."ideaId", r."ciphertext", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxV22ResultReview" v JOIN "AmuxWorkItem" w ON w."id" = v."taskId"
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = v."attemptId" AND r."taskId" = v."taskId"
    WHERE v."localCardId" = ${request.cardId}
    LIMIT 2`;
  // A card is one source's; two would mean the card ids were reused.
  if (rows.length !== 1) return { kind: "none" };
  const row = rows[0]!;
  if (row.source === "t2_draft") return { kind: "t2_draft", patchBody: row.patchBody, baseSha: row.baseSha };
  const sealed = {
    taskId: row.taskId!, sourceSnapshot: row.sourceSnapshot ?? null, bodyCiphertext: row.bodyCiphertext ?? null,
    bodyKeyId: row.bodyKeyId ?? null, bodyKeyVersion: row.bodyKeyVersion ?? null, bodyDigest: row.bodyDigest ?? null,
    bodyDigestKeyId: row.bodyDigestKeyId ?? null, attemptId: row.attemptId ?? null,
    resultIdeaId: row.resultIdeaId ?? null, ciphertext: row.ciphertext ?? null, keyId: row.keyId ?? null,
    keyVersion: row.keyVersion ?? null, digest: row.digest ?? null, digestKeyId: row.digestKeyId ?? null,
    sourceSha256: row.sourceSha256 ?? null, bodyPurgedAt: row.bodyPurgedAt ?? null,
  };
  if (row.source === "result_review") return { kind: "result_review", ...sealed };
  const pulls = row.settlementKind === "t2_pr" && row.bindingId ?
    await readAmuxDmOwnerSettlementPullEvidence(tx, [row.bindingId]) : [];
  return { kind: "settlement", settlementKind: row.settlementKind ?? "", pullPatch: pulls[0]?.patchBody ?? null, ...sealed };
}

/** The run's findings (its conclusion's, else the whole result), or null when it left none or it cannot be opened. */
const openFindings = async (row: SealedResult) => {
  if (!row.attemptId || !row.resultIdeaId || !row.digest || !row.digestKeyId || !row.sourceSha256) return null;
  const text = await openAmuxV22TaskResultRow(row.attemptId, { ideaId: row.resultIdeaId, ciphertext: row.ciphertext,
    keyId: row.keyId, keyVersion: row.keyVersion, digest: row.digest, digestKeyId: row.digestKeyId,
    bodyPurgedAt: row.bodyPurgedAt, sourceSha256: row.sourceSha256 }).catch(() => null);
  return text === null ? null : parseAmuxV22Conclusion(text)?.findings ?? text;
};

const openCriteria = async (row: SealedBody & SealedResult) => {
  const ideaId = row.resultIdeaId ?? v22TaskResultIdeaId(row.sourceSnapshot);
  if (!ideaId) return null;
  return openCompletionCriteria({ ideaId, taskId: row.taskId, bodyCiphertext: row.bodyCiphertext,
    bodyKeyId: row.bodyKeyId, bodyKeyVersion: row.bodyKeyVersion, bodyDigest: row.bodyDigest,
    bodyDigestKeyId: row.bodyDigestKeyId }).catch(() => null);
};

/**
 * The workspace evidence, opened outside the read transaction. Null while the
 * workspace is switched off (TOMVERSE_AMUX_DM_WORKSPACE=disabled): the card
 * goes alone. Evidence that cannot be opened is left out; the checkout still
 * goes.
 */
export async function openDecisionMakerWorkspaceEvidence(source: DmWorkspaceSource): Promise<DmWorkspaceEvidence | null> {
  if (!amuxDmWorkspaceEnabled()) return null;
  // `required`: the card points at this file, so one that cannot be read is
  // counted as left out (`unreadable`), and the bridge then sends nothing --
  // a DM never judges a card without the evidence it names.
  const files: Array<{ name: DmWorkspaceEvidenceName; text: string | null; required: boolean }> = [];
  let targetSha: string | null = null;
  if (source.kind === "t2_draft") {
    files.push({ name: "PATCH.diff", text: source.patchBody, required: true });
    targetSha = source.baseSha && isSnapshotTargetSha(source.baseSha) ? source.baseSha : null;
  } else if (source.kind === "settlement" || source.kind === "result_review") {
    const criteria = await openCriteria(source);
    files.push({ name: "CRITERIA.md", text: criteria ? criteria.map((criterion) => `- ${criterion}`).join("\n") : null,
      required: true });
    // A settlement whose Task never ran has no result row; one whose row exists must open.
    files.push({ name: "FINDINGS.md", text: await openFindings(source),
      required: source.kind === "result_review" || source.resultIdeaId !== null });
    if (source.kind === "settlement") {
      files.push({ name: "PATCH.diff", text: source.pullPatch, required: source.settlementKind === "t2_pr" });
    }
  }
  const accepted = dmWorkspaceAcceptFiles(files.flatMap((file) =>
    file.text ? [{ name: file.name, bytes: Buffer.from(file.text, "utf8") }] : []));
  const unreadable = files.filter((file) => file.required && !file.text).length;
  return { targetSha, files: accepted.files,
    excluded: unreadable > 0 ? { ...accepted.excluded, unreadable } : accepted.excluded };
}
