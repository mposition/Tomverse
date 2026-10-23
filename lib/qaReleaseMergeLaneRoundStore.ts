import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { isQaReleaseRouteSecret } from "@/lib/qaReleaseRouteAuthCore";

/**
 * What the merge lane saw on its latest rounds, for Admin › QA and release
 * (owner, 2026-10-23). Display only: one AppSetting row the lane service
 * overwrites each round, never read by the lane, never an audit event (the
 * lane's actions -- instruction, merge, report -- are audited where they
 * happen). A round that did not read the pull requests (hold, latched, an
 * attempt in flight) keeps the last judged list and says when it was judged.
 */
export const QA_RELEASE_LANE_ROUND_SETTING_KEY = "qa_release.merge_lane.rounds";
export const QA_RELEASE_LANE_ROUNDS_KEPT = 12;

const REASON = z.string().regex(/^[a-z_]{1,48}$/);
const verdict = z
  .object({
    number: z.number().int().positive().max(1_000_000_000),
    title: z.string().max(200),
    headRefName: z.string().max(200),
    status: z.enum(["next", "queued", "waiting", "human", "fix", "draft"]),
    reasons: z.array(REASON).max(12),
    files: z.array(z.object({ path: z.string().min(1).max(200), reasons: z.array(REASON).max(8) }).strict()).max(20),
    failedChecks: z.array(z.string().max(200)).max(5),
  })
  .strict();
const body = z.object({ outcome: REASON, verdicts: z.array(verdict).max(60).nullable() }).strict();

export type QaReleaseLaneRoundVerdict = z.infer<typeof verdict>;
export type QaReleaseLaneRounds = {
  /** Newest first. */
  rounds: { at: string; outcome: string }[];
  verdicts: { at: string; list: QaReleaseLaneRoundVerdict[] } | null;
};

const stored = z.object({
  rounds: z.array(z.object({ at: z.string(), outcome: z.string() })),
  verdicts: z.object({ at: z.string(), list: z.array(verdict) }).nullable(),
});

const EMPTY: QaReleaseLaneRounds = { rounds: [], verdicts: null };

export async function readQaReleaseLaneRounds(): Promise<QaReleaseLaneRounds> {
  const row = await prisma.appSetting.findUnique({ where: { key: QA_RELEASE_LANE_ROUND_SETTING_KEY }, select: { value: true } });
  if (!row) return EMPTY;
  try {
    const parsed = stored.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** POST /api/internal/agents/qa-release/merge-lane/round, with the lane's own secret. */
export async function handleQaReleaseLaneRound(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!isQaReleaseRouteSecret("mergeLane", bearer, env)) return { status: 401, body: { error: "unauthorized" } };
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 128 * 1024) return { status: 400, body: { error: "invalid_request" } };
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
  const at = new Date().toISOString();
  const before = await readQaReleaseLaneRounds();
  const next: QaReleaseLaneRounds = {
    rounds: [{ at, outcome: parsed.data.outcome }, ...before.rounds].slice(0, QA_RELEASE_LANE_ROUNDS_KEPT),
    verdicts: parsed.data.verdicts === null ? before.verdicts : { at, list: parsed.data.verdicts },
  };
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: QA_RELEASE_LANE_ROUND_SETTING_KEY },
    create: { key: QA_RELEASE_LANE_ROUND_SETTING_KEY, value },
    update: { value },
  });
  return { status: 200, body: { recorded: true } };
}
