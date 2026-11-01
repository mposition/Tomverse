/**
 * The comment monitor's two steps as the app answers them (marketing S4d;
 * docs/policy/marketing-automation.md §12.1; lib/marketingCommentsMonitor.ts,
 * "Two steps").
 *
 * `collect` returns the new comment bodies a run would ask about, each with its
 * id (the SHA-256 of the body), the `readAt` its reading covers up to -- now,
 * or for a backlog past the cap an earlier instant -- and `backlog` for such a
 * cut. `judge` takes both back with a verdict per id and runs the whole monitor here:
 * it reads the comments again, asks the verdicts in place of a model, records
 * the alerts, counts unanswered ones against their accounts and records the run
 * only if it was whole. The service that sends the verdicts is authenticated,
 * not trusted: a verdict can only be one of the closed codes, can only open an
 * alert, and a body it has none for leaves its post unread.
 */

import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MARKETING_COMMENT_COLLECT_MAX_BODIES,
  MARKETING_COMMENT_MONITOR_OVERLAP_MS,
  MARKETING_COMMENT_RISK_CODES,
  collectMarketingCommentBodies,
  runMarketingCommentsMonitor,
  type MarketingCommentClassifier,
  type MarketingCommentsMonitorDeps,
} from "@/lib/marketingCommentsMonitor";

/** A judge carries at most a verdict per collected body, under 300 bytes even with every code. */
export const MARKETING_COMMENTS_MONITOR_MAX_BODY_BYTES = 512 * 1024;

/**
 * How old a `readAt` may be: older than any comment the monitor reads, which
 * are all under posts of the last fourteen days. A backlog cut is legitimately
 * old (lib/marketingCommentsMonitor.ts, `collectMarketingCommentBodies`); a
 * verdict is about a body, not a moment, so its age does not matter.
 */
export const MARKETING_COMMENTS_READ_AT_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

/** A body's id in both steps. */
export const marketingCommentBodyId = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");

export const marketingCommentsMonitorRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("collect") }).strict(),
  z
    .object({
      action: z.literal("judge"),
      readAt: z.string().datetime({ offset: false }),
      backlog: z.boolean(),
      verdicts: z
        .array(
          z
            .object({
              id: z.string().regex(/^[0-9a-f]{64}$/),
              codes: z.array(z.enum(MARKETING_COMMENT_RISK_CODES)).max(MARKETING_COMMENT_RISK_CODES.length),
            })
            .strict(),
        )
        .max(MARKETING_COMMENT_COLLECT_MAX_BODIES)
        // One verdict per body: a second would silently replace the first.
        .refine((verdicts) => new Set(verdicts.map((verdict) => verdict.id)).size === verdicts.length),
    })
    .strict(),
]);
export type MarketingCommentsMonitorRequest = z.infer<typeof marketingCommentsMonitorRequestSchema>;

/** The service's verdicts as a classifier: by body, and `null` for a body it sent none for. */
export const marketingCommentVerdictClassifier =
  (verdicts: ReadonlyMap<string, readonly string[]>): MarketingCommentClassifier =>
  async (bodies) =>
    bodies.map((body) => verdicts.get(marketingCommentBodyId(body)) ?? null);

export async function answerMarketingCommentsMonitorRequest(
  request: MarketingCommentsMonitorRequest,
  deps: Omit<MarketingCommentsMonitorDeps, "classifier" | "reading">,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const now = deps.now();
  if (request.action === "collect") {
    const collected = await collectMarketingCommentBodies(deps, now);
    if (!collected.ran) return { status: 200, body: { status: "off" } };
    return {
      status: 200,
      body: {
        status: "ok",
        readAt: collected.reading.until.toISOString(),
        backlog: collected.reading.backlog,
        items: collected.bodies.map((body) => ({ id: marketingCommentBodyId(body), body })),
      },
    };
  }
  // What the run's reading covers up to, as collect set it. Never later than
  // now -- and a backlog cut never later than one overlap before now, so the
  // run it records is not later than now either. Earlier only makes the
  // recorded run older, the safe way to be wrong: what was not covered is read
  // again. A `backlog` the service made up spares the next run its overlap,
  // and nothing more: every comment up to `readAt` still needs its verdict.
  const readAt = new Date(request.readAt);
  const age = now.getTime() - readAt.getTime();
  if (
    !(age >= 0 && age <= MARKETING_COMMENTS_READ_AT_MAX_AGE_MS) ||
    (request.backlog && age < MARKETING_COMMENT_MONITOR_OVERLAP_MS)
  ) {
    return { status: 400, body: { code: "read_at_out_of_range" } };
  }
  const result = await runMarketingCommentsMonitor({
    ...deps,
    classifier: marketingCommentVerdictClassifier(new Map(request.verdicts.map((verdict) => [verdict.id, verdict.codes]))),
    reading: { until: readAt, backlog: request.backlog },
  });
  if (!result.ran) return { status: 200, body: { status: "off" } };
  return { status: 200, body: { status: "ok", result } };
}
