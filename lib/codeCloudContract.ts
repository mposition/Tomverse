import { z } from "zod";
import { CODE_MAX_OUTPUT_TOKENS } from "./codeManagedCore";

/**
 * Tomverse Desktop cloud execution (docs/ops/desktop-cloud-execution.md): the wire shapes the server, Desktop and the
 * runner service share. Free of Node and server imports so Desktop's main process can use the same schemas.
 *
 * A cloud job is one coding task run by the Tomverse CLI engine on a runner, against a snapshot of the person's
 * repository that Desktop uploaded as a git bundle. Model calls go through the managed Code reservation
 * (lib/codeManagedService.ts) unchanged: the reservation is the credit cap and settles each call. The result is a
 * patch the person reviews in Desktop and applies locally; nothing is pushed from the cloud.
 */

export const CODE_CLOUD_JOB_STATUSES = ["uploading", "queued", "starting", "running", "completed", "failed", "cancelled"] as const;
export type CodeCloudJobStatus = (typeof CODE_CLOUD_JOB_STATUSES)[number];
export const CODE_CLOUD_TERMINAL_STATUSES: readonly CodeCloudJobStatus[] = ["completed", "failed", "cancelled"];
export const codeCloudTerminal = (status: string) => (CODE_CLOUD_TERMINAL_STATUSES as readonly string[]).includes(status);

export const CODE_CLOUD_LIMITS = {
  // Both stay under the 10 MB request body the Next.js proxy buffers (proxyClientMaxBodySize, not set here): a larger
  // body would reach the route cut short. The patch travels as base64 inside the runner's finish request.
  /** A git bundle of the tracked files at the start of the task. */
  bundleMaxBytes: 8 * 1024 * 1024,
  /** The patch a finished job returns. */
  patchMaxBytes: 6 * 1024 * 1024,
  instructionMaxChars: 16_000,
  summaryMaxChars: 4_000,
  logLineMaxChars: 400,
  /** Lines kept on the job; older ones are dropped and the sequence number keeps counting. */
  logKeepLines: 400,
  /** Lines one runner heartbeat may carry. */
  logBatchLines: 50,
  /** The runner's claim on a job lasts this long without a heartbeat. */
  runnerLeaseMs: 90_000,
  runnerHeartbeatMs: 15_000,
  /** Wall-clock ceiling of one job from its start on a runner. */
  maxRuntimeMs: 60 * 60_000,
  /** A created job whose bundle has not arrived by then is failed. */
  uploadWindowMs: 15 * 60_000,
  /** A queued job no runner claimed by then is failed; a queued job holds no credits. */
  queueWindowMs: 30 * 60_000,
  /** How long a finished job, its logs and its patch are kept before the maintenance sweep deletes them. */
  retentionMs: 7 * 24 * 3_600_000,
} as const;

/** Object keys derive from the job id alone, so the job row is the tombstone for both objects. */
export const codeCloudBundleKey = (jobId: string) => `code-cloud/${jobId}/bundle`;
export const codeCloudPatchKey = (jobId: string) => `code-cloud/${jobId}/result.patch`;

const uuid = z.string().uuid();
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const codeCloudCreateSchema = z.object({
  action: z.literal("create"),
  /** Desktop's id for the task; creating it again with the same body returns the same job. */
  taskId: uuid,
  instruction: z.string().trim().min(1).max(CODE_CLOUD_LIMITS.instructionMaxChars),
  catalogVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentHash: z.string().min(1).max(128),
  executorModelId: modelId,
  reviewerModelId: modelId,
  approvedCredits: z.number().int().positive().max(1_000_000),
  bundleBytes: z.number().int().positive().max(CODE_CLOUD_LIMITS.bundleMaxBytes),
  bundleSha256: sha256,
  /** The snapshot commit inside the bundle; the patch applies to the files it holds. */
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict();
export type CodeCloudCreateRequest = z.infer<typeof codeCloudCreateSchema>;

export const codeCloudRequestSchema = z.discriminatedUnion("action", [
  codeCloudCreateSchema,
  z.object({ action: z.literal("status"), jobId: uuid, afterLog: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  z.object({ action: z.literal("cancel"), jobId: uuid }).strict(),
  z.object({ action: z.literal("list") }).strict(),
]);
export type CodeCloudRequest = z.infer<typeof codeCloudRequestSchema>;

const logLines = z.array(z.string().max(4_000)).max(CODE_CLOUD_LIMITS.logBatchLines);
export const CODE_CLOUD_FINISH_OUTCOMES = ["completed", "failed", "cancelled"] as const;

export const codeCloudRunnerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), runnerId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }).strict(),
  z.object({ action: z.literal("heartbeat"), jobId: uuid, logs: logLines }).strict(),
  z.object({
    action: z.literal("model"), jobId: uuid, callId: uuid,
    prompt: z.object({ system: z.string().min(1).max(65_536), user: z.string().min(1).max(786_432) }).strict(),
    schema: z.record(z.string(), z.unknown()),
    maxOutputTokens: z.number().int().positive().max(CODE_MAX_OUTPUT_TOKENS),
  }).strict(),
  z.object({
    action: z.literal("finish"), jobId: uuid, outcome: z.enum(CODE_CLOUD_FINISH_OUTCOMES),
    failureCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
    summary: z.string().max(CODE_CLOUD_LIMITS.summaryMaxChars).optional(),
    patchBase64: z.string().max(Math.ceil(CODE_CLOUD_LIMITS.patchMaxBytes / 3) * 4).optional(),
    patchSha256: sha256.optional(),
    logs: logLines.optional(),
  }).strict(),
]);
export type CodeCloudRunnerRequest = z.infer<typeof codeCloudRunnerRequestSchema>;

/** The receipt numbers of the job's managed reservation, as the server last saw them. Never computed by a client. */
export const codeCloudBilling = z.object({
  reservedCredits: z.number().int().nonnegative(), settledCredits: z.number().int().nonnegative(),
  releasedCredits: z.number().int().nonnegative(), heldCredits: z.number().int().nonnegative(),
  unknownHeldCredits: z.number().int().nonnegative(), availableCredits: z.number().int(),
});
export type CodeCloudBilling = z.infer<typeof codeCloudBilling>;

export const codeCloudJobView = z.object({
  jobId: uuid,
  taskId: uuid,
  status: z.enum(CODE_CLOUD_JOB_STATUSES),
  instruction: z.string(),
  executorModelId: z.string(),
  reviewerModelId: z.string(),
  approvedCredits: z.number().int(),
  cancelRequested: z.boolean(),
  failureCode: z.string().nullable(),
  summary: z.string().nullable(),
  billing: codeCloudBilling.nullable(),
  patch: z.object({ bytes: z.number().int().nonnegative(), sha256 }).nullable(),
  logs: z.array(z.object({ seq: z.number().int().positive(), text: z.string() })),
  logSeq: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type CodeCloudJobView = z.infer<typeof codeCloudJobView>;

/** Plain text a log line may hold: printable characters only, one line, bounded. */
export function cleanCloudLogLine(text: string) {
  const flat = text.replace(/\r\n?|\n/g, " ").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
  return flat.length > CODE_CLOUD_LIMITS.logLineMaxChars ? flat.slice(0, CODE_CLOUD_LIMITS.logLineMaxChars - 1) + "…" : flat;
}

/** A git bundle starts with its signature line (git-bundle(5)); anything else is refused before storage. */
export function looksLikeGitBundle(head: Uint8Array) {
  const text = new TextDecoder().decode(head.subarray(0, 16));
  return text === "# v2 git bundle\n" || text === "# v3 git bundle\n";
}
