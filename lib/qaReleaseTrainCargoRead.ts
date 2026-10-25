import "server-only";

import {
  QA_RELEASE_TRAIN_CANDIDATE_DAYS,
  QA_RELEASE_TRAIN_CARGO_MAX,
  qaReleaseTrainCargoCandidates,
  type QaReleaseTrainCargoCandidate,
} from "@/lib/qaReleaseTrainCargoCore";
import { createGithubRepoReader, githubReadFailure } from "@/lib/githubRepoRead";

/**
 * Reads the next train's candidates for Admin (lib/qaReleaseTrainCargoCore.ts),
 * GitHub through lib/githubRepoRead.ts. One read is kept for ten minutes and
 * shared by every viewer; each main pull request's commits are read to learn
 * what it carries, and files only for pull requests that could ride. A failed read is "unread" with why, never "none", and is kept for a
 * minute so a page left open does not spend the hourly allowance retrying.
 */
const CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
/** A Refresh newer than this reuses the read just made. */
const FRESH_MIN_MS = 30 * 1000;
const FILE_READS_AT_ONCE = 6;
/** GitHub lists at most 250 commits of a pull request. */
const COMMIT_PAGE_CAP = 3;

export type QaReleaseTrainCargoCandidatesRead =
  | { status: "ok"; readAt: string; candidates: QaReleaseTrainCargoCandidate[] }
  | { status: "unread"; failure: string };

/**
 * Closed pull requests into `base`, newest update first, page by page until
 * the window is covered: a pull request merged in the window was updated in
 * it too. One page held only four of fourteen days on 2026-10-23 (#2761 fell
 * off). A list the page cap cuts short is unread, never partial: a missing
 * main release would offer what it already carried.
 */
const PAGE_CAP = 8;
async function readClosedSince(readJson: (path: string) => Promise<unknown>, base: string, sinceMs: number): Promise<unknown[]> {
  const pulls: unknown[] = [];
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const list = await readJson(`/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error("github_shape");
    pulls.push(...list);
    const last = list[list.length - 1] as { updated_at?: unknown } | undefined;
    if (list.length < 100 || (typeof last?.updated_at === "string" && Date.parse(last.updated_at) < sinceMs)) return pulls;
  }
  throw new Error("github_pages");
}

/** A pull request's commits, or null when not all of them could be read. */
async function readCommits(
  readJson: (path: string) => Promise<unknown>,
  number: number,
): Promise<{ sha: string; message: string; merge: boolean }[] | null> {
  try {
    const commits: { sha: string; message: string; merge: boolean }[] = [];
    for (let page = 1; page <= COMMIT_PAGE_CAP; page += 1) {
      const list = await readJson(`/pulls/${number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(list)) return null;
      for (const item of list) {
        const commit = item as { sha?: unknown; parents?: unknown; commit?: { message?: unknown } };
        commits.push({
          sha: String(commit.sha ?? ""),
          message: String(commit.commit?.message ?? ""),
          merge: Array.isArray(commit.parents) && commit.parents.length > 1,
        });
      }
      if (list.length < 100) return commits;
    }
    return null;
  } catch {
    return null;
  }
}

/** Runs `work` for every item, FILE_READS_AT_ONCE at a time. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += FILE_READS_AT_ONCE) {
    await Promise.all(items.slice(index, index + FILE_READS_AT_ONCE).map(work));
  }
}

let cached: { atMs: number; value: QaReleaseTrainCargoCandidatesRead } | null = null;

/**
 * The candidates, from the shared read while it is fresh enough. `fresh` (the
 * overview's Refresh) reads GitHub again unless a read is under
 * FRESH_MIN_MS old, so several operators pressing it spend one read.
 */
export async function readQaReleaseTrainCargoCandidates(
  nowMs = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<QaReleaseTrainCargoCandidatesRead> {
  const keepMs = options.fresh ? FRESH_MIN_MS : cached?.value.status === "ok" ? CACHE_MS : FAILURE_CACHE_MS;
  if (cached && nowMs - cached.atMs < keepMs) return cached.value;
  const readJson = createGithubRepoReader();
  try {
    const sinceMs = nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
    const [mergedDevelopJson, mergedMainJson, openMainJson] = await Promise.all([
      readClosedSince(readJson, "develop", sinceMs),
      // A release that carried a candidate was merged after it, so inside the window too.
      readClosedSince(readJson, "main", sinceMs),
      readJson("/pulls?state=open&base=main&per_page=100"),
    ]);
    // What each main pull request in the window really carries: its commits,
    // beside the numbers its title names.
    const mainPulls = [
      ...(Array.isArray(mergedMainJson) ? mergedMainJson : []).filter((pull) => {
        const mergedAt = (pull as { merged_at?: unknown }).merged_at;
        return typeof mergedAt === "string" && Date.parse(mergedAt) >= sinceMs;
      }),
      ...(Array.isArray(openMainJson) ? openMainJson : []),
    ]
      .map((pull) => (pull as { number?: unknown }).number)
      .filter((number): number is number => typeof number === "number");
    const mainCommits = new Map<number, { sha: string; message: string }[]>();
    await inBatches(mainPulls, async (number) => {
      const commits = await readCommits(readJson, number);
      // More commits than the pages read (a whole-develop release), or not
      // read: what its title names decides.
      if (commits) mainCommits.set(number, commits);
    });
    // First without files, to learn which could ride; only those are read,
    // with their own commits (merge commits left out) to tell whether main
    // already holds every one of them.
    const unchecked = qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files: new Map(), mainCommits, nowMs })
      .filter((candidate) => candidate.status === "unchecked")
      .slice(0, QA_RELEASE_TRAIN_CARGO_MAX);
    const files = new Map<number, string[]>();
    const developCommits = new Map<number, string[]>();
    await inBatches(
      unchecked.map((candidate) => candidate.number),
      async (number) => {
        const [list, commits] = await Promise.all([readJson(`/pulls/${number}/files?per_page=100`).catch(() => null), readCommits(readJson, number)]);
        // Files not read: left unchecked; the train itself still leaves a workflow change out.
        if (Array.isArray(list)) files.set(number, list.map((file) => String((file as { filename?: unknown }).filename ?? "")));
        if (commits) developCommits.set(number, commits.filter((commit) => !commit.merge).map((commit) => commit.sha));
      },
    );
    const value: QaReleaseTrainCargoCandidatesRead = {
      status: "ok",
      readAt: new Date(nowMs).toISOString(),
      candidates: qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files, mainCommits, developCommits, nowMs }),
    };
    cached = { atMs: nowMs, value };
    return value;
  } catch (error) {
    const value: QaReleaseTrainCargoCandidatesRead = { status: "unread", failure: githubReadFailure(error) };
    cached = { atMs: nowMs, value };
    return value;
  }
}
