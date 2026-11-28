import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import { readDecisionMakerRequestCardId } from "@/lib/amux/decisionMakerRequestStore";
import {
  DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES,
  dmDependencyResultsText,
  dmWorkspaceAcceptFiles,
  dmWorkspacePartOf,
  isDmWorkspaceEvidenceName,
  type DmWorkspaceEvidenceName,
  type DmWorkspaceExclusion,
  type DmWorkspaceFile,
} from "@/lib/amux/decisionMakerWorkspaceCore";
import { amuxV22TransferChunkCount, amuxV22TransferChunkRange } from "@/lib/amux/v22TransferCore";
import { amuxDmOwnerSettlementFindingsText } from "@/lib/amux/dmOwnerSettlementCore";
import { readAmuxDmOwnerSettlementPullEvidence } from "@/lib/amux/dmOwnerSettlementRead";
import { parseAmuxV22Conclusion } from "@/lib/amux/v22ConclusionCore";
import { parseAmuxV22OwnerQuestion } from "@/lib/amux/v22OwnerQuestionCore";
import { openCompletionCriteria } from "@/lib/amux/v22ResultReviewService";
import { openAmuxV22TaskPatchRow, openAmuxV22TaskResultRow, v22TaskResultIdeaId } from "@/lib/amux/v22TaskResultStore";
import {
  openAmuxV52RejectedReviewEntries,
  readAmuxV52RejectedReviews,
  type AmuxV52ReviewHistoryRow,
} from "@/lib/amux/v52ReviewFindingsStore";
import { isSnapshotTargetSha } from "@/lib/amux/decisionMakerCore";
import { readAmuxCardTitle } from "@/lib/amux/adminExecutionRead";

/**
 * The evidence of a Decision Maker request's workspace
 * (lib/amux/decisionMakerWorkspaceCore.ts), read when the bridge is about to
 * send the request, not stored anywhere new: the card the request was routed
 * for names, by its local card id, the one source row the app filed it from,
 * and the evidence is read again from that row -- whole.
 *
 *   T2 draft (EngineeringAgentDmReview)       PATCH.diff; the commit the draft was made on
 *   owner settlement (AmuxDmOwnerSettlement)  CRITERIA.md, FINDINGS.md (the run's report, then
 *                                             every rejected review's findings), a review PR's PATCH.diff,
 *                                             else the run's own change as PATCH.diff on its base commit
 *   result review (AmuxV22ResultReview)       CRITERIA.md, FINDINGS.md, the run's change as PATCH.diff
 *                                             on its base commit
 *   (both, when the Task depends on cards)    CONTEXT.md: those cards, each with its newest run result, whole
 *
 * The cards a Task depends on (2026-11-28): a criterion that names another
 * card's output could not be checked without it ("The AMUX-PUBLIC-002 audit
 * list is absent"), so the Decision Maker handed the Task to a person.
 *
 * The run's change (2026-11-22): a settlement of a card run sent the DM the
 * rejections that named the change but not the change itself, so the DM could
 * not check one finding ("This workspace lacks the proposed diff").
 *   v22 question (AmuxV22TaskQuestion)        CONTEXT.md: what the worker found, whole; develop's public head
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
  attemptId: string | null; resultIdeaId: string | null; keyId: string | null;
  keyVersion: number | null; digest: string | null; digestKeyId: string | null; sourceSha256: string | null;
  bodyPurgedAt: Date | null;
};
type SealedBody = {
  taskId: string; sourceSnapshot: Prisma.JsonValue; bodyCiphertext: Uint8Array | null; bodyKeyId: string | null;
  bodyKeyVersion: number | null; bodyDigest: string | null; bodyDigestKeyId: string | null;
};

/** The run's captured change (AmuxV22TaskPatch), sealed; opened outside the read. */
type SealedRunPatch = {
  ideaId: string; keyId: string | null; keyVersion: number | null; digest: string; digestKeyId: string;
  bodyPurgedAt: Date | null; patchSha256: string; baseSha: string;
};

/** A card the Task depends on, its title and its newest run result sealed; opened outside the read. */
type SealedDependency = SealedResult & {
  id: string; label: string; status: string; cardTitle: string; sourceSystem: string | null;
  sourceSnapshot: Prisma.JsonValue; v4TitleCiphertext: Uint8Array | null; v4TitleKeyId: string | null;
  v4TitleKeyVersion: number | null; v4TitleDigest: string | null; v4TitleDigestKeyId: string | null;
};

export type DmWorkspaceSource =
  | { kind: "none" }
  | { kind: "t2_draft"; patchBody: string | null; baseSha: string | null }
  | ({ kind: "settlement"; settlementKind: string; pullPatch: string | null;
      reviews: AmuxV52ReviewHistoryRow[]; runPatch?: SealedRunPatch | null;
      dependencies?: SealedDependency[] } & SealedBody & SealedResult)
  | ({ kind: "result_review"; runPatch?: SealedRunPatch | null;
      dependencies?: SealedDependency[] } & SealedBody & SealedResult)
  | ({ kind: "v22_question" } & SealedResult);

/**
 * The request's card and the one row it was filed from. Null for a request
 * that does not exist. At most five statements past the boundary's own: the
 * card id, the source row, then for a settlement its pull request's patch (a
 * review PR) or its run's change (any other), its Task's rejected reviews and
 * the cards it depends on; for a result review, its run's change and the
 * cards it depends on.
 */
export async function readDecisionMakerWorkspaceSource(tx: Prisma.TransactionClient, requestId: string):
  Promise<DmWorkspaceSource | null> {
  if (!isDmRequestId(requestId)) return null;
  const cardId = await readDecisionMakerRequestCardId(tx, requestId);
  if (cardId === null) return null;
  const request = { cardId };
  const rows = await tx.$queryRaw<Array<{
    source: "t2_draft" | "settlement" | "result_review" | "v22_question"; patchBody: string | null; baseSha: string | null;
    settlementKind: string | null; bindingId: string | null;
  } & Partial<SealedBody> & Partial<SealedResult>>>`
    SELECT 't2_draft' AS "source", w."patchBody", w."baseSha", NULL::text AS "settlementKind",
      NULL::text AS "bindingId", NULL::text AS "taskId", NULL::jsonb AS "sourceSnapshot",
      NULL::bytea AS "bodyCiphertext", NULL::text AS "bodyKeyId", NULL::int AS "bodyKeyVersion",
      NULL::text AS "bodyDigest", NULL::text AS "bodyDigestKeyId", NULL::text AS "attemptId",
      NULL::text AS "resultIdeaId", NULL::text AS "keyId", NULL::int AS "keyVersion",
      NULL::text AS "digest", NULL::text AS "digestKeyId", NULL::text AS "sourceSha256",
      NULL::timestamp AS "bodyPurgedAt"
    FROM "EngineeringAgentDmReview" d JOIN "EngineeringAgentWorkItem" w ON w."id" = d."workItemId"
    WHERE d."localCardId" = ${request.cardId}
    UNION ALL
    SELECT 'settlement', NULL, NULL, s."kind", s."bindingId", w."id", w."sourceSnapshot",
      w."v4BodyCiphertext", w."v4BodyKeyId", w."v4BodyKeyVersion", w."v4BodyDigest", w."v4BodyDigestKeyId",
      s."attemptId", r."ideaId", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxDmOwnerSettlement" s JOIN "AmuxWorkItem" w ON w."id" = s."taskId"
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = s."attemptId" AND r."taskId" = s."taskId"
    WHERE s."localCardId" = ${request.cardId}
    UNION ALL
    SELECT 'result_review', NULL, NULL, NULL, NULL, w."id", w."sourceSnapshot",
      w."v4BodyCiphertext", w."v4BodyKeyId", w."v4BodyKeyVersion", w."v4BodyDigest", w."v4BodyDigestKeyId",
      v."attemptId", r."ideaId", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxV22ResultReview" v JOIN "AmuxWorkItem" w ON w."id" = v."taskId"
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = v."attemptId" AND r."taskId" = v."taskId"
    WHERE v."localCardId" = ${request.cardId}
    UNION ALL
    SELECT 'v22_question', NULL, NULL, NULL, NULL, q."taskId", NULL, NULL, NULL, NULL, NULL, NULL,
      q."attemptId", r."ideaId", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxV22TaskQuestion" q
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = q."attemptId" AND r."taskId" = q."taskId"
    WHERE q."localCardId" = ${request.cardId}
    LIMIT 2`;
  // A card is one source's; two would mean the card ids were reused.
  if (rows.length !== 1) return { kind: "none" };
  const row = rows[0]!;
  if (row.source === "t2_draft") return { kind: "t2_draft", patchBody: row.patchBody, baseSha: row.baseSha };
  const sealed = {
    taskId: row.taskId!, sourceSnapshot: row.sourceSnapshot ?? null, bodyCiphertext: row.bodyCiphertext ?? null,
    bodyKeyId: row.bodyKeyId ?? null, bodyKeyVersion: row.bodyKeyVersion ?? null, bodyDigest: row.bodyDigest ?? null,
    bodyDigestKeyId: row.bodyDigestKeyId ?? null, attemptId: row.attemptId ?? null,
    resultIdeaId: row.resultIdeaId ?? null, keyId: row.keyId ?? null,
    keyVersion: row.keyVersion ?? null, digest: row.digest ?? null, digestKeyId: row.digestKeyId ?? null,
    sourceSha256: row.sourceSha256 ?? null, bodyPurgedAt: row.bodyPurgedAt ?? null,
  };
  if (row.source === "result_review") {
    const runPatch = await readRunPatch(tx, sealed.attemptId, sealed.taskId);
    return { kind: "result_review", runPatch, dependencies: await readDependencies(tx, sealed.taskId), ...sealed };
  }
  if (row.source === "v22_question") {
    const { attemptId, resultIdeaId, keyId, keyVersion, digest, digestKeyId, sourceSha256, bodyPurgedAt } = sealed;
    return { kind: "v22_question", attemptId, resultIdeaId, keyId, keyVersion, digest, digestKeyId,
      sourceSha256, bodyPurgedAt };
  }
  const pulls = row.settlementKind === "t2_pr" && row.bindingId ?
    await readAmuxDmOwnerSettlementPullEvidence(tx, [row.bindingId]) : [];
  // Not a review PR: the run's own change, the change its rejections are about.
  const runPatch = row.settlementKind === "t2_pr" ? null : await readRunPatch(tx, sealed.attemptId, sealed.taskId);
  // The card says its rejections' findings are in FINDINGS.md: read every one, as the card's sync did.
  const reviews = await readAmuxV52RejectedReviews(tx, [sealed.taskId]);
  const dependencies = await readDependencies(tx, sealed.taskId);
  return { kind: "settlement", settlementKind: row.settlementKind ?? "", pullPatch: pulls[0]?.patchBody ?? null,
    runPatch, reviews, dependencies, ...sealed };
}

/**
 * The cards a Task depends on, in one statement: each one's label, status,
 * sealed title and newest run result row (by when it was recorded), sealed.
 * A card that never ran has no result row.
 */
async function readDependencies(tx: Prisma.TransactionClient, taskId: string): Promise<SealedDependency[]> {
  return tx.$queryRaw<SealedDependency[]>`
    SELECT o."id", coalesce(o."displayKey", o."id") AS "label", o."status", o."title" AS "cardTitle",
      o."sourceSystem", o."sourceSnapshot", o."v4TitleCiphertext", o."v4TitleKeyId", o."v4TitleKeyVersion",
      o."v4TitleDigest", o."v4TitleDigestKeyId",
      r."attemptId", r."ideaId" AS "resultIdeaId", r."keyId", r."keyVersion", r."digest", r."digestKeyId",
      r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxWorkDependency" d JOIN "AmuxWorkItem" o ON o."id" = d."dependencyId"
    LEFT JOIN LATERAL (
      SELECT x."attemptId", x."ideaId", x."keyId", x."keyVersion", x."digest", x."digestKeyId",
        x."sourceSha256", x."bodyPurgedAt"
      FROM "AmuxV22TaskResult" x WHERE x."taskId" = o."id"
      ORDER BY x."createdAt" DESC, x."attemptId" DESC LIMIT 1
    ) r ON true
    WHERE d."taskId" = ${taskId}
    ORDER BY coalesce(o."displayKey", o."id"), o."id"`;
}

/** The cards a Task depends on as CONTEXT.md, or null with none. A title or result that cannot be opened is shown as such. */
async function openDependencyResults(dependencies: readonly SealedDependency[]): Promise<string | null> {
  const opened = await Promise.all(dependencies.map(async (card) => ({
    label: card.label, status: card.status,
    title: await readAmuxCardTitle({ id: card.id, title: card.cardTitle, sourceSystem: card.sourceSystem ?? "",
      sourceSnapshot: card.sourceSnapshot, v4TitleCiphertext: card.v4TitleCiphertext as never,
      v4TitleKeyId: card.v4TitleKeyId, v4TitleKeyVersion: card.v4TitleKeyVersion,
      v4TitleDigest: card.v4TitleDigest, v4TitleDigestKeyId: card.v4TitleDigestKeyId }).catch(() => null),
    result: await openResultText(card),
  })));
  return dmDependencyResultsText(opened);
}

/** The run's captured change, sealed (no body: it is read in slices when opened), or null when it left none. */
async function readRunPatch(tx: Prisma.TransactionClient, attemptId: string | null, taskId: string):
  Promise<SealedRunPatch | null> {
  if (!attemptId) return null;
  const patch = await tx.amuxV22TaskPatch.findUnique({ where: { attemptId }, select: { taskId: true, ideaId: true,
    keyId: true, keyVersion: true, digest: true, digestKeyId: true, bodyPurgedAt: true, patchSha256: true,
    baseSha: true } });
  if (!patch || patch.taskId !== taskId) return null;
  return { ideaId: patch.ideaId, keyId: patch.keyId, keyVersion: patch.keyVersion, digest: patch.digest,
    digestKeyId: patch.digestKeyId, bodyPurgedAt: patch.bodyPurgedAt, patchSha256: patch.patchSha256,
    baseSha: patch.baseSha };
}

/** The run's change, or null when it left none or it cannot be opened (purged, or no longer its digest). */
const openRunPatch = async (attemptId: string | null, patch: SealedRunPatch | null | undefined) =>
  !attemptId || !patch ? null : openAmuxV22TaskPatchRow(attemptId, patch).catch(() => null);

/** The run's whole result text, or null when it left none or it cannot be opened. */
const openResultText = async (row: SealedResult) => {
  if (!row.attemptId || !row.resultIdeaId || !row.digest || !row.digestKeyId || !row.sourceSha256) return null;
  return openAmuxV22TaskResultRow(row.attemptId, { ideaId: row.resultIdeaId,
    keyId: row.keyId, keyVersion: row.keyVersion, digest: row.digest, digestKeyId: row.digestKeyId,
    bodyPurgedAt: row.bodyPurgedAt, sourceSha256: row.sourceSha256 }).catch(() => null);
};

/** The run's findings (its conclusion's, else the whole result), or null when it left none or it cannot be opened. */
const openFindings = async (row: SealedResult) => {
  const text = await openResultText(row);
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
 * The workspace evidence, opened outside the read transaction. The workspace
 * is always on (owner direction 2026-11-16). Evidence that cannot be opened is
 * left out; the checkout still goes. Every file is checked whole and has no
 * size of ours; `inline` is the older route's (evidence in one answer), which
 * keeps its 64 MiB set for the relays built around it.
 */
export async function openDecisionMakerWorkspaceEvidence(
  source: DmWorkspaceSource,
  options: { inline?: boolean } = {},
): Promise<DmWorkspaceEvidence | null> {
  // `missing`: the card points at this text, so one that cannot be read is
  // counted as left out (`unreadable`), and the bridge then sends nothing --
  // a DM never judges a card without the evidence it names.
  const files: Array<{ name: DmWorkspaceEvidenceName; text: string | null; missing: boolean }> = [];
  let targetSha: string | null = null;
  if (source.kind === "t2_draft") {
    files.push({ name: "PATCH.diff", text: source.patchBody, missing: !source.patchBody });
    targetSha = source.baseSha && isSnapshotTargetSha(source.baseSha) ? source.baseSha : null;
  } else if (source.kind === "settlement" || source.kind === "result_review") {
    const criteria = await openCriteria(source);
    const criteriaText = criteria ? criteria.map((criterion) => `- ${criterion}`).join("\n") : null;
    files.push({ name: "CRITERIA.md", text: criteriaText, missing: !criteriaText });
    const report = await openFindings(source);
    // A settlement whose Task never ran has no result row; one whose row exists must open.
    const reportMissing = report === null && (source.kind === "result_review" || source.resultIdeaId !== null);
    if (source.kind === "settlement") {
      // The run's report, then every rejected review's findings, whole: the
      // same text the card was filed with (amuxDmOwnerSettlementFindingsText).
      // A rejection that cannot be read is counted in the file, as on the card.
      const reviews = await openAmuxV52RejectedReviewEntries(source.reviews)
        .catch(() => ({ entries: [], unread: source.reviews.length }));
      files.push({ name: "FINDINGS.md", text: amuxDmOwnerSettlementFindingsText({ report, reviews }),
        missing: reportMissing });
      if (source.settlementKind === "t2_pr") {
        files.push({ name: "PATCH.diff", text: source.pullPatch, missing: !source.pullPatch });
      }
    } else {
      files.push({ name: "FINDINGS.md", text: report, missing: reportMissing });
    }
    // The cards the Task depends on. The card does not point at them, so one
    // that cannot be opened is shown as such and stops nothing.
    const dependencies = await openDependencyResults(source.dependencies ?? []);
    if (dependencies) files.push({ name: "CONTEXT.md", text: dependencies, missing: false });
    // The run's change, on the commit it was made on (a commit the worker
    // fetched, so a public one): repo/ is that commit and repo-patched/ the
    // change applied. The card does not point at it, so a change that cannot
    // be opened is left out without stopping the request.
    if (source.kind === "result_review" || source.settlementKind !== "t2_pr") {
      const change = await openRunPatch(source.attemptId, source.runPatch);
      if (change) {
        files.push({ name: "PATCH.diff", text: change, missing: false });
        if (source.runPatch && isSnapshotTargetSha(source.runPatch.baseSha)) targetSha = source.runPatch.baseSha;
      }
    }
  } else if (source.kind === "v22_question") {
    // The question's own line, read again from its run's result: what the
    // worker found, whole (the card points at it only when there is some).
    const text = await openResultText(source);
    const context = text === null ? null : parseAmuxV22OwnerQuestion(text)?.context ?? null;
    files.push({ name: "CONTEXT.md", text: context, missing: text === null && source.resultIdeaId !== null });
  }
  const accepted = dmWorkspaceAcceptFiles(files.flatMap((file) =>
    file.text ? [{ name: file.name, bytes: Buffer.from(file.text, "utf8") }] : []),
  options.inline ? { totalMaxBytes: DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES } : {});
  const unreadable = files.filter((file) => file.missing).length;
  return { targetSha, files: accepted.files,
    excluded: unreadable > 0 ? { ...accepted.excluded, unreadable } : accepted.excluded };
}

// ---------------------------------------------------------------------------
// The evidence in chunks (docs/policy/amux-v22-result-transfer.md 10.2)
// ---------------------------------------------------------------------------

/**
 * One evidence file's bytes, held for the chunks of one transfer. The app
 * opens a file whole and checks it whole (`dmWorkspaceAcceptFiles`) before it
 * says anything of it; a chunk route that did that for each of a large file's
 * chunks would open and scan it again and again. So the last file one process
 * checked is kept for two minutes, under the request, the name and the sha256
 * the caller asks for: a hit is bytes that already passed the whole-file
 * checks in this process, and a miss (another process, a later request, an
 * expired entry) opens and checks again. One entry, so what is held is one
 * file. The two minutes end on their own: an unref'd timer drops the entry
 * whether or not another request comes, so the bytes never outlive them. The
 * buffer is dropped, not zeroed: the chunk a caller is still encoding is a view
 * of it.
 */
const CHUNK_HOLD_MS = 2 * 60 * 1000;
let held: { requestId: string; name: DmWorkspaceEvidenceName; sha256: string; bytes: Buffer; until: number } | null = null;
let heldTimer: ReturnType<typeof setTimeout> | null = null;

const dropHeld = () => {
  if (heldTimer !== null) clearTimeout(heldTimer);
  heldTimer = null;
  held = null;
};

const holdFile = (entry: NonNullable<typeof held>) => {
  dropHeld();
  held = entry;
  heldTimer = setTimeout(() => {
    heldTimer = null;
    if (held === entry) held = null;
  }, CHUNK_HOLD_MS);
  heldTimer.unref?.();
};

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The evidence the way the bridge asks for it in the parts protocol: what each
 * accepted file is (name, size, sha256, git blob id), not its bytes. The files
 * have passed the same whole-file checks as the inline route's, and the answer
 * counts what was left out, so the relay sends nothing when the card's
 * evidence is short.
 */
export async function describeDecisionMakerWorkspaceEvidence(source: DmWorkspaceSource) {
  const evidence = await openDecisionMakerWorkspaceEvidence(source);
  if (evidence === null) return null;
  return {
    targetSha: evidence.targetSha,
    parts: evidence.files.map((file) => dmWorkspacePartOf({ name: file.name, bytes: Buffer.from(file.text, "utf8") })),
    excluded: evidence.excluded,
  };
}

export type DmWorkspaceChunk =
  | { ok: true; totalBytes: number; chunkCount: number; sha256: string; bytes: Buffer }
  | { ok: false; reason: "request_unknown" | "evidence_absent" | "evidence_changed" | "index_out_of_range" };

/**
 * One chunk of one evidence file: the bytes [start, end) of
 * `amuxV22TransferChunkRange`. The file is the one the request's source holds
 * under `name`, opened and checked whole again unless this process still holds
 * it, and its sha256 must be the one the caller was told; a file that is gone
 * or has changed since is refused, never served in part.
 */
export async function readDecisionMakerWorkspaceChunk(
  input: { requestId: string; name: string; sha256: string; index: number },
  loadSource: () => Promise<DmWorkspaceSource | null>,
  now: () => number = Date.now,
): Promise<DmWorkspaceChunk> {
  if (!isDmWorkspaceEvidenceName(input.name)) return { ok: false, reason: "evidence_absent" };
  const name = input.name;
  let bytes: Buffer | null = null;
  if (held !== null && held.until > now() && held.requestId === input.requestId && held.name === name && held.sha256 === input.sha256) {
    bytes = held.bytes;
  } else {
    dropHeld();
    const source = await loadSource();
    if (source === null) return { ok: false, reason: "request_unknown" };
    const evidence = await openDecisionMakerWorkspaceEvidence(source);
    const file = evidence?.files.find((candidate) => candidate.name === name);
    if (file === undefined) return { ok: false, reason: "evidence_absent" };
    const opened = Buffer.from(file.text, "utf8");
    if (sha256Of(opened) !== input.sha256) return { ok: false, reason: "evidence_changed" };
    holdFile({ requestId: input.requestId, name, sha256: input.sha256, bytes: opened, until: now() + CHUNK_HOLD_MS });
    bytes = opened;
  }
  const chunkCount = amuxV22TransferChunkCount(bytes.length);
  if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= chunkCount) {
    return { ok: false, reason: "index_out_of_range" };
  }
  const { start, end } = amuxV22TransferChunkRange(bytes.length, input.index);
  return { ok: true, totalBytes: bytes.length, chunkCount, sha256: input.sha256, bytes: bytes.subarray(start, end) };
}
