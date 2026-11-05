import "server-only";

import type { Prisma } from "@prisma/client";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  AMUX_IDEA_LANE_BOARD_DONE_MS, AMUX_IDEA_LANE_BOARD_LIMIT, amuxIdeaLaneBoardCard,
  type AmuxIdeaLaneBoardCard, type AmuxIdeaLaneBoardIdea,
} from "@/lib/amux/ideaLaneBoardCore";
import { amuxIdeaLaneEnabled } from "@/lib/amux/ideaLaneCore";

/**
 * The owner's idea lane work for the Execution board, read apart from the
 * board's cards (lib/amux/adminExecutionRead.ts) so it never enters their
 * counts, pages or the archive-all command. One REPEATABLE READ snapshot with
 * one statement, like the Ideas list (lib/amux/ideaProgressRead.ts), whose
 * lane facts it reads the same way; no idea body or digest, only the title.
 */
export async function readAmuxIdeaLaneBoardForOwner(actorUserId: string): Promise<AmuxIdeaLaneBoardCard[]> {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ideaLaneBoardRead,
    (tx, { dbNow }) => readAmuxIdeaLaneBoardInTx(tx, actorUserId, dbNow));
}

export async function readAmuxIdeaLaneBoardInTx(tx: Prisma.TransactionClient, actorUserId: string,
  now: Date): Promise<AmuxIdeaLaneBoardCard[]> {
  const enabled = amuxIdeaLaneEnabled();
  const doneSince = new Date(now.getTime() - AMUX_IDEA_LANE_BOARD_DONE_MS);
  // timestamp(3) columns hold naive UTC, so instants are compared as naive UTC.
  // An idea the lane has run, or (lane on) a submitted owner idea it may take
  // next; amuxIdeaLaneView decides the rest. A PR merged over a week ago is
  // left out before the LIMIT, and a closed idea leaves as it does the Ideas list.
  const ideas = await tx.$queryRaw<AmuxIdeaLaneBoardIdea[]>`
    SELECT s."requestId"::text AS "requestId", s."title" AS "title",
      s."submissionOrigin" AS "submissionOrigin", s."state" AS "state", false AS "cancelled",
      (s."rawPurgedAt" IS NULL AND s."rawKeyId" IS NOT NULL) AS "rawReadable",
      (extract(epoch FROM s."analysisDeadlineAt") * 1000)::double precision AS "analysisDeadlineMs",
      (s."currentSourcePlanRevisionId" IS NOT NULL) AS "sourcePlan",
      (SELECT count(*)::int FROM "AmuxIdeaAnalysisChunk" c WHERE c."ideaId" = s."id") AS "chunks",
      COALESCE((SELECT json_agg(json_build_object(
          'claimedAtMs', (extract(epoch FROM l."claimedAt") * 1000)::double precision,
          'leaseUntilMs', (extract(epoch FROM l."leaseUntil") * 1000)::double precision,
          'outcome', l."outcome", 'prNumber', l."prNumber",
          'mergedAtMs', (extract(epoch FROM l."mergedAt") * 1000)::double precision,
          'prClosedAtMs', (extract(epoch FROM l."prClosedAt") * 1000)::double precision))
        FROM "AmuxIdeaLaneAttempt" l WHERE l."ideaId" = s."id"), '[]'::json) AS "laneAttempts"
    FROM "AmuxIdeaSubmission" s
    WHERE s."actorUserId" = ${actorUserId} AND s."cancelledAt" IS NULL AND s."submissionOrigin" = 'owner'
      AND (EXISTS (SELECT 1 FROM "AmuxIdeaLaneAttempt" l WHERE l."ideaId" = s."id")
        OR (${enabled}::boolean AND s."state" = 'submitted'))
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaLaneAttempt" l WHERE l."ideaId" = s."id"
        AND l."mergedAt" <= (${doneSince.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    ORDER BY s."submittedAt" DESC, s."id" ASC
    LIMIT ${AMUX_IDEA_LANE_BOARD_LIMIT}
  `;
  return ideas.flatMap((idea) => {
    const card = amuxIdeaLaneBoardCard(idea, now.getTime(), enabled);
    return card ? [card] : [];
  });
}
