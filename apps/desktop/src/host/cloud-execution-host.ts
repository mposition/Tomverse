import { randomUUID } from "node:crypto";
import { CODE_CLOUD_LIMITS, type CodeCloudJobView } from "../../../../lib/codeCloudContract";
import {
  cloudJobActive, cloudRefusalFor,
  type CloudExecutionView, type CloudJobItem, type CloudRefusal, type CloudReview, type DesktopCloudExecutionInput,
} from "../cloud-execution-contract";
import type { ManagedCatalogSnapshot, ManagedCodeModel } from "../managed-code-contract";
import { applyPatch, createSnapshotBundle, patchApplies, type GitContext } from "./cloud-bundle";
import type { CloudExecutionClient, CloudOutcome } from "./cloud-execution-client";
import { MAX_REVIEW_FILES, parseUnifiedDiff } from "./review-diff";

export type CloudProject = { name: string; git: GitContext } | { unavailable: "noProject" | "remoteProject" | "notGit" };

/** The changed paths of a patch, read the way parseUnifiedDiff reads them: a header it cannot read stays unreadable. */
function patchPaths(text: string) {
  return text.split("\n").filter((line) => line.startsWith("diff --git ")).flatMap((line) => {
    const rest = line.slice("diff --git ".length);
    const length = (rest.length - 5) / 2;
    const path = Number.isInteger(length) && length > 0 ? rest.slice(2, 2 + length) : "";
    return path && rest === `a/${path} b/${path}` ? [path] : [];
  });
}

const item = (job: CodeCloudJobView): CloudJobItem => ({
  jobId: job.jobId, status: job.status, instruction: job.instruction, executorModelId: job.executorModelId, approvedCredits: job.approvedCredits,
  cancelRequested: job.cancelRequested, failureCode: job.failureCode, summary: job.summary,
  billing: job.billing ? { reservedCredits: job.billing.reservedCredits, settledCredits: job.billing.settledCredits,
    releasedCredits: job.billing.releasedCredits, heldCredits: job.billing.heldCredits } : null,
  patchBytes: job.patch?.bytes ?? null, logs: job.logs.slice(-40), createdAt: job.createdAt, finishedAt: job.finishedAt,
});

/**
 * Cloud jobs of the signed-in account, kept in the main process. Starting one snapshots the open project's tracked files
 * (cloud-bundle.ts), creates the job and uploads the bundle; reading follows the server's state and progress lines;
 * reviewing downloads the patch and shows its files; applying writes it to the same folder, only after a review of
 * that patch and only when `git apply --check` accepts it on the folder as it is now.
 */
export function createCloudExecutionHost(deps: {
  client: CloudExecutionClient;
  catalog: () => Promise<CloudOutcome<ManagedCatalogSnapshot> | { kind: "refused"; reason?: unknown }>;
  project: () => Promise<CloudProject>;
  signal: AbortSignal;
}) {
  const jobs = new Map<string, CodeCloudJobView>();
  /** The folder each job started from, for this run of the app. A job from before a restart applies to the open folder. */
  const origins = new Map<string, string>();
  const patches = new Map<string, Buffer>();
  let catalog: { version: number; contentHash: string; models: ManagedCodeModel[] } | null = null;
  let review: CloudReview | null = null;
  let notice: CloudExecutionView["notice"] = null;
  let starting = false;
  /** Finished jobs whose last lines have been read; they are not asked about again. */
  const settled = new Set<string>();

  const refuse = (refusal: CloudRefusal) => { notice = { kind: "refused", refusal }; };
  const remember = (job: CodeCloudJobView) => {
    const prior = jobs.get(job.jobId);
    // Progress lines arrive after a sequence number; keep the ones already read.
    const logs = prior && job.logs.length && job.logs[0]!.seq > (prior.logs.at(-1)?.seq ?? 0) ? [...prior.logs, ...job.logs]
      : job.logs.length ? job.logs : prior?.logs ?? [];
    jobs.set(job.jobId, { ...job, logs: logs.slice(-CODE_CLOUD_LIMITS.logKeepLines) });
  };

  async function view(): Promise<CloudExecutionView> {
    const project = await deps.project();
    return {
      project: "name" in project ? { name: project.name } : { unavailable: project.unavailable },
      catalog: catalog ? { models: catalog.models } : null,
      jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(item),
      review, notice,
    };
  }

  async function readCatalog() {
    const answer = await deps.catalog();
    if (answer.kind !== "ok") return;
    const value = answer.value as ManagedCatalogSnapshot;
    catalog = { version: value.version, contentHash: value.contentHash, models: value.models
      .filter((row) => row.channels.includes("code") && row.capabilities.structuredOutput !== "none")
      .map((row) => ({ id: row.modelId, name: row.name, provider: row.provider, minimumPlan: row.minimumPlan })) };
  }

  async function read() {
    if (!catalog) await readCatalog();
    const listed = await deps.client.list();
    if (listed.kind === "ok") for (const job of listed.value.jobs) if (!jobs.has(job.jobId) || jobs.get(job.jobId)!.status !== job.status) remember({ ...job, logs: [] });
    for (const job of [...jobs.values()].filter((row) => cloudJobActive(row.status) || !settled.has(row.jobId))) {
      const status = await deps.client.status(job.jobId, job.logs.at(-1)?.seq ?? 0);
      if (status.kind !== "ok") continue;
      remember(status.value);
      if (!cloudJobActive(status.value.status)) settled.add(job.jobId);
    }
  }

  async function start(input: Extract<DesktopCloudExecutionInput, { action: "start" }>) {
    if (starting) return;
    const project = await deps.project();
    if (!("name" in project)) return refuse(project.unavailable);
    if (!catalog) await readCatalog();
    if (!catalog) return refuse("unavailable");
    const names = new Set(catalog.models.map((model) => model.id));
    if (!names.has(input.executorModelId) || !names.has(input.reviewerModelId)) return refuse("unavailable");
    starting = true;
    try {
      const snapshot = await createSnapshotBundle(project.git, CODE_CLOUD_LIMITS.bundleMaxBytes);
      deps.signal.throwIfAborted();
      if ("failure" in snapshot) return refuse(snapshot.failure);
      const body = { taskId: randomUUID(), instruction: input.instruction, catalogVersion: catalog.version, contentHash: catalog.contentHash,
        executorModelId: input.executorModelId, reviewerModelId: input.reviewerModelId, approvedCredits: input.approvedCredits,
        bundleBytes: snapshot.bytes.byteLength, bundleSha256: snapshot.sha256, baseCommit: snapshot.baseCommit };
      // Both requests are idempotent (the same task id and body, the same bundle), so one more try after no answer is safe.
      let created = await deps.client.create(body);
      if (created.kind === "unreachable") created = await deps.client.create(body);
      if (created.kind !== "ok") return refuse(created.kind === "unreachable" ? "unreachable" : cloudRefusalFor(created.code));
      origins.set(created.value.jobId, project.git.root);
      remember(created.value);
      let uploaded = await deps.client.upload(created.value.jobId, snapshot.bytes);
      if (uploaded.kind === "unreachable") uploaded = await deps.client.upload(created.value.jobId, snapshot.bytes);
      if (uploaded.kind !== "ok") return refuse(uploaded.kind === "unreachable" ? "unreachable" : cloudRefusalFor(uploaded.code));
      remember(uploaded.value);
      notice = { kind: "started", files: snapshot.files, omitted: snapshot.omitted };
    } finally {
      starting = false;
    }
  }

  async function projectFor(jobId: string): Promise<{ refusal: CloudRefusal } | { refusal: null; project: Extract<CloudProject, { name: string }> }> {
    const project = await deps.project();
    if (!("name" in project)) return { refusal: project.unavailable };
    const origin = origins.get(jobId);
    if (origin && origin !== project.git.root) return { refusal: "otherProject" };
    return { refusal: null, project };
  }

  async function showReview(jobId: string) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "completed" || !job.patch) return refuse("patchUnavailable");
    const target = await projectFor(jobId);
    if (target.refusal !== null) return refuse(target.refusal);
    const patch = await deps.client.patch(job);
    if (patch.kind !== "ok") return refuse(patch.kind === "unreachable" ? "unreachable" : "patchUnavailable");
    patches.set(jobId, patch.value);
    const text = patch.value.toString("utf8");
    const files = parseUnifiedDiff(text, patchPaths(text));
    // A patch with a file the panel cannot name, or more files than it shows, is not offered for applying: the person
    // would be approving changes they could not see.
    const shown = !files.some((file) => file.omitted === "unreadable") && files.length <= MAX_REVIEW_FILES && files.length === patchPaths(text).length &&
      files.length === text.split("\n").filter((line) => line.startsWith("diff --git ")).length;
    review = { jobId, files: files.slice(0, MAX_REVIEW_FILES), truncated: files.length > MAX_REVIEW_FILES,
      applies: shown ? await patchApplies(target.project.git, patch.value).catch(() => null) : false };
    notice = null;
  }

  async function apply(jobId: string) {
    const patch = patches.get(jobId);
    // Only the patch the person was shown, on the folder it was checked against, when every file of it was shown.
    if (!patch || review?.jobId !== jobId || review.applies !== true) return refuse("patchUnavailable");
    const target = await projectFor(jobId);
    if (target.refusal !== null) return refuse(target.refusal);
    const result = await applyPatch(target.project.git, patch);
    if (result !== "applied") return refuse(result === "conflict" ? "applyConflict" : "applyFailed");
    review = null;
    patches.delete(jobId);
    notice = { kind: "applied", jobId };
  }

  async function run(input: DesktopCloudExecutionInput): Promise<CloudExecutionView> {
    if (input.action === "read") await read();
    else if (input.action === "start") await start(input);
    else if (input.action === "cancel") {
      const answer = await deps.client.cancel(input.jobId);
      if (answer.kind === "ok") remember(answer.value);
      else refuse(answer.kind === "unreachable" ? "unreachable" : cloudRefusalFor(answer.code));
    } else if (input.action === "review") await showReview(input.jobId);
    else if (input.action === "apply") await apply(input.jobId);
    else { review = null; notice = null; }
    deps.signal.throwIfAborted();
    return view();
  }

  return { run };
}

export type CloudExecutionHost = ReturnType<typeof createCloudExecutionHost>;
