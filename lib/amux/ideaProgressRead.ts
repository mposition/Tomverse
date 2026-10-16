import "server-only";

import type { Prisma } from "@prisma/client";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { amuxIdeaProgress, type AmuxIdeaProgress } from "@/lib/amux/ideaProgressCore";

/** How many of the owner's newest ideas the Ideas tab lists. */
export const AMUX_IDEA_PROGRESS_LIMIT = 20;

export type AmuxIdeaProgressRow = AmuxIdeaProgress & {
  ideaId: string;
  requestId: string;
  submittedAt: string;
  /** The first registered card's display key, the only plaintext label an idea has. */
  displayKey: string | null;
  /** Task PRs waiting for GitHub review or merge. */
  reviewPullRequests: Array<{ number: number; displayKey: string | null }>;
  /** The idea's Task cards in registration order, for its detail view. */
  taskRows: Array<{ displayKey: string | null; status: string; reviewPrNumber: number | null; merged: boolean }>;
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
type SqlIdea = {
  id: string; requestId: string; state: string; submittedAtMs: number; cancelled: boolean;
  proposedUnits: number; chunks: SqlChunk[] | null; cards: SqlCard[] | null;
};

export async function readAmuxIdeaProgressInTx(tx: Prisma.TransactionClient,
  actorUserId: string, now: Date): Promise<AmuxIdeaProgressRow[]> {
  // The columns are timestamp(3) without a time zone holding UTC, so the
  // instant is converted to a naive UTC value before it is compared, and every
  // timestamp leaves as epoch milliseconds (a double, never a session-zone
  // string). An expired proposal can no longer be approved, so it waits for
  // nobody. Chunks keep their index order and cards their registration order.
  const ideas = await tx.$queryRaw<SqlIdea[]>`
    WITH newest AS (
      SELECT "id", "requestId", "state", "submittedAt", "cancelledAt"
      FROM "AmuxIdeaSubmission"
      WHERE "actorUserId" = ${actorUserId}
      ORDER BY "submittedAt" DESC, "id" ASC
      LIMIT ${AMUX_IDEA_PROGRESS_LIMIT}
    )
    SELECT
      n."id" AS "id",
      n."requestId"::text AS "requestId",
      n."state" AS "state",
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
        WHERE d."ideaId" = n."id" AND d."action" = 'register_card' AND d."state" = 'consumed') AS "cards"
    FROM newest n
    ORDER BY n."submittedAt" DESC, n."id" ASC
  `;

  return ideas.map((idea) => {
    const own = idea.cards ?? [];
    const progress = amuxIdeaProgress({
      state: idea.state,
      cancelled: idea.cancelled,
      chunks: (idea.chunks ?? []).map((chunk) => ({ ...chunk })),
      proposedUnits: idea.proposedUnits,
      cards: own.map((card) => ({ cardType: card.cardType, status: card.status,
        reviewPrNumber: card.reviewPrNumber, merged: card.terminal })),
    });
    return {
      ...progress,
      ideaId: idea.id,
      requestId: idea.requestId,
      submittedAt: new Date(idea.submittedAtMs).toISOString(),
      displayKey: own.find((card) => card.displayKey)?.displayKey ?? null,
      reviewPullRequests: own.filter((card) => card.cardType !== "story" && !card.terminal &&
        card.status === "review" && card.reviewPrNumber !== null)
        .map((card) => ({ number: card.reviewPrNumber as number, displayKey: card.displayKey })),
      taskRows: own.filter((card) => card.cardType !== "story").map((card) => ({ displayKey: card.displayKey,
        status: card.status, reviewPrNumber: card.reviewPrNumber, merged: card.terminal })),
    };
  });
}
