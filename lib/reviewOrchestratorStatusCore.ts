/**
 * The independent review server's status report: what it may send and how the
 * app reads what it stored.
 *
 * The review orchestrator (tools/review-orchestrator) runs on the operator's
 * Ubuntu server and is reachable only over SSH, so the app cannot ask it
 * anything. It sends this report instead, about once a minute, to
 * `POST /api/internal/review-orchestrator/status`. The report is content-free
 * by its schema: per reviewer its id, vendor, whether it is enabled and how
 * many reviews it runs out of how many it may, how many jobs wait, and the
 * last 24 hours' verdict counts. No job id, branch, scope, diff, finding or
 * reviewer text has a field to travel in, and an unknown field is refused.
 *
 * The app keeps only the latest report, in one AppSetting row, stamped with
 * the app's own receipt time -- never the sender's clock.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const REVIEW_ORCHESTRATOR_STATUS_KEY = "reviewOrchestrator.status";
export const REVIEW_ORCHESTRATOR_STATUS_SECRET_ENV = "REVIEW_ORCHESTRATOR_STATUS_SECRET";
export const REVIEW_ORCHESTRATOR_STATUS_MAX_BYTES = 8192;
/** The server reports every minute; five missed reports read as a lost connection. */
export const REVIEW_ORCHESTRATOR_STALE_AFTER_MS = 5 * 60 * 1000;

const MIN_SECRET_LENGTH = 32;
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const count = z.number().int().min(0).max(100_000);

export const reviewStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Draining for an update: nothing new starts until it is lifted. */
    draining: z.boolean(),
    pendingJobs: count,
    providers: z
      .array(
        z
          .object({
            id,
            vendor: id,
            enabled: z.boolean(),
            running: z.number().int().min(0).max(64),
            maxConcurrent: z.number().int().min(1).max(64),
          })
          .strict()
      )
      .max(16)
      .refine((providers) => new Set(providers.map((p) => p.id)).size === providers.length),
    last24h: z.object({ accept: count, reject: count, unknown: count }).strict(),
  })
  .strict();

export type ReviewStatusSnapshot = z.infer<typeof reviewStatusSnapshotSchema>;

export type StoredReviewStatus =
  | { state: "observed"; receivedAt: string; snapshot: ReviewStatusSnapshot }
  /** A row that is not this module's shape. Never read as "no report". */
  | { state: "unreadable" };

const storedSchema = z
  .object({ receivedAt: z.string().datetime(), snapshot: reviewStatusSnapshotSchema })
  .strict();

/** What a stored row means. */
export const parseStoredReviewStatus = (value: string): StoredReviewStatus => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return { state: "unreadable" };
  }
  const parsed = storedSchema.safeParse(decoded);
  return parsed.success
    ? { state: "observed", receivedAt: parsed.data.receivedAt, snapshot: parsed.data.snapshot }
    : { state: "unreadable" };
};

/** The value the app stores for an accepted report. */
export const storedReviewStatusValue = (snapshot: ReviewStatusSnapshot, receivedAt: Date) =>
  JSON.stringify({ receivedAt: receivedAt.toISOString(), snapshot });

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Bearer secret, at least 32 characters, compared as SHA-256 digests in constant time. */
export const isReviewOrchestratorStatusAuthorized = (
  authorization: string | null,
  env: Readonly<Record<string, string | undefined>>
): boolean => {
  const own = env[REVIEW_ORCHESTRATOR_STATUS_SECRET_ENV] ?? "";
  if (own.length < MIN_SECRET_LENGTH) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(own), digest(provided));
};
