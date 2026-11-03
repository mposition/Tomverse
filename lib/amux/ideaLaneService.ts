import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import {
  AMUX_IDEA_LANE_LEASE_MS,
  AMUX_IDEA_LANE_MAX_ATTEMPTS,
  AMUX_IDEA_LANE_PUBLISH_FENCE_MS,
  AMUX_IDEA_LANE_SECRET_ENV,
  amuxIdeaLaneBranch,
  amuxIdeaLaneClaimable,
  amuxIdeaLaneDailyAttempts,
  amuxIdeaLaneEnabled,
  amuxIdeaLaneState,
  type AmuxIdeaLaneAttemptFact,
  type AmuxIdeaLaneResult,
} from "./ideaLaneCore.ts";

const MIN_SECRET_LENGTH = 32;
const CANDIDATES = 20;

/** The lane switch and its own bearer secret; both fail closed. */
export function isAmuxIdeaLaneAuthorized(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env[AMUX_IDEA_LANE_SECRET_ENV] ?? "";
  if (!amuxIdeaLaneEnabled(env) || configured.length < MIN_SECRET_LENGTH) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(configured), digest(authorization.slice(7)));
}

type Candidate = {
  id: string; rawCiphertext: Uint8Array; rawKeyId: string; rawKeyVersion: number;
  rawDigest: string; rawDigestKeyId: string;
  attempts: Array<{ claimedAtMs: number; leaseUntilMs: number; outcome: string | null; prNumber: number | null }> | null;
};

export type AmuxIdeaLaneClaim = { ideaId: string; attemptId: string; branch: string; idea: string };

/**
 * Claims the oldest owner idea the lane may run, or null. Owner ideas only:
 * a session idea belongs to the v19 analysis queue, and an owner idea whose
 * analysis already started stays on that path. One claim at a time (advisory
 * lock), within the daily attempt limit. `actorUserId` narrows the scan to one
 * owner, for isolated DB tests; the route never passes it.
 */
export async function claimAmuxIdeaLane(scope: { actorUserId?: string } = {}): Promise<AmuxIdeaLaneClaim | null> {
  const actor = scope.actorUserId ?? null;
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('amux_idea_lane_claim'))`;
    const now = await databaseNow(tx);
    const since = new Date(now.getTime() - 86_400_000);
    const today = await tx.amuxIdeaLaneAttempt.count({ where: { claimedAt: { gt: since } } });
    if (today >= amuxIdeaLaneDailyAttempts()) return null;
    const candidates = await tx.$queryRaw<Candidate[]>`
      SELECT i."id", i."rawCiphertext", i."rawKeyId", i."rawKeyVersion", i."rawDigest", i."rawDigestKeyId",
        (SELECT json_agg(json_build_object(
            'claimedAtMs', (extract(epoch FROM a."claimedAt") * 1000)::double precision,
            'leaseUntilMs', (extract(epoch FROM a."leaseUntil") * 1000)::double precision,
            'outcome', a."outcome", 'prNumber', a."prNumber"))
          FROM "AmuxIdeaLaneAttempt" a WHERE a."ideaId" = i."id") AS "attempts"
      FROM "AmuxIdeaSubmission" i
      WHERE i."submissionOrigin" = 'owner' AND i."state" = 'submitted'
        AND (${actor}::text IS NULL OR i."actorUserId" = ${actor})
        AND i."cancelledAt" IS NULL AND i."rawPurgedAt" IS NULL AND i."rawCiphertext" IS NOT NULL
        AND i."rawKeyId" IS NOT NULL AND i."rawDigest" IS NOT NULL
        AND i."analysisDeadlineAt" > (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND i."currentSourcePlanRevisionId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaAnalysisChunk" c WHERE c."ideaId" = i."id")
        -- Ideas the lane is done with (PR opened, out of attempts) or running now
        -- are left out before the LIMIT, so they can never crowd out a new idea.
        AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaLaneAttempt" a WHERE a."ideaId" = i."id"
          AND (a."outcome" = 'pr_open' OR (a."outcome" IS NULL
            AND a."leaseUntil" > (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))))
        AND (SELECT count(*) FROM "AmuxIdeaLaneAttempt" a WHERE a."ideaId" = i."id") < ${AMUX_IDEA_LANE_MAX_ATTEMPTS}
      ORDER BY i."submittedAt" ASC, i."id" ASC
      LIMIT ${CANDIDATES}
    `;
    const nowMs = now.getTime();
    let pick: Candidate | null = null;
    for (const idea of candidates) {
      if (!amuxIdeaLaneClaimable(amuxIdeaLaneState((idea.attempts ?? []) as AmuxIdeaLaneAttemptFact[], nowMs))) continue;
      // The owner's close (ideaOwnerCloseService.ts) and the analysis path's
      // first source plan lock this row too, so
      // what is read after the lock is final: an idea closed or put into
      // analysis meanwhile is skipped, and that path refuses an idea claimed here.
      const [locked] = await tx.$queryRaw<Array<{ open: boolean }>>`
        SELECT (i."state" = 'submitted' AND i."cancelledAt" IS NULL
          AND i."currentSourcePlanRevisionId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaAnalysisChunk" c WHERE c."ideaId" = i."id")) AS "open"
        FROM "AmuxIdeaSubmission" i WHERE i."id" = ${idea.id} FOR UPDATE
      `;
      if (locked?.open) {
        pick = idea;
        break;
      }
    }
    if (!pick) return null;
    const attemptId = randomUUID();
    await tx.amuxIdeaLaneAttempt.create({ data: { id: attemptId, ideaId: pick.id, claimedAt: now,
      leaseUntil: new Date(nowMs + AMUX_IDEA_LANE_LEASE_MS) } });
    return { attemptId, idea: pick };
  }, { timeout: 10_000 });
  if (!claimed) return null;
  const { attemptId, idea } = claimed;
  const text = await openIdeaText(idea).catch(() => null);
  if (text === null) {
    // Counted as a failed run, so an unreadable idea stops at the attempt limit.
    await recordAmuxIdeaLaneResult({ attemptId, outcome: "job_failed", prNumber: null });
    return null;
  }
  return { ideaId: idea.id, attemptId, branch: amuxIdeaLaneBranch(attemptId), idea: text };
}

async function openIdeaText(idea: Candidate): Promise<string | null> {
  const keys = await loadAmuxContentKeyRing([{ ideaId: idea.id, purpose: "idea_raw", subjectId: idea.id }]);
  const plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext), keyId: idea.rawKeyId,
    keyVersion: idea.rawKeyVersion }, "idea_raw", idea.id, keys);
  try {
    if (!verifyAmuxContentDigest(plain, "idea_raw", idea.id, idea.rawDigest, idea.rawDigestKeyId, keys)) return null;
    const inspected = inspectAmuxIdeaInput(plain.toString("utf8"));
    return inspected.ok ? inspected.input.idea : null;
  } finally {
    plain.fill(0);
  }
}

/**
 * The last check before a run pushes and opens its PR. Under the idea row lock
 * the owner's close also takes, the idea must still be open and this run's
 * lease live; the lease is then set AMUX_IDEA_LANE_PUBLISH_FENCE_MS ahead, so a close stays refused until the push is done. A run whose lease
 * lapsed (the idea may already be closed or retried) is refused here.
 */
export async function fenceAmuxIdeaLanePublish(attemptId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    const attempt = await tx.amuxIdeaLaneAttempt.findUnique({ where: { id: attemptId }, select: { ideaId: true } });
    if (!attempt) return false;
    const [row] = await tx.$queryRaw<Array<{ open: boolean; now: Date }>>`
      SELECT (i."state" = 'submitted' AND i."cancelledAt" IS NULL) AS "open",
        (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
      FROM "AmuxIdeaSubmission" i WHERE i."id" = ${attempt.ideaId} FOR UPDATE
    `;
    if (!row?.open) return false;
    const { count } = await tx.amuxIdeaLaneAttempt.updateMany({
      where: { id: attemptId, outcome: null, leaseUntil: { gt: row.now } },
      data: { leaseUntil: new Date(row.now.getTime() + AMUX_IDEA_LANE_PUBLISH_FENCE_MS) },
    });
    return count === 1;
  }, { timeout: 10_000 });
}

/** Records a run's outcome once; a replay or an unknown attempt is not applied. */
export async function recordAmuxIdeaLaneResult(result: AmuxIdeaLaneResult): Promise<boolean> {
  const now = await prisma.$transaction((tx) => databaseNow(tx));
  const { count } = await prisma.amuxIdeaLaneAttempt.updateMany({
    where: { id: result.attemptId, outcome: null },
    data: { outcome: result.outcome, prNumber: result.prNumber, finishedAt: now },
  });
  return count === 1;
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("database clock unavailable");
  return now;
}
