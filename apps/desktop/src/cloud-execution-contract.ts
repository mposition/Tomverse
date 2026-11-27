import { z } from "zod";
import type { ReviewFile } from "./review-contract";
import { managedModelId, managedRefusalFor, MANAGED_MAX_APPROVED_CREDITS, type ManagedCodeModel, type ManagedRefusal } from "./managed-code-contract";

/**
 * Desktop cloud execution (docs/ops/desktop-cloud-execution.md): a Code task that runs on a Tomverse runner instead of
 * this computer. The renderer names an action; the main process snapshots the open project's tracked files into a git
 * bundle, uploads it with the account session, follows the job, and on request downloads the patch, shows it, and
 * applies it to the folder after the person confirms. No path or patch text crosses the bridge from the renderer.
 *
 * Money: the person approves a credit cap; the server reserves it on the managed Code path when a runner starts the task
 * and settles each model call. Desktop shows receipt numbers only. Compute time is not charged.
 */

export const CLOUD_INSTRUCTION_MAX = 16_000;
const jobId = z.uuid();

export const desktopCloudExecutionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({
    action: z.literal("start"), instruction: z.string().trim().min(1).max(CLOUD_INSTRUCTION_MAX),
    executorModelId: managedModelId, reviewerModelId: managedModelId,
    approvedCredits: z.number().int().positive().max(MANAGED_MAX_APPROVED_CREDITS),
  }).strict(),
  z.object({ action: z.literal("cancel"), jobId }).strict(),
  z.object({ action: z.literal("review"), jobId }).strict(),
  z.object({ action: z.literal("apply"), jobId }).strict(),
  z.object({ action: z.literal("closeReview") }).strict(),
]);
export type DesktopCloudExecutionInput = z.infer<typeof desktopCloudExecutionInput>;

/** Why Desktop or the server did not do what was asked. Each has its own sentence in the person's language. */
export const cloudRefusal = z.enum([
  "disabled", "noProject", "remoteProject", "notGit", "otherProject", "noCommit", "tooLarge", "snapshotFailed", "concurrency", "conflict",
  "notFound", "account", "unreachable", "patchUnavailable", "applyConflict", "applyFailed", "unavailable",
]);
export type CloudRefusal = z.infer<typeof cloudRefusal>;

const cloudCodes: Record<string, CloudRefusal> = {
  CODE_CLOUD_DISABLED: "disabled", CODE_MANAGED_DISABLED: "disabled",
  CODE_CLOUD_CONCURRENCY_EXCEEDED: "concurrency", CODE_CLOUD_IDEMPOTENCY_CONFLICT: "conflict",
  CODE_CLOUD_JOB_NOT_FOUND: "notFound", CODE_ACCOUNT_UNAVAILABLE: "account", CODE_SIGN_IN_REQUIRED: "account", SIGNED_OUT: "account",
  CODE_CLOUD_BUNDLE_TOO_LARGE: "tooLarge", CODE_CLOUD_PATCH_UNAVAILABLE: "patchUnavailable",
};
export const cloudRefusalFor = (code: string | undefined): CloudRefusal => (code && cloudCodes[code]) || "unavailable";

/** How a job's failure reads: a managed refusal (credits, plan, catalogue) or one of the runner's own reasons. */
export type CloudFailure = { kind: "managed"; refusal: ManagedRefusal } | { kind: "runner"; reason: CloudFailureReason };
export type CloudFailureReason = "lost" | "time" | "queue" | "upload" | "agent" | "patchTooLarge" | "stopped" | "bundle" | "other";
const runnerReasons: Record<string, CloudFailureReason> = {
  CODE_CLOUD_RUNNER_LOST: "lost", CODE_CLOUD_TIME_LIMIT: "time", CODE_CLOUD_QUEUE_EXPIRED: "queue", CODE_CLOUD_UPLOAD_EXPIRED: "upload",
  CODE_CLOUD_PATCH_TOO_LARGE: "patchTooLarge", CODE_CLOUD_RUNNER_STOPPED: "stopped", CODE_CLOUD_BUNDLE_INVALID: "bundle",
};
export function cloudFailureFor(code: string | null): CloudFailure | null {
  if (!code) return null;
  if (runnerReasons[code]) return { kind: "runner", reason: runnerReasons[code] };
  if (code.startsWith("CODE_CLOUD_AGENT_")) return { kind: "runner", reason: "agent" };
  const managed = managedRefusalFor(code);
  return managed !== "unavailable" ? { kind: "managed", refusal: managed } : { kind: "runner", reason: "other" };
}

export type CloudJobStatus = "uploading" | "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export type CloudJobItem = {
  jobId: string;
  status: CloudJobStatus;
  instruction: string;
  executorModelId: string;
  approvedCredits: number;
  cancelRequested: boolean;
  failureCode: string | null;
  summary: string | null;
  billing: { reservedCredits: number; settledCredits: number; releasedCredits: number; heldCredits: number } | null;
  patchBytes: number | null;
  logs: Array<{ seq: number; text: string }>;
  createdAt: string;
  finishedAt: string | null;
};
export const cloudJobActive = (status: CloudJobStatus) => status !== "completed" && status !== "failed" && status !== "cancelled";

export type CloudReview = {
  jobId: string;
  files: ReviewFile[];
  truncated: boolean;
  /** Whether `git apply --check` accepts the patch on the folder as it is now; null when it could not be asked. */
  applies: boolean | null;
};

export type CloudExecutionView = {
  /** The open project's folder name, or why there is none to run in the cloud. */
  project: { name: string } | { unavailable: "noProject" | "remoteProject" | "notGit" };
  /** null: not read yet. */
  catalog: { models: ManagedCodeModel[] } | null;
  jobs: CloudJobItem[];
  review: CloudReview | null;
  /** The result of the last action the person took. */
  notice: { kind: "started"; files: number; omitted: number } | { kind: "applied"; jobId: string } | { kind: "refused"; refusal: CloudRefusal } | null;
};
export const emptyCloudExecutionView: CloudExecutionView = { project: { unavailable: "noProject" }, catalog: null, jobs: [], review: null, notice: null };
