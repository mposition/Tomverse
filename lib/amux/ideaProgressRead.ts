import "server-only";

import type { Prisma } from "@prisma/client";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_IDEA_OWNER_CLOSABLE_STATE } from "@/lib/amux/ideaOwnerCloseCore";
import { amuxIdeaProgress, type AmuxIdeaProgress } from "@/lib/amux/ideaProgressCore";

/** How many of the owner's newest ideas the Ideas tab lists. */
export const AMUX_IDEA_PROGRESS_LIMIT = 20;

export type AmuxIdeaProgressRow = AmuxIdeaProgress & {
  ideaId: string;
  /** A session idea has no per-idea execution approval. */
  submissionOrigin?: "owner" | "session";
  /** Waiting for the owner after analysis; the owner may close it. */
  closable: boolean;
  requestId: string;
  submittedAt: string;
  /** The first registered card's display key, the only plaintext label an idea has. */
  displayKey: string | null;
  /** Task PRs waiting for GitHub review or merge. */
  reviewPullRequests: Array<{ number: number; displayKey: string | null }>;
  /** The idea's Task cards in registration order, for its detail view. */
  taskRows: Array<{ displayKey: string | null; status: string; reviewPrNumber: number | null; merged: boolean }>;
  /** Session reference SHAs fixed at intake, before a checkout exists. */
  referencePins: Array<{ referenceOrdinal: number; pinnedCommitSha: string }> | null;
  /** Valid pre-pinning audit, distinct from a damaged or unavailable pin. */
  referencePinsLegacy?: boolean;
  /** Content-free proof for each prepared v19 reference, in source order. */
  checkoutEvidence: Array<{
    referenceOrdinal: number;
    pinnedCommitSha: string;
    excludedCount: number;
    excludedReasons: { secretPath: number; secretContent: number;
      nonRegular: number; unscannableContent: number };
    /** One read manifest per analysis page, in page order. */
    readManifests: Array<{ manifestId: string; fileCount: number; digest: string;
      bodyPurged: boolean }>;
  }>;
};

/**
 * The owner's newest ideas and the stage each is at, for the Ideas tab
 * (approved backlog redesign). One REPEATABLE READ snapshot inside the AMUX DB
 * boundary: setup + ONE statement + fence, pinned by tests/amuxIdeaProgress.test.mjs.
 *
 * Why one statement: a boundary sets idle_in_transaction_session_timeout to
 * 100 ms (lib/amux/dbBoundary.ts), and a gap longer than that between two of
 * its statements ends the session with 25P03. Seven sequential reads made
 * eight such gaps, and over the production round trip the Ideas list failed
 * to read; a single statement has the same two gaps as every other boundary.
 *
 * It reads no idea text, title or body (all encrypted or purged); a failed read
 * throws, and the page shows it as unavailable, never as an empty list. One
 * more attempt is made after a failure, which is safe because nothing was
 * written. Outside a route budget (the page has none) the boundary does not
 * classify a dropped session as busy: the pg client reports it as a plain Error
 * with no code, so the retry cannot wait for a "busy" answer. Only the
 * boundary's own deterministic refusals (call ceiling, commit check) are not
 * retried.
 */
export async function readAmuxIdeaProgressForOwner(actorUserId: string): Promise<AmuxIdeaProgressRow[]> {
  const attempt = () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ideaProgressListRead,
    (tx, { dbNow }) => readAmuxIdeaProgressInTx(tx, actorUserId, dbNow));
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof AmuxDbBoundaryError && (error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED" ||
        error.code === "AMUX_DB_COMMIT_CHECK_MISSING")) throw error;
    return attempt();
  }
}

type SqlChunk = {
  chunkIndex: number; state: string; coverageStatus: string | null;
  previewState: string | null; holdStatus: string | null;
};
type SqlCard = {
  id: string; cardType: string | null; status: string; reviewPrNumber: number | null;
  terminal: boolean; displayKey: string | null;
};
type SqlCheckoutEvidence = {
  referenceOrdinal: number; pinnedCommitSha: string; excludedCount: number;
  secretPath: number; secretContent: number; nonRegular: number;
  unscannableContent: number;
  readManifests: Array<{ manifestId: string; fileCount: number; digest: string;
    bodyPurged: boolean }> | null;
};
type SqlIdea = {
  id: string; requestId: string; state: string; submissionOrigin: "owner" | "session";
  submittedAtMs: number; cancelled: boolean;
  proposedUnits: number; chunks: SqlChunk[] | null; cards: SqlCard[] | null;
  referencePins: unknown;
  referencePinAuditStatus: "declared" | "legacy" | null;
  checkoutEvidence: SqlCheckoutEvidence[] | null;
};

const PIN_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function readAmuxIdeaProgressInTx(tx: Prisma.TransactionClient,
  actorUserId: string, now: Date): Promise<AmuxIdeaProgressRow[]> {
  // The columns are timestamp(3) without a time zone holding UTC, so the
  // instant is converted to a naive UTC value before it is compared, and every
  // timestamp leaves as epoch milliseconds (a double, never a session-zone
  // string). An expired proposal can no longer be approved, so it waits for
  // nobody. Chunks keep their index order and cards their registration order.
  const ideas = await tx.$queryRaw<SqlIdea[]>`
    WITH newest AS (
      SELECT "id", "requestId", "state", "submissionOrigin", "submittedAt", "cancelledAt",
        "submissionAuditLogId"
      FROM "AmuxIdeaSubmission"
      WHERE "actorUserId" = ${actorUserId}
      ORDER BY "submittedAt" DESC, "id" ASC
      LIMIT ${AMUX_IDEA_PROGRESS_LIMIT}
    )
    SELECT
      n."id" AS "id",
      n."requestId"::text AS "requestId",
      n."state" AS "state",
      n."submissionOrigin" AS "submissionOrigin",
      (extract(epoch FROM n."submittedAt") * 1000)::double precision AS "submittedAtMs",
      (n."cancelledAt" IS NOT NULL) AS "cancelled",
      (SELECT count(*)::int FROM "AmuxIdeaDraftUnit" u
        WHERE u."ideaId" = n."id" AND u."state" = 'proposed'
          AND u."expiresAt" > (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS "proposedUnits",
      (SELECT json_agg(json_build_object(
          'chunkIndex', c."chunkIndex", 'state', c."state", 'coverageStatus', c."coverageStatus",
          'previewState', p."state", 'holdStatus', h."status") ORDER BY c."chunkIndex")
        FROM "AmuxIdeaAnalysisChunk" c
        LEFT JOIN "AmuxIdeaTransferPreview" p ON p."id" = c."currentPreviewId"
        LEFT JOIN "AmuxIdeaAnalysisBudgetHold" h ON h."previewId" = p."id"
        WHERE c."ideaId" = n."id") AS "chunks",
      (SELECT json_agg(json_build_object(
          'id', w."id", 'cardType', w."cardType", 'status', w."status",
          'reviewPrNumber', w."reviewPrNumber", 'terminal', (w."v4TerminalAt" IS NOT NULL),
          'displayKey', w."displayKey") ORDER BY w."createdAt" ASC, w."id" ASC)
        FROM "AmuxIdeaUnitDecision" d
        JOIN "AmuxWorkItem" w ON w."id" = d."registeredWorkItemId"
        WHERE d."ideaId" = n."id" AND d."action" = 'register_card' AND d."state" = 'consumed') AS "cards",
      (SELECT a."metadata"->'pinnedCommitShas' FROM "AdminAuditLog" a
        WHERE a."id" = n."submissionAuditLogId"
          AND a."action" = 'amux.idea.session_submitted'
          AND a."targetType" = 'AmuxIdeaSubmission'
          AND a."targetId" = n."id"
          AND a."entryHash" IS NOT NULL) AS "referencePins",
      (SELECT CASE WHEN jsonb_typeof(a."metadata") = 'object'
          AND NOT (a."metadata" ? 'pinnedCommitShas') THEN 'legacy'
          ELSE 'declared' END FROM "AdminAuditLog" a
        WHERE a."id" = n."submissionAuditLogId"
          AND a."action" = 'amux.idea.session_submitted'
          AND a."targetType" = 'AmuxIdeaSubmission'
          AND a."targetId" = n."id"
          AND a."entryHash" IS NOT NULL) AS "referencePinAuditStatus",
      (SELECT json_agg(json_build_object(
          'referenceOrdinal', e."referenceOrdinal",
          'pinnedCommitSha', e."pinnedCommitSha",
          'excludedCount', e."excludedCount",
          'secretPath', e."excludedSecretPathCount",
          'secretContent', e."excludedSecretContentCount",
          'nonRegular', e."excludedNonRegularCount",
          'unscannableContent', e."excludedUnscannableCount",
          -- One read manifest per analysis page, each with its own count,
          -- digest and purge state.
          'readManifests', (SELECT json_agg(json_build_object(
              'manifestId', m."id", 'fileCount', m."fileCount",
              'digest', m."digest", 'bodyPurged', m."bodyPurgedAt" IS NOT NULL)
              ORDER BY m."createdAt", m."id")
            FROM "AmuxIdeaTrackedCheckoutReadManifest" m
            WHERE m."ideaId" = e."ideaId" AND m."referenceOrdinal" = e."referenceOrdinal"))
          ORDER BY e."referenceOrdinal")
        FROM "AmuxIdeaTrackedCheckoutEvidence" e
        WHERE e."ideaId" = n."id") AS "checkoutEvidence"
    FROM newest n
    ORDER BY n."submittedAt" DESC, n."id" ASC
  `;

  return ideas.map((idea) => {
    const own = idea.cards ?? [];
    const pins = idea.referencePins;
    const progress = amuxIdeaProgress({
      state: idea.state,
      submissionOrigin: idea.submissionOrigin,
      cancelled: idea.cancelled,
      chunks: (idea.chunks ?? []).map((chunk) => ({ ...chunk })),
      proposedUnits: idea.proposedUnits,
      cards: own.map((card) => ({ cardType: card.cardType, status: card.status,
        reviewPrNumber: card.reviewPrNumber, merged: card.terminal })),
    });
    return {
      ...progress,
      ideaId: idea.id,
      submissionOrigin: idea.submissionOrigin,
      closable: idea.state === AMUX_IDEA_OWNER_CLOSABLE_STATE && !idea.cancelled,
      requestId: idea.requestId,
      submittedAt: new Date(idea.submittedAtMs).toISOString(),
      displayKey: own.find((card) => card.displayKey)?.displayKey ?? null,
      reviewPullRequests: own.filter((card) => card.cardType !== "story" && !card.terminal &&
        card.status === "review" && card.reviewPrNumber !== null)
        .map((card) => ({ number: card.reviewPrNumber as number, displayKey: card.displayKey })),
      taskRows: own.filter((card) => card.cardType !== "story").map((card) => ({ displayKey: card.displayKey,
        status: card.status, reviewPrNumber: card.reviewPrNumber, merged: card.terminal })),
      referencePins: Array.isArray(pins) && pins.every((sha) =>
        typeof sha === "string" && PIN_SHA.test(sha))
        ? pins.map((sha, referenceOrdinal) => ({ referenceOrdinal,
          pinnedCommitSha: sha as string })) : null,
      referencePinsLegacy: idea.referencePinAuditStatus === "legacy",
      checkoutEvidence: (idea.checkoutEvidence ?? []).map((evidence) => ({
        referenceOrdinal: evidence.referenceOrdinal,
        pinnedCommitSha: evidence.pinnedCommitSha,
        excludedCount: evidence.excludedCount,
        excludedReasons: { secretPath: evidence.secretPath,
          secretContent: evidence.secretContent, nonRegular: evidence.nonRegular,
          unscannableContent: evidence.unscannableContent },
        readManifests: evidence.readManifests ?? [],
      })),
    };
  });
}
