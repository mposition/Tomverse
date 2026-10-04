/**
 * The closed schema of the QA-release daily digest.
 *
 * docs/policy/qa-release-agent.md, section 1: the digest carries numbers,
 * enum values, issue numbers and SHAs only -- no CI log, issue or PR text,
 * test title or error sentence has a field to live in. The shared
 * `AgentDigestItem` contract bounds the serialized payload at 16 KiB, so every
 * array has a maximum and every string a maximum length, and the worst-case
 * document is measured by a test.
 *
 * The digest service validates with this module before it submits, and the
 * app validates again before it stores. No `server-only`, Prisma or network
 * import, so both sides can load it.
 *
 * Bounded-schema rules of the shared contract: no `z.record`, union, `z.lazy`,
 * transform, `any`, `unknown` or `custom` *type*; every number an integer
 * with a minimum and maximum; every object strict; depth at most four. The
 * only refinements are cross-field checks that can refuse a document but
 * never change or widen what it may contain: a CI or release-lane job
 * belongs to its workflow, a CI row carries a class exactly when its job
 * failed, and no not-checked code appears twice.
 */
import { z } from "zod";

/** The shared contract's serialized payload limit. */
export const QA_RELEASE_DIGEST_MAX_BYTES = 16_384;

/** `report-release-gate-evidence-core.mjs` `GATE_VERDICTS`, checked by test. */
export const QA_RELEASE_GATE_VERDICTS = [
  "applicability_unknown",
  "not_applicable",
  "unmapped",
  "not_implemented",
  "implemented_unmeasured",
  "evidence_present",
] as const;

/** The release-gate registry's `allowedStatuses`, checked by test. */
export const QA_RELEASE_GATE_STATUSES = [
  "pending",
  "evidence-ready",
  "approved",
  "failed",
  "not-applicable",
] as const;

/** `report-issue-backlog-core.mjs` `VERDICTS`, checked by test. */
export const QA_RELEASE_ISSUE_VERDICTS = [
  "resolved_in_code",
  "code_complete_remainder",
  "resolved_not_on_all_branches",
  "landed_but_unverified",
  "blocked",
  "open_work",
] as const;

/** The credential-free static checks the digest runs. */
export const QA_RELEASE_CHECK_NAMES = [
  "check:release-gate-coverage",
  "check:staging-verification-records",
  "check:release-records",
  "verify:tomverse-chat-release-gates",
] as const;

/** The workflows whose job conclusions the digest reads. */
export const QA_RELEASE_CI_WORKFLOWS = [
  "e2e.yml",
  "nightly-visual-regression.yml",
  "admin-console-e2e.yml",
  "deployed-commit-drift.yml",
  "back-merge-main-to-develop.yml",
] as const;

/**
 * Each workflow's job ids, as its file names them under `jobs:`. A row names
 * the job, not only the run: e2e.yml runs matrix shards and a rollup, and
 * back-merge-main-to-develop.yml runs back-merge and verify.
 */
export const QA_RELEASE_CI_JOBS = {
  "e2e.yml": ["playwright", "regression"],
  "nightly-visual-regression.yml": ["visual-regression"],
  "admin-console-e2e.yml": ["admin-console-e2e"],
  "deployed-commit-drift.yml": ["drift"],
  "back-merge-main-to-develop.yml": ["back-merge", "verify"],
} as const satisfies Record<(typeof QA_RELEASE_CI_WORKFLOWS)[number], readonly string[]>;

const CI_JOB_IDS = [...new Set(Object.values(QA_RELEASE_CI_JOBS).flat())] as [string, ...string[]];

/** GitHub's job conclusions. */
export const QA_RELEASE_JOB_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
] as const;

/**
 * The conclusions that are a failure and therefore carry a class; every other
 * conclusion carries `label: null`, so a clean run is stored as a clean run.
 */
export const QA_RELEASE_FAILED_CONCLUSIONS = ["failure", "cancelled", "timed_out", "startup_failure"] as const;

/** CI failure classes: digest enum values, not GitHub labels. */
export const QA_RELEASE_CI_CLASSES = ["infra", "undetermined", "flaky_suspected", "consecutive_repro"] as const;

/** Fixed codes for what the digest could not establish, including the overflow replacements. */
export const QA_RELEASE_NOT_CHECKED_CODES = [
  "issue_backlog_unavailable",
  "memory_condition_unknown",
  "staging_sha_not_read",
  "github_read_unavailable",
  "hypothetical_overflow",
  "ci_overflow",
  "gates_changed_overflow",
  "issues_overflow",
  "release_lane_overflow",
  "checks_overflow",
  "applicability_unknown_overflow",
  // GitHub was read, but not all of the window (a page cap) or a job name
  // matched no known pattern: the CI rows are a partial list.
  "ci_collection_incomplete",
  // The builder had no previous snapshot, so gates.changed is not a diff.
  "gates_changed_not_compared",
  "digest_too_large",
] as const;

export const QA_RELEASE_DIGEST_ARRAY_LIMITS = {
  gatesChanged: 40,
  applicabilityUnknown: 40,
  hypothetical: 40,
  issuesCandidates: 40,
  issuesBlocked: 30,
  issuesLandedButUnverified: 30,
  checks: 12,
  ci: 16,
  releaseLane: 10,
  // Every code at once: each closed condition can occur together.
  notChecked: QA_RELEASE_NOT_CHECKED_CODES.length,
} as const;

const count = z.number().int().min(0).max(9999);
const issueNumber = z.number().int().min(1).max(999_999);
const gateId = z.string().max(16).regex(/^[A-Z]+-[0-9]{2}$/);
const isoInstant = z
  .string()
  .max(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const runId = z.string().max(16).regex(/^[0-9]{1,16}$/);
const gateStatus = z.enum(QA_RELEASE_GATE_STATUSES);

const countsOf = <T extends readonly [string, ...string[]]>(keys: T) =>
  z
    .object(Object.fromEntries(keys.map((key) => [key, count])) as { [K in T[number]]: typeof count })
    .strict();

export const qaReleaseDigestSchema = z
  .object({
    schemaVersion: z.literal(1),
    digestDate: z.string().max(10).regex(/^\d{4}-\d{2}-\d{2}$/),
    baseSha: z.string().max(40).regex(/^[0-9a-f]{40}$/),
    generatedAt: isoInstant,
    runDeadline: isoInstant,
    gates: z
      .object({
        byVerdict: countsOf(QA_RELEASE_GATE_VERDICTS),
        byStatus: countsOf(QA_RELEASE_GATE_STATUSES),
        changed: z
          .array(z.object({ id: gateId, from: gateStatus, to: gateStatus }).strict())
          .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.gatesChanged),
        applicabilityUnknown: z.array(gateId).max(QA_RELEASE_DIGEST_ARRAY_LIMITS.applicabilityUnknown),
      })
      .strict(),
    hypothetical: z
      .array(
        z
          .object({
            condition: z.literal("memory-release-b-enabled"),
            assumed: z.boolean(),
            id: gateId,
            // What classifyGate produces under the assumed condition.
            verdict: z.enum(QA_RELEASE_GATE_VERDICTS),
          })
          .strict(),
      )
      .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.hypothetical),
    issues: z
      .object({
        status: z.enum(["ok", "unavailable"]),
        byVerdict: countsOf(QA_RELEASE_ISSUE_VERDICTS),
        candidates: z.array(issueNumber).max(QA_RELEASE_DIGEST_ARRAY_LIMITS.issuesCandidates),
        blocked: z.array(issueNumber).max(QA_RELEASE_DIGEST_ARRAY_LIMITS.issuesBlocked),
        landedButUnverified: z.array(issueNumber).max(QA_RELEASE_DIGEST_ARRAY_LIMITS.issuesLandedButUnverified),
      })
      .strict(),
    checks: z
      .array(z.object({ name: z.enum(QA_RELEASE_CHECK_NAMES), result: z.enum(["pass", "fail"]) }).strict())
      .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.checks),
    ci: z
      .array(
        z
          .object({
            workflow: z.enum(QA_RELEASE_CI_WORKFLOWS),
            runId,
            job: z.enum(CI_JOB_IDS),
            /** The matrix shard, or null for a job without a matrix. */
            shard: z.number().int().min(1).max(32).nullable(),
            jobConclusion: z.enum(QA_RELEASE_JOB_CONCLUSIONS),
            label: z.enum(QA_RELEASE_CI_CLASSES).nullable(),
          })
          .strict()
          .superRefine((row, ctx) => {
            if (!(QA_RELEASE_CI_JOBS[row.workflow] as readonly string[]).includes(row.job)) {
              ctx.addIssue({ code: "custom", path: ["job"], message: "job not in workflow" });
            }
            const failed = (QA_RELEASE_FAILED_CONCLUSIONS as readonly string[]).includes(row.jobConclusion);
            if (failed !== (row.label !== null)) {
              ctx.addIssue({ code: "custom", path: ["label"], message: "label iff failed" });
            }
          }),
      )
      .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.ci),
    releaseLane: z
      .array(
        z
          .object({
            workflow: z.enum(["drift", "back-merge"]),
            runId,
            job: z.enum(["drift", "back-merge", "verify"]),
            jobConclusion: z.enum(QA_RELEASE_JOB_CONCLUSIONS),
            existingNotifierStepRan: z.boolean(),
          })
          .strict(),
      )
      .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.releaseLane),
    notChecked: z
      .array(z.enum(QA_RELEASE_NOT_CHECKED_CODES))
      .max(QA_RELEASE_DIGEST_ARRAY_LIMITS.notChecked)
      .refine((codes) => new Set(codes).size === codes.length, "duplicate code"),
  })
  .strict()
  .superRefine((digest, ctx) => {
    for (const [index, row] of digest.releaseLane.entries()) {
      const allowed = row.workflow === "drift" ? ["drift"] : ["back-merge", "verify"];
      if (!allowed.includes(row.job)) ctx.addIssue({ code: "custom", path: ["releaseLane", index, "job"], message: "job not in workflow" });
    }
  });

export type QaReleaseDigest = z.infer<typeof qaReleaseDigestSchema>;

/** Byte length of the digest as it is stored: compact JSON, UTF-8. */
export function qaReleaseDigestByteLength(digest: QaReleaseDigest): number {
  return new TextEncoder().encode(JSON.stringify(digest)).length;
}
