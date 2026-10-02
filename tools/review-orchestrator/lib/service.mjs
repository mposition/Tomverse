import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeLoad, independentVendorCount, isName, planAssignments, resolveAuthorVendor } from "./assign.mjs";
import { requiredReviewers } from "./config.mjs";
import { withLock } from "./fsutil.mjs";
import { addWorktree, changedFiles, diffText, ensureMirror, importBundle, removeWorktree } from "./git.mjs";
import { buildPrompt } from "./prompt.mjs";
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
 * Accept one review request. `bundlePath` is the client's git bundle already
 * written to disk. Everything is checked before the job becomes visible, so a
 * rejected submit leaves no job behind.
 */
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
  if (statSync(bundlePath).size > config.maxBundleBytes) throw new UsageError("bundle_too_large");

  const store = new Store(config.stateDir);
  const id = newJobId(now);
  try {
    const files = await withLock(mirrorLock(config), () => {
      ensureMirror(repo);
      importBundle({ mirror: repo.mirror, bundlePath, jobId: id, base, head });
      return changedFiles(repo.mirror, base, head);
    });
    if (files.length === 0) throw new UsageError("empty_change");
    const { reviewers, touchesContract } = requiredReviewers(config, requested, files);
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
      author,
      authorVendor,
      reviewers,
      touchesContract,
      scope: typeof scope === "string" ? scope.slice(0, 4000) : "",
      fileCount: files.length,
      submittedAt: now.getTime(),
    };
    store.publish(job);
    return { jobId: id, reviewers, touchesContract, fileCount: files.length };
  } catch (error) {
    store.discardStaging(id);
    throw error;
  }
}

/** Environment a reviewer process gets: an allowlist, never the daemon's own. */
export function reviewerEnv(provider, source = process.env) {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SYSTEMROOT", "USERPROFILE", "APPDATA",
    "LOCALAPPDATA", ...(provider.passEnv ?? [])];
  const env = {};
  for (const name of names) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

export function expandArgs(provider, workdir) {
  return provider.args.map((arg) => arg.replaceAll("{workdir}", workdir).replaceAll("{model}", provider.model ?? ""));
}

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

  tick() {
    const jobs = this.store.listJobs();
    const now = this.now();
    const decisions = planAssignments({
      jobs,
      providers: this.config.providers,
      load: computeLoad(jobs, now),
      now,
    });
    const byId = new Map(jobs.map((entry) => [entry.job.id, entry]));
    for (const decision of decisions) {
      const { job, slots } = byId.get(decision.jobId);
      const slot = slots.find((s) => s.index === decision.slot);
      if (decision.kind === "impossible") {
        this.store.writeSlot(job.id, { ...slot, status: "done", verdict: "unknown", reason: "no_eligible_reviewer", findings: [], endedAt: now });
        continue;
      }
      const provider = this.config.providers.find((p) => p.id === decision.provider);
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

  finish(job, slot, outcome) {
    this.store.writeSlot(job.id, { ...slot, status: "done", ...outcome, endedAt: this.now() });
    this.log(`finished ${job.id}#${slot.index} ${outcome.verdict}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  async runReview(job, slot, provider) {
    const repo = this.config.repos[job.repo];
    const workdir = join(this.workRoot, `${job.id}-${slot.index}`);
    let prompt;
    try {
      prompt = await withLock(mirrorLock(this.config), () => {
        addWorktree(repo.mirror, workdir, job.head);
        const files = changedFiles(repo.mirror, job.base, job.head);
        const diff = diffText(repo.mirror, job.base, job.head);
        return buildPrompt({ job, files, diff, maxDiffBytes: this.config.maxPromptDiffBytes });
      });
    } catch (error) {
      this.finish(job, slot, { verdict: "unknown", reason: "worktree_failed", findings: [] });
      this.log(`worktree failed for ${job.id}: ${error.message}`);
      return;
    }
    try {
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
        out.end();
        err.end();
        resolve(outcome);
      };
      try {
        child = spawn(provider.command, expandArgs(provider, workdir), {
          cwd: workdir,
          env: reviewerEnv(provider),
          stdio: ["pipe", "pipe", "pipe"],
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
      child.stderr.on("data", (chunk) => err.write(chunk));
      child.on("error", () => done({ verdict: "unknown", reason: "reviewer_spawn_failed", findings: [] }));
      child.on("close", (code) => {
        if (timedOut) return done({ verdict: "unknown", reason: "timeout", findings: [] });
        if (overflow) return done({ verdict: "unknown", reason: "output_too_large", findings: [] });
        if (code !== 0) return done({ verdict: "unknown", reason: `reviewer_exit_${code}`, findings: [] });
        done(parseReviewerOutput(Buffer.concat(chunks).toString("utf8")));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
}
