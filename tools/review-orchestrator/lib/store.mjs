import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./fsutil.mjs";
import { aggregate } from "./verdict.mjs";

/**
 * One directory per job. `job.json` is written once by `submit`; each
 * `slots/<n>.json` is written only by the daemon after that. A job directory
 * becomes visible by a single rename, so the daemon never sees half a job.
 *
 *   jobs/<id>/job.json
 *   jobs/<id>/slots/<n>.json
 *   jobs/<id>/reviews/<n>.txt          reviewer stdout
 *   jobs/<id>/reviews/<n>.stderr.txt
 */

const JOB_ID = /^r-\d{8}-\d{6}-[0-9a-f]{6}$/;

export const isJobId = (value) => typeof value === "string" && JOB_ID.test(value);

export function newJobId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `r-${stamp}-${randomBytes(3).toString("hex")}`;
}

export class Store {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.jobsDir = join(stateDir, "jobs");
    this.stagingDir = join(stateDir, "staging");
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.stagingDir, { recursive: true });
  }

  jobDir(id) {
    if (!isJobId(id)) throw new Error("job_id_invalid");
    return join(this.jobsDir, id);
  }

  stagingFor(id) {
    const dir = join(this.stagingDir, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  discardStaging(id) {
    rmSync(join(this.stagingDir, id), { recursive: true, force: true });
  }

  removeJob(id) {
    rmSync(this.jobDir(id), { recursive: true, force: true });
  }

  /** Publish a staged job: job.json plus queued slots, made visible by one rename. */
  publish(job) {
    const staging = this.stagingFor(job.id);
    writeJsonAtomic(join(staging, "job.json"), job);
    for (let index = 0; index < job.reviewers; index += 1) {
      writeJsonAtomic(join(staging, "slots", `${index}.json`), { index, status: "queued" });
    }
    mkdirSync(join(staging, "reviews"), { recursive: true });
    renameSync(staging, this.jobDir(job.id));
  }

  readJob(id) {
    const dir = this.jobDir(id);
    if (!existsSync(join(dir, "job.json"))) return null;
    const job = readJson(join(dir, "job.json"));
    const slots = readdirSync(join(dir, "slots"))
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => readJson(join(dir, "slots", name)))
      .sort((a, b) => a.index - b.index);
    return { job, slots };
  }

  /** Every job in submission order (ids sort by UTC timestamp). */
  listJobs() {
    return readdirSync(this.jobsDir)
      .filter(isJobId)
      .sort()
      .map((id) => this.readJob(id))
      .filter(Boolean);
  }

  readSlot(jobId, index) {
    return readJson(join(this.jobDir(jobId), "slots", `${index}.json`));
  }

  writeSlot(jobId, slot) {
    writeJsonAtomic(join(this.jobDir(jobId), "slots", `${slot.index}.json`), slot);
  }

  reviewPath(jobId, index, suffix = ".txt") {
    return join(this.jobDir(jobId), "reviews", `${index}${suffix}`);
  }
}

/** What `status` and `wait` print for one job. */
export function summarise({ job, slots }) {
  return {
    jobId: job.id,
    status: aggregate(slots),
    repo: job.repo,
    base: job.base,
    head: job.head,
    focus: job.focus ?? null,
    author: job.author,
    authorVendor: job.authorVendor,
    touchesContract: job.touchesContract,
    reviewerProviders: job.reviewerProviders ?? [],
    reviews: slots.map((slot) => ({
      slot: slot.index,
      requestedProvider: job.reviewerProviders?.[slot.index] ?? null,
      status: slot.status,
      provider: slot.provider ?? null,
      vendor: slot.vendor ?? null,
      verdict: slot.verdict ?? null,
      reason: slot.reason ?? null,
      findings: slot.findings ?? [],
    })),
  };
}
