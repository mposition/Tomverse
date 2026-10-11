import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeLoad, independentVendorCount, isName, planAssignments, resolveAuthorVendor } from "./assign.mjs";
import { requiredReviewers } from "./config.mjs";
import { withLock } from "./fsutil.mjs";
import { reviewerEnv } from "./env.mjs";
export { reviewerEnv } from "./env.mjs";
import {
  addWorktree,
  changedFiles,
  deleteReviewRef,
  diffText,
  ensureMirror,
  git,
  importBundle,
  instructionDiff,
  isolateInstructionFiles,
  removeWorktree,
  SHA,
} from "./git.mjs";
import { buildPrompt } from "./prompt.mjs";
import { consumeManualQuota } from "./quota.mjs";
import { Store, newJobId } from "./store.mjs";
import { parseReviewerOutput } from "./verdict.mjs";

export class UsageError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
  }
}

const mirrorLock = (config) => join(config.stateDir, "mirror.lock");

/**
 * Drain mode is a flag file in the state directory, so it survives a restart:
 * an update drains, waits for the running reviews, restarts, then lifts the
 * drain, and no review is cut off and closed as unknown.
 */
const drainFlag = (config) => join(config.stateDir, "drain");
export const isDraining = (config) => existsSync(drainFlag(config));
export function setDraining(config, on) {
  mkdirSync(config.stateDir, { recursive: true });
  if (on) writeFileSync(drainFlag(config), `${new Date().toISOString()}\n`);
  else rmSync(drainFlag(config), { force: true });
}

/**
 * Accept one review request. `bundlePath` is the client's git bundle already
 * written to disk. Everything is checked before the job becomes visible, so a
 * rejected submit leaves no job behind.
 */
/**
 * The optional focus commit: the reviewer is shown `focus..head` instead of
 * `base..head`, so a later round can be judged on what changed since the last
 * one. It narrows only what is shown. The base still decides the reviewer's
 * instruction files and the contract-path count, so it must lie strictly
 * between them: a descendant of base (or base) and a proper ancestor of head.
 */
function checkFocus(mirror, base, head, focus) {
  if (focus === undefined || focus === null || focus === "") return null;
  if (!SHA.test(focus)) throw new UsageError("focus_invalid", "focus must be a full commit SHA");
  if (focus === head) throw new UsageError("empty_focus", "focus is head itself");
  const isAncestor = (a, b) => git(["merge-base", "--is-ancestor", a, b], { cwd: mirror, allowFailure: true }).ok;
  if (!isAncestor(base, focus) || !isAncestor(focus, head)) {
    throw new UsageError("focus_not_in_range", "focus must be on the path from base to head");
  }
  return focus;
}

/**
 * Has a finished job on this server reviewed exactly up to `head`? Finished
 * means every slot returned a verdict (accept or reject): an unknown, a
 * cancellation or a pending slot is not a review.
 */
function reviewedHead(store, repoName, head) {
  return store
    .listJobs()
    .some(
      ({ job, slots }) =>
        job.repo === repoName &&
        job.head === head &&
        slots.length > 0 &&
        slots.every((slot) => slot.status === "done" && (slot.verdict === "accept" || slot.verdict === "reject")),
    );
}

function checkReviewerProviders(config, ids, authorVendor) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || !ids.every(isName)) {
    throw new UsageError("reviewer_providers_invalid", "pass one to three configured provider ids");
  }
  if (new Set(ids).size !== ids.length) throw new UsageError("reviewer_providers_duplicate");
  const vendors = new Set();
  for (const id of ids) {
    const provider = config.providers.find((p) => p.id === id);
    if (!provider || provider.enabled !== true) throw new UsageError("reviewer_unavailable", id);
    if (!isName(provider.vendor) || provider.vendor === "unknown" || provider.vendor === authorVendor) {
      throw new UsageError("reviewer_not_independent", id);
    }
    if (vendors.has(provider.vendor)) throw new UsageError("reviewer_vendors_duplicate", id);
    vendors.add(provider.vendor);
  }
  return [...ids];
}

export async function submitJob(config, request, bundlePath, { now = new Date() } = {}) {
  const { repo: repoName, base, head, author, authorVendor: statedVendor, scope } = request;
  const repo = config.repos[repoName];
  if (!repo) throw new UsageError("repo_unknown", repoName);
  if (!isName(author)) throw new UsageError("author_invalid");
  const authorVendor = resolveAuthorVendor(author, statedVendor);
  if (authorVendor === null) {
    throw new UsageError(
      "author_vendor_required",
      "pass --author-vendor with the vendor of the model the author ran (anthropic, openai, xai, ...)",
    );
  }
  const requested = request.reviewers ?? 1;
  if (!Number.isInteger(requested) || requested < 1 || requested > 3) {
    throw new UsageError("reviewers_invalid");
  }
  const reviewerProviders = checkReviewerProviders(config, request.reviewerProviders, authorVendor);
  if (statSync(bundlePath).size > config.maxBundleBytes) throw new UsageError("bundle_too_large");

  const store = new Store(config.stateDir);
  const id = newJobId(now);
  // Counting pending jobs and publishing this one happen under one lock, so
  // concurrent submits cannot all read the same count and all pass the cap.
  return withLock(mirrorLock(config), () => {
    const pending = store.listJobs().filter(({ slots }) => slots.some((slot) => slot.status !== "done")).length;
    if (pending >= config.maxPendingJobs) {
      throw new UsageError("queue_full", `${pending} jobs are still pending; wait for one to finish`);
    }
    let imported = false;
    try {
      ensureMirror(repo);
      importBundle({
        mirror: repo.mirror,
        bundlePath,
        bundleRef: request.bundleRef,
        jobId: id,
        base,
        head,
        trustedBaseRefs: config.trustedBaseRefs,
        maxChangeBytes: config.maxChangeBytes,
      });
      imported = true;
      const focus = checkFocus(repo.mirror, base, head, request.focus);
      const files = changedFiles(repo.mirror, base, head);
      if (files.length === 0) throw new UsageError("empty_change");
      const focusFiles = focus ? changedFiles(repo.mirror, focus, head) : files;
      if (focusFiles.length === 0) throw new UsageError("empty_focus", "focus..head changes no file");
      // The contract-path floor counts from the focus only when this server has
      // itself finished reviewing up to it. A focus nobody reviewed could hide a
      // contract change before it, so then the whole base..head range counts.
      const focusReviewed = focus !== null && reviewedHead(store, repoName, focus);
      const contractFiles = focusReviewed ? focusFiles : files;
      const { reviewers, touchesContract } = requiredReviewers(config, Math.max(requested, reviewerProviders.length), contractFiles);
      const available = independentVendorCount(config.providers, authorVendor);
      if (available < reviewers) {
        throw new UsageError(
          "insufficient_independent_reviewers",
          `needs ${reviewers} vendors other than ${authorVendor}, ${available} configured`,
        );
      }
      const job = {
        id,
        repo: repoName,
        base,
        head,
        focus,
        author,
        authorVendor,
        reviewers,
        reviewerProviders,
        touchesContract,
        scope: typeof scope === "string" ? scope.slice(0, 4000) : "",
        fileCount: files.length,
        focusFileCount: focusFiles.length,
        focusReviewed,
        submittedAt: now.getTime(),
      };
      store.publish(job);
      return { jobId: id, reviewers, reviewerProviders, touchesContract, fileCount: files.length, focus, focusFileCount: focusFiles.length };
    } catch (error) {
      store.discardStaging(id);
      // A refused job leaves no review ref behind either.
      if (imported) deleteReviewRef(repo.mirror, id);
      throw error;
    }
  });
}

export function expandArgs(provider, workdir, promptFile = "", promptDir = "") {
  return provider.args.map((arg) =>
    arg
      .replaceAll("{workdir}", workdir)
      .replaceAll("{model}", provider.model ?? "")
      .replaceAll("{promptFile}", promptFile)
      .replaceAll("{promptDir}", promptDir),
  );
}

/**
 * A provider that names `{promptFile}` or `{promptDir}` in its args is given
 * the prompt as a file instead of on stdin. On Linux a spawned child's stdin
 * is a socket, not a pipe, so a CLI that reopens /dev/stdin by path fails with
 * ENXIO -- which is how Devin failed every review on 2026-10-02 while a
 * shell-pipe test passed. `{promptDir}` is the file's own directory, for a CLI
 * that takes its prompt only as an argument (too short for a review) and must
 * be granted that one directory to read the file from.
 */
export const usesPromptFile = (provider) =>
  provider.args.some((arg) => arg.includes("{promptFile}") || arg.includes("{promptDir}"));

/** The provider's own note, if any, goes before the shared prompt. */
export const promptForProvider = (provider, prompt) =>
  provider.promptNote ? `${provider.promptNote}\n\n${prompt}` : prompt;

/**
 * The scheduling loop. One instance per state directory (enforced by the
 * caller with a daemon lock). Children are tracked in memory only, so a slot
 * left `running` from a previous process is an unknown outcome: it is closed
 * as `unknown`, never re-run.
 */
export class Orchestrator {
  constructor(config, { now = () => Date.now(), log = () => {} } = {}) {
    this.config = config;
    this.store = new Store(config.stateDir);
    this.now = now;
    this.log = log;
    this.inflight = new Set();
    this.killers = new Set();
    this.workRoot = join(config.stateDir, "worktrees");
    mkdirSync(this.workRoot, { recursive: true });
  }

  /**
   * Remove finished jobs older than the retention period, with their review
   * refs, so neither the state directory nor the mirror grows without bound.
   */
  async prune() {
    const cutoff = this.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const expired = this.store
      .listJobs()
      // Retention runs from when the last review finished, not from submission:
      // a job that waited long must not vanish the moment it completes.
      .filter(
        ({ job, slots }) =>
          slots.every((slot) => slot.status === "done") &&
          Math.max(job.submittedAt, ...slots.map((slot) => slot.endedAt ?? job.submittedAt)) < cutoff,
      );
    for (const { job } of expired) {
      const repo = this.config.repos[job.repo];
      if (repo) await withLock(mirrorLock(this.config), () => deleteReviewRef(repo.mirror, job.id));
      this.store.removeJob(job.id);
    }
    if (expired.length > 0) this.log(`pruned ${expired.length} job(s) older than ${this.config.retentionDays} days`);
    return expired.length;
  }

  /**
   * Operator cancel: close every queued slot of a job as unknown. A running
   * slot is left to finish -- killing it would be an unknown outcome of its
   * own. Returns how many slots were closed.
   */
  cancel(jobId) {
    const entry = this.store.readJob(jobId);
    if (!entry) throw new UsageError("job_not_found");
    let closed = 0;
    for (const listed of entry.slots) {
      // Re-read right before writing: the daemon may have just started it.
      const slot = this.store.readSlot(jobId, listed.index);
      if (slot.status !== "queued") continue;
      this.store.writeSlot(jobId, { ...slot, status: "done", verdict: "unknown", reason: "cancelled_by_operator", findings: [], endedAt: this.now() });
      closed += 1;
    }
    return closed;
  }

  recoverOrphans() {
    let recovered = 0;
    for (const { job, slots } of this.store.listJobs()) {
      for (const slot of slots) {
        if (slot.status !== "running") continue;
        this.store.writeSlot(job.id, { ...slot, status: "done", verdict: "unknown", reason: "orchestrator_restarted", findings: [], endedAt: this.now() });
        recovered += 1;
      }
    }
    return recovered;
  }

  tick(quotas) {
    if (!quotas || typeof quotas !== "object") throw new Error("quota_snapshot_required");
    // Draining: start nothing new, let running reviews finish. Submits are still
    // accepted and wait in the queue until the drain is lifted.
    if (isDraining(this.config)) return [];
    const jobs = this.store.listJobs();
    const now = this.now();
    const decisions = planAssignments({
      jobs,
      providers: this.config.providers,
      load: computeLoad(jobs, now),
      now,
      // The daemon supplies a fresh account-specific snapshot each pass.
      // A missing, failed, or stale probe cannot authorize a new review.
      blockedProviders: new Set(this.config.providers
        .filter((provider) => quotas[provider.id]?.state !== "available")
        .map((provider) => provider.id)),
    });
    const byId = new Map(jobs.map((entry) => [entry.job.id, entry]));
    for (const decision of decisions) {
      const { job, slots } = byId.get(decision.jobId);
      const slot = slots.find((s) => s.index === decision.slot);
      if (decision.kind === "impossible") {
        this.store.writeSlot(job.id, { ...slot, status: "done", verdict: "unknown", reason: "no_eligible_reviewer", findings: [], endedAt: now });
        continue;
      }
      if (this.store.readSlot(job.id, slot.index).status !== "queued") continue;
      const provider = this.config.providers.find((p) => p.id === decision.provider);
      if (provider.quotaProbe === "manual" && !consumeManualQuota(this.config, provider.id, now)) continue;
      const running = { ...slot, status: "running", provider: provider.id, vendor: provider.vendor, assignedAt: now, startedAt: now };
      this.store.writeSlot(job.id, running);
      const task = this.runReview(job, running, provider).finally(() => this.inflight.delete(task));
      this.inflight.add(task);
      this.log(`assigned ${job.id}#${slot.index} -> ${provider.id}`);
    }
    return decisions;
  }

  /** Stop every running reviewer; their slots close as unknown on the next start. */
  killAll() {
    for (const kill of this.killers) kill();
  }

  async idle() {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Close a slot only if it is still the run this process started: a slot a
   * restart already closed as unknown stays unknown.
   */
  finish(job, slot, outcome) {
    const current = this.store.readSlot(job.id, slot.index);
    if (current.status !== "running" || current.assignedAt !== slot.assignedAt || current.provider !== slot.provider) {
      this.log(`ignored a late result for ${job.id}#${slot.index}`);
      return;
    }
    this.store.writeSlot(job.id, { ...slot, status: "done", ...outcome, endedAt: this.now() });
    this.log(`finished ${job.id}#${slot.index} ${outcome.verdict}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  async runReview(job, slot, provider) {
    const repo = this.config.repos[job.repo];
    const workdir = join(this.workRoot, `${job.id}-${slot.index}`);
    try {
      let prepared;
      try {
        prepared = await withLock(mirrorLock(this.config), () => {
          addWorktree(repo.mirror, workdir, job.head);
          isolateInstructionFiles(workdir, job.base, job.head);
          // Instruction-file edits are shown over the whole base..head range
          // even with a focus: the checkout holds their base version, so a
          // narrower range would hide an earlier edit from the reviewer entirely.
          const allFiles = changedFiles(repo.mirror, job.base, job.head);
          const instructions = instructionDiff(repo.mirror, job.base, job.head, allFiles);
          const from = job.focus ?? job.base;
          const files = job.focus ? changedFiles(repo.mirror, from, job.head) : allFiles;
          const diff = diffText(repo.mirror, from, job.head);
          return { files, instructions, diff };
        });
      } catch (error) {
        this.finish(job, slot, { verdict: "unknown", reason: "worktree_failed", findings: [] });
        this.log(`worktree failed for ${job.id}: ${error.message}`);
        return;
      }
      // An instruction-file change the reviewer cannot see in full cannot be
      // reviewed: the checkout holds the base version, so nothing else shows it.
      if (Buffer.byteLength(prepared.instructions.text, "utf8") > this.config.maxPromptDiffBytes) {
        this.finish(job, slot, { verdict: "unknown", reason: "instruction_diff_too_large", findings: [] });
        return;
      }
      const prompt = buildPrompt({ job, ...prepared, maxDiffBytes: this.config.maxPromptDiffBytes });
      const outcome = await this.spawnReviewer(job, slot, provider, workdir, prompt);
      this.finish(job, slot, outcome);
    } finally {
      await withLock(mirrorLock(this.config), () => removeWorktree(repo.mirror, workdir)).catch(() => {});
    }
  }

  spawnReviewer(job, slot, provider, workdir, prompt) {
    const timeoutMs = (provider.timeoutSeconds ?? this.config.timeoutSeconds) * 1000;
    const maxOutput = this.config.maxOutputBytes;
    return new Promise((resolve) => {
      const out = createWriteStream(this.store.reviewPath(job.id, slot.index));
      const err = createWriteStream(this.store.reviewPath(job.id, slot.index, ".stderr.txt"));
      const chunks = [];
      let size = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      const posix = process.platform !== "win32";
      let child;
      let timer;
      const kill = () => {
        try {
          if (posix) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
      const done = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.killers.delete(kill);
        if (promptDir) rmSync(promptDir, { recursive: true, force: true });
        out.end();
        err.end();
        resolve(outcome);
      };
      const text = promptForProvider(provider, prompt);
      // Outside the worktree, in a directory of its own (so `{promptDir}` grants
      // this job's prompt and nothing else), owner-only, removed at the end.
      const promptDir = usesPromptFile(provider)
        ? join(this.config.stateDir, "prompts", `${job.id}-${slot.index}`)
        : null;
      const promptFile = promptDir ? join(promptDir, "prompt.md") : null;
      if (promptFile) {
        try {
          mkdirSync(join(this.config.stateDir, "prompts"), { recursive: true, mode: 0o700 });
          // A directory left by a crashed run is stale: start from empty.
          rmSync(promptDir, { recursive: true, force: true });
          mkdirSync(promptDir, { mode: 0o700 });
          writeFileSync(promptFile, text, { mode: 0o600 });
        } catch (error) {
          // A slot must always be closed; a throw here would leave it running.
          this.log(`prompt file failed: ${error.message}`);
          done({ verdict: "unknown", reason: "prompt_file_failed", findings: [] });
          return;
        }
      }
      try {
        child = spawn(provider.command, expandArgs(provider, workdir, promptFile ?? "", promptDir ?? ""), {
          cwd: workdir,
          env: reviewerEnv(provider),
          stdio: [promptFile ? "ignore" : "pipe", "pipe", "pipe"],
          detached: posix,
        });
      } catch (error) {
        done({ verdict: "unknown", reason: "reviewer_spawn_failed", findings: [] });
        this.log(`spawn failed: ${error.message}`);
        return;
      }
      this.killers.add(kill);
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxOutput) {
          overflow = true;
          kill();
          return;
        }
        chunks.push(chunk);
        out.write(chunk);
      });
      let stderrSize = 0;
      child.stderr.on("data", (chunk) => {
        // stderr is diagnostic only; keep the head of it and drop the rest.
        if (stderrSize >= this.config.maxStderrBytes) return;
        const room = this.config.maxStderrBytes - stderrSize;
        err.write(chunk.length > room ? chunk.subarray(0, room) : chunk);
        stderrSize += Math.min(chunk.length, room);
      });
      child.on("error", () => done({ verdict: "unknown", reason: "reviewer_spawn_failed", findings: [] }));
      child.on("close", (code) => {
        if (timedOut) return done({ verdict: "unknown", reason: "timeout", findings: [] });
        if (overflow) return done({ verdict: "unknown", reason: "output_too_large", findings: [] });
        if (code !== 0) return done({ verdict: "unknown", reason: `reviewer_exit_${code}`, findings: [] });
        done(parseReviewerOutput(Buffer.concat(chunks).toString("utf8")));
      });
      if (!promptFile) {
        child.stdin.on("error", () => {});
        child.stdin.end(text);
      }
    });
  }
}
