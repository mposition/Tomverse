import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeLoad, eligibleProviders, independentVendorCount, isName, planAssignments, resolveAuthorVendor } from "./assign.mjs";
import { requiredReviewers } from "./config.mjs";
import { withLock } from "./fsutil.mjs";
import { reviewerEnv } from "./env.mjs";
export { reviewerEnv } from "./env.mjs";
import {
  addWorktree,
  changedFiles,
  deleteReviewRef,
  ensureMirror,
  git,
  importBundle,
  instructionDiff,
  isolateInstructionFiles,
  removeWorktree,
  SHA,
  writeReviewDiff,
} from "./git.mjs";
import { antigravityAnswer, antigravityStdin } from "./antigravity.mjs";
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
 * drain, and no review is cut off and run again from the start.
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

/** Vendors to prefer not to use for this job: names only, a preference, never an error for an unknown vendor. */
function checkAvoidVendors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || !value.every(isName) ||
      new Set(value).size !== value.length) {
    throw new UsageError("avoid_vendors_invalid", "pass one to four vendor names");
  }
  return [...value];
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
  const avoidVendors = checkAvoidVendors(request.avoidVendors);
  if (statSync(bundlePath).size > config.maxBundleBytes) throw new UsageError("bundle_too_large");

  const store = new Store(config.stateDir);
  const id = newJobId(now);
  // The queue has no length cap: a submit always waits its turn.
  return withLock(mirrorLock(config), () => {
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
        ...(avoidVendors.length > 0 ? { avoidVendors } : {}),
        touchesContract,
        scope: typeof scope === "string" ? scope : "",
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
 * A failed run is retried, never ended as unknown (owner decision 2026-11-16).
 * The first group says nothing about the change under review, only that this
 * vendor could not answer; the second is a local fault of this host. Both go
 * back to the queue.
 */
// `reviewer_could_not_review`: the reviewer said it could not read the change
// (verdict "unknown"), which says nothing about the change either.
const VENDOR_FAILURES = /^(timeout|output_too_large|reviewer_spawn_failed|reviewer_exit_.+|reviewer_could_not_review)$/;
const LOCAL_FAILURES = new Set(["worktree_failed", "prompt_file_failed"]);

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

/** Wait before a slot is tried again once every vendor has failed it: 1, 2, 4 ... up to 30 minutes. */
export const retryDelayMs = (attempts) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/**
 * The scheduling loop. One instance per state directory (enforced by the
 * caller with a daemon lock). Children are tracked in memory only, so a slot
 * left `running` from a previous process goes back to the queue.
 */
export class Orchestrator {
  constructor(config, { now = () => Date.now(), log = () => {} } = {}) {
    this.config = config;
    this.store = new Store(config.stateDir);
    this.now = now;
    this.log = log;
    this.inflight = new Set();
    this.killers = new Set();
    this.stopping = false;
    this.waitingLogged = new Set();
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

  /**
   * A slot left `running` by a previous process was cut off by the restart, not
   * answered: it goes back to the queue as it was (no vendor is blamed, no
   * delay), and runs again from the start.
   */
  recoverOrphans() {
    let recovered = 0;
    for (const { job, slots } of this.store.listJobs()) {
      for (const slot of slots) {
        if (slot.status !== "running") continue;
        this.requeueSlot(job.id, slot, { retriedAfter: "orchestrator_restarted" });
        recovered += 1;
      }
    }
    return recovered;
  }

  /** The slot as a fresh queued one, keeping only what steers its next assignment. */
  requeueSlot(jobId, slot, { retriedAfter, excludeVendors = slot.excludeVendors ?? [], attempts = slot.attempts ?? 0, delayMs = 0 }) {
    this.store.writeSlot(jobId, {
      index: slot.index,
      status: "queued",
      excludeVendors,
      retriedAfter,
      attempts,
      ...(delayMs > 0 ? { notBefore: this.now() + delayMs } : {}),
    });
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
        // A retried slot whose exclusions left it no vendor -- the one it was
        // waiting for went to another slot of the job -- would wait for good.
        // Its exclusions are dropped and it waits its backoff, then goes round
        // the vendors again (review r-20261116-223613-55be3b).
        if ((slot.excludeVendors ?? []).length > 0 && slot.status === "queued") {
          const attempts = slot.attempts ?? 1;
          this.requeueSlot(job.id, slot, { retriedAfter: slot.retriedAfter ?? "no_alternative",
            excludeVendors: [], attempts, delayMs: retryDelayMs(attempts) });
          this.log(`no vendor left for ${job.id}#${slot.index}; exclusions dropped, retried in ${Math.round(retryDelayMs(attempts) / 1000)}s`);
          continue;
        }
        // Nobody can take this slot right now (a provider was disabled, a
        // vendor's quota is spent): it waits in the queue for a later pass.
        const key = `${job.id}#${slot.index}`;
        if (!this.waitingLogged.has(key)) {
          this.waitingLogged.add(key);
          this.log(`no eligible reviewer for ${key}; waiting in the queue`);
        }
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

  /** Stop every running reviewer; their slots go back to the queue. */
  killAll() {
    this.stopping = true;
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
    // A reviewer cut off by this daemon's own shutdown did not answer.
    if (this.stopping && outcome.verdict === "unknown") {
      this.requeueSlot(job.id, slot, { retriedAfter: "orchestrator_restarted" });
      this.log(`stopped ${job.id}#${slot.index}; back in the queue`);
      return;
    }
    // A reviewer that failed to answer is not the answer (owner decisions
    // 2026-11-15 and 2026-11-16): the slot goes back to the queue.
    if (outcome.verdict === "unknown" && this.requeueFailed(job, slot, outcome.reason)) return;
    this.store.writeSlot(job.id, { ...slot, status: "done", ...outcome, endedAt: this.now() });
    this.log(`finished ${job.id}#${slot.index} ${outcome.verdict}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  /**
   * Queue a failed slot again. A vendor failure excludes every vendor that
   * already failed on the slot and every vendor another slot of the job uses,
   * so the next try goes to a vendor that has not failed it yet. When none is
   * left the exclusions are dropped and the slot waits, longer each time
   * (`retryDelayMs`), then goes round the vendors again. A local fault blames
   * no vendor and only waits. An operator-pinned slot names its reviewer and
   * waits for that one. Returns false for a reason that is an answer.
   */
  requeueFailed(job, slot, reason) {
    const local = LOCAL_FAILURES.has(reason);
    if (!local && !VENDOR_FAILURES.test(reason ?? "")) return false;
    const entry = this.store.readJob(job.id);
    if (!entry) return false;
    const attempts = (slot.attempts ?? 0) + 1;
    let excludeVendors = slot.excludeVendors ?? [];
    let delayMs = retryDelayMs(attempts);
    if (!local && job.reviewerProviders?.[slot.index] === undefined) {
      const tried = [...new Set([...excludeVendors, slot.vendor].filter(Boolean))];
      // Another slot's vendor, and the vendor an operator-pinned slot holds
      // even before it runs (planAssignments reserves it): neither is an
      // alternative for this slot (review r-20261116-215201-35d854).
      const pinned = (job.reviewerProviders ?? []).flatMap((id, index) => index === slot.index ||
        id === undefined ? [] : [this.config.providers.find((provider) => provider.id === id)?.vendor])
        .filter(Boolean);
      const usedElsewhere = [...entry.slots.filter((other) => other.index !== slot.index && other.vendor)
        .map((other) => other.vendor), ...pinned];
      const untried = eligibleProviders(this.config.providers, job.authorVendor)
        .some((provider) => !tried.includes(provider.vendor) && !usedElsewhere.includes(provider.vendor));
      if (untried) {
        excludeVendors = tried;
        delayMs = 0;
      } else {
        excludeVendors = [];
      }
    }
    this.requeueSlot(job.id, slot, { retriedAfter: reason, excludeVendors, attempts, delayMs });
    this.log(`failed ${job.id}#${slot.index} on ${slot.vendor} (${reason}); queued again${excludeVendors.length > 0 ? ` (not ${excludeVendors.join(", ")})` : ""}${delayMs > 0 ? ` in ${Math.round(delayMs / 1000)}s` : ""}`);
    return true;
  }

  async runReview(job, slot, provider) {
    const repo = this.config.repos[job.repo];
    const workdir = join(this.workRoot, `${job.id}-${slot.index}`);
    try {
      let prepared;
      try {
        prepared = await withLock(mirrorLock(this.config), () => {
          // A run a restart cut off may have left its checkout behind.
          removeWorktree(repo.mirror, workdir);
          rmSync(workdir, { recursive: true, force: true });
          addWorktree(repo.mirror, workdir, job.head);
          isolateInstructionFiles(workdir, job.base, job.head);
          // Instruction-file edits are shown over the whole base..head range
          // even with a focus: the checkout holds their base version, so a
          // narrower range would hide an earlier edit from the reviewer entirely.
          const allFiles = changedFiles(repo.mirror, job.base, job.head);
          const instructions = instructionDiff(repo.mirror, job.base, job.head, allFiles);
          const from = job.focus ?? job.base;
          const files = job.focus ? changedFiles(repo.mirror, from, job.head) : allFiles;
          const diffFile = writeReviewDiff(repo.mirror, workdir, from, job.head);
          return { files, instructions, diffFile };
        });
      } catch (error) {
        this.finish(job, slot, { verdict: "unknown", reason: "worktree_failed", findings: [] });
        this.log(`worktree failed for ${job.id}: ${error.message}`);
        return;
      }
      // The instruction-file diff is shown whole in the prompt (the checkout
      // holds their base version); the whole diff is a file in the checkout.
      const prompt = buildPrompt({ job, ...prepared });
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
      // An event-stream CLI (agy) keeps its raw stream beside the review; the
      // review file gets only its final answer, as for every other reviewer.
      const eventStream = provider.io === "antigravity-stream-json";
      const raw = eventStream ? createWriteStream(this.store.reviewPath(job.id, slot.index, ".stream.jsonl")) : null;
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
        raw?.end();
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
        (raw ?? out).write(chunk);
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
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (!eventStream) return done(parseReviewerOutput(stdout));
        const answer = antigravityAnswer(stdout);
        if (answer.text === undefined) return done({ verdict: "unknown", reason: answer.reason, findings: [] });
        out.write(answer.text);
        done(parseReviewerOutput(answer.text));
      });
      if (!promptFile) {
        child.stdin.on("error", () => {});
        child.stdin.end(eventStream ? antigravityStdin(text) : text);
      }
    });
  }
}
