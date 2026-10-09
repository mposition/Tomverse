/**
 * Reads the CI and release-lane rows of the QA-release digest from the
 * GitHub Actions API with the read-only token (docs/policy/qa-release-agent.md
 * sections 1 and 3).
 *
 * Only structured fields are read: run ids, job display names, conclusions,
 * step names and step conclusions. Log text is never fetched. A job is
 * identified by matching its display name against the `name:` template in
 * its workflow file (tests/qaReleaseCiCollectCore.test.mjs renders the
 * templates from the files), so a renamed job stops matching and is counted
 * rather than guessed.
 *
 * Each job contributes one row, from the newest run in the window that ran
 * it. Any failed read answers null: the digest then says GitHub could not be
 * read, instead of presenting an empty list as "no failures".
 *
 * Pure apart from the injected `fetchJson`.
 */

import { classifyQaReleaseCiFailure } from "./qaReleaseCiClassifyCore.ts";
import {
  QA_RELEASE_CI_JOBS,
  QA_RELEASE_CI_WORKFLOWS,
  QA_RELEASE_JOB_CONCLUSIONS,
  type QaReleaseDigest,
} from "./qaReleaseDigestSchemaCore.ts";

export const QA_RELEASE_REPOSITORY = "mposition/Tomverse";

/** How far back a run counts toward today's digest. */
export const QA_RELEASE_CI_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pages read per list before the collection is called incomplete. Runs come
 * newest first, so the run list stops at the first run older than the
 * window; a window that needs more pages than this is reported, not cut.
 */
export const QA_RELEASE_CI_MAX_PAGES = 10;
const PAGE_SIZE = 100;

type Workflow = (typeof QA_RELEASE_CI_WORKFLOWS)[number];

/**
 * Each job's display name as a pattern, written from the workflow files'
 * `name:` lines. A capture group, where present, is the matrix shard.
 */
export const QA_RELEASE_CI_JOB_NAMES: Readonly<Record<Workflow, readonly { job: string; name: RegExp }[]>> = Object.freeze({
  "e2e.yml": [
    { job: "playwright", name: /^Chromium regression \(shard ([1-9][0-9]?)\/[1-9][0-9]?\)$/ },
    { job: "regression", name: /^Chromium desktop and mobile regression$/ },
  ],
  "nightly-visual-regression.yml": [{ job: "visual-regression", name: /^Chat state visual regression goldens$/ }],
  "admin-console-e2e.yml": [{ job: "admin-console-e2e", name: /^Admin Console E2E \(PostgreSQL\)$/ }],
  "deployed-commit-drift.yml": [{ job: "drift", name: /^Deployed commit vs branch head$/ }],
  "back-merge-main-to-develop.yml": [
    { job: "back-merge", name: /^Back-merge main into develop$/ },
    { job: "verify", name: /^main is in develop's ancestry$/ },
  ],
});

/** The release-lane workflows and the step that is their existing notifier. */
const RELEASE_LANE: Partial<Record<Workflow, "drift" | "back-merge">> = {
  "deployed-commit-drift.yml": "drift",
  "back-merge-main-to-develop.yml": "back-merge",
};
export const QA_RELEASE_NOTIFIER_STEP = "Report the red lane";

type ApiRun = { id: number; created_at: string; status: string };
type ApiStep = { name: string; conclusion: string | null };
type ApiJob = { name: string; conclusion: string | null; steps?: ApiStep[] };

export type QaReleaseCiCollection = Pick<QaReleaseDigest, "ci" | "releaseLane"> & {
  /** Jobs whose display name matched no known pattern: a rename to look at. */
  unrecognizedJobs: number;
  /** A list needed more than QA_RELEASE_CI_MAX_PAGES pages. */
  truncated: boolean;
};

/** False when the read failed or the body was not the expected list. */
type Page<T> = { items: T[]; total: number } | false;

const isConclusion = (value: string | null): value is QaReleaseDigest["ci"][number]["jobConclusion"] =>
  value !== null && (QA_RELEASE_JOB_CONCLUSIONS as readonly string[]).includes(value);

const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

export async function collectQaReleaseCi(input: {
  fetchJson: (path: string) => Promise<unknown>;
  nowMs: number;
}): Promise<QaReleaseCiCollection | null> {
  const ci: QaReleaseDigest["ci"] = [];
  const releaseLane: QaReleaseDigest["releaseLane"] = [];
  let unrecognizedJobs = 0;
  let truncated = false;
  // One row per job: the newest run's. Runs are read newest first, so the
  // first row seen for a job is its latest conclusion; an hourly workflow
  // would otherwise fill the list with yesterday's repeats and overflow it.
  const seen = new Set<string>();

  const page = async <T>(path: string, key: "workflow_runs" | "jobs"): Promise<Page<T>> => {
    const body = (await input.fetchJson(path)) as Record<string, unknown> | null;
    const items = body?.[key];
    const total = body?.total_count;
    return Array.isArray(items) && typeof total === "number" ? { items: items as T[], total } : false;
  };

  try {
    for (const workflow of QA_RELEASE_CI_WORKFLOWS) {
      // Every completed run inside the window, newest first, across pages.
      const runs: ApiRun[] = [];
      let reachedOlder = false;
      for (let number = 1; number <= QA_RELEASE_CI_MAX_PAGES && !reachedOlder; number += 1) {
        const result = await page<ApiRun>(
          `/repos/${QA_RELEASE_REPOSITORY}/actions/workflows/${workflow}/runs?status=completed&per_page=${PAGE_SIZE}&page=${number}`,
          "workflow_runs",
        );
        if (result === false) return null;
        for (const run of result.items) {
          const created = Date.parse(run.created_at);
          if (!Number.isFinite(created)) return null;
          if (input.nowMs - created > QA_RELEASE_CI_WINDOW_MS) reachedOlder = true;
          else if (created <= input.nowMs) runs.push(run);
        }
        if (number * PAGE_SIZE >= result.total) reachedOlder = true;
        else if (number === QA_RELEASE_CI_MAX_PAGES && !reachedOlder) truncated = true;
      }

      for (const run of runs) {
        const jobs: ApiJob[] = [];
        for (let number = 1; ; number += 1) {
          const result = await page<ApiJob>(
            `/repos/${QA_RELEASE_REPOSITORY}/actions/runs/${run.id}/jobs?per_page=${PAGE_SIZE}&page=${number}`,
            "jobs",
          );
          if (result === false) return null;
          jobs.push(...result.items);
          if (number * PAGE_SIZE >= result.total) break;
          if (number === QA_RELEASE_CI_MAX_PAGES) {
            truncated = true;
            break;
          }
        }
        for (const apiJob of jobs) {
          if (!isConclusion(apiJob.conclusion)) continue; // still running, or a value GitHub added later
          // A skipped job did not run (a draft pull request skips e2e), so it
          // must not stand in as the job's latest result over an older one. A
          // job skipped because a job it needs failed is covered by that failed
          // job's own row in the same run.
          if (apiJob.conclusion === "skipped") continue;
          const match = QA_RELEASE_CI_JOB_NAMES[workflow]
            .map((entry) => ({ entry, found: entry.name.exec(apiJob.name) }))
            .find((candidate) => candidate.found !== null);
          if (!match || !(QA_RELEASE_CI_JOBS[workflow] as readonly string[]).includes(match.entry.job)) {
            unrecognizedJobs += 1;
            continue;
          }
          const shard = match.found?.[1] ? Number(match.found[1]) : null;
          const jobKey = `${workflow}|${match.entry.job}|${shard ?? ""}`;
          if (seen.has(jobKey)) continue;
          seen.add(jobKey);
          const steps = (apiJob.steps ?? []).map((step) => ({ name: step.name, conclusion: step.conclusion }));
          const lane = RELEASE_LANE[workflow];
          if (lane) {
            releaseLane.push({
              workflow: lane,
              runId: String(run.id),
              job: match.entry.job as "drift" | "back-merge" | "verify",
              jobConclusion: apiJob.conclusion,
              existingNotifierStepRan: steps.some(
                (step) => step.name === QA_RELEASE_NOTIFIER_STEP && step.conclusion === "success",
              ),
            });
            continue;
          }
          ci.push({
            workflow,
            runId: String(run.id),
            job: match.entry.job,
            shard,
            jobConclusion: apiJob.conclusion,
            // The JSON reporter history is a later slice; without it a test
            // failure stays undetermined, which creates no owner work.
            label: FAILED.has(apiJob.conclusion)
              ? classifyQaReleaseCiFailure({ jobConclusion: apiJob.conclusion, steps, failingTests: null })
              : null,
          });
        }
      }
    }
  } catch {
    return null;
  }
  return { ci, releaseLane, unrecognizedJobs, truncated };
}
