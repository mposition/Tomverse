import "server-only";

import {
  QA_RELEASE_TRAIN_CANDIDATE_DAYS,
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

/**
 * What a merged pull request holds never changes, so its files and commits
 * are read once and kept for every later read (owner 2026-10-28: only the
 * newest 30 candidates were read, and the rest showed "files not checked").
 * A read starts at most NEW_READS_PER_ROUND candidates not read before; any
 * more are read by the next one. Only a successful read is kept.
 */
const NEW_READS_PER_ROUND = 120;
const KEPT_MAX = 3000;
type Commit = { sha: string; message: string; merge: boolean };
const keptFiles = new Map<number, string[]>();
const keptCommits = new Map<number, Commit[]>();
function keep<V>(map: Map<number, V>, number: number, value: V): void {
  map.set(number, value);
  if (map.size > KEPT_MAX) map.delete(map.keys().next().value as number);
}

export type QaReleaseTrainCargoCandidatesRead =
  | {
      status: "ok";
      readAt: string;
      candidates: QaReleaseTrainCargoCandidate[];
      /**
       * Set when the newest read failed and these are the last good one's
       * candidates: the page keeps its list and says why it is not newer.
       */
      stale?: { failure: string; failedAt: string };
    }
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

/** `failed`: this read failed (its value is the last good one marked stale, or unread), so it is retried after a minute. */
let cached: { atMs: number; value: QaReleaseTrainCargoCandidatesRead; failed: boolean } | null = null;
/** The last read that succeeded: what a failed read falls back to. */
let lastGood: Extract<QaReleaseTrainCargoCandidatesRead, { status: "ok" }> | null = null;

/**
 * The last candidates read, whatever their age, without reading GitHub: for
 * a page that only wants titles and must not wait on the full read (it took
 * 20-28 seconds on a cold production server on 2026-10-25, and the release
 * train tab waited on it). Null before the first read.
 */
export function peekQaReleaseTrainCargoCandidates(): QaReleaseTrainCargoCandidatesRead | null {
  return cached?.value ?? null;
}

/**
 * The candidates, from the shared read while it is fresh enough. `fresh` (the
 * train tab's "Read GitHub again", or a save on it) reads GitHub again unless
 * a read is under FRESH_MIN_MS old, so several operators pressing it spend
 * one read. A read already under way answers every caller that arrives
 * meanwhile: one press starts several at once (the tab, its picker and its
 * emergency panel), and each would otherwise read GitHub in full.
 */
export async function readQaReleaseTrainCargoCandidates(
  nowMs = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<QaReleaseTrainCargoCandidatesRead> {
  const keepMs = options.fresh ? FRESH_MIN_MS : cached?.failed ? FAILURE_CACHE_MS : CACHE_MS;
  if (cached && nowMs - cached.atMs < keepMs) return cached.value;
  if (inFlight) return inFlight;
  inFlight = readFromGithub(nowMs).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight: Promise<QaReleaseTrainCargoCandidatesRead> | null = null;

/**
 * Every open main pull request, page by page, as the train service and the
 * departure board read them: one past the first hundred can still carry a
 * candidate. A list longer than the cap is a failed read, never a partial one.
 */
const OPEN_PAGE_CAP = 3;
async function readOpenMain(readJson: (path: string) => Promise<unknown>): Promise<unknown[]> {
  const pulls: unknown[] = [];
  for (let page = 1; page <= OPEN_PAGE_CAP; page += 1) {
    const list = await readJson(`/pulls?state=open&base=main&per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error("github_shape");
    pulls.push(...list);
    if (list.length < 100) return pulls;
  }
  throw new Error("github_pages");
}

/** `readJson`: GitHub through lib/githubRepoRead.ts; a test passes its own. */
export async function readFromGithub(
  nowMs: number,
  readJson: (path: string) => Promise<unknown> = createGithubRepoReader(),
): Promise<QaReleaseTrainCargoCandidatesRead> {
  try {
    const sinceMs = nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
    // Each list says where it failed: `develop:github_403`, `open:timeout`.
    const at = <T,>(where: string, read: Promise<T>) =>
      read.catch((error: unknown) => {
        throw new ReadFailure(`${where}:${githubReadFailure(error)}`);
      });
    const [mergedDevelopJson, mergedMainJson, openMainJson] = await Promise.all([
      at("develop", readClosedSince(readJson, "develop", sinceMs)),
      // A release that carried a candidate was merged after it, so inside the window too.
      at("main", readClosedSince(readJson, "main", sinceMs)),
      at("open", readOpenMain(readJson)),
    ]);
    // What each main pull request in the window really carries: its commits,
    // beside the numbers its title names.
    const numberOf = (pull: unknown) => (pull as { number?: unknown }).number;
    const mergedMain = (Array.isArray(mergedMainJson) ? mergedMainJson : [])
      .filter((pull) => {
        const mergedAt = (pull as { merged_at?: unknown }).merged_at;
        return typeof mergedAt === "string" && Date.parse(mergedAt) >= sinceMs;
      })
      .map(numberOf)
      .filter((number): number is number => typeof number === "number");
    const openMain = openMainJson.map(numberOf).filter((number): number is number => typeof number === "number");
    const mainCommits = new Map<number, { sha: string; message: string }[]>();
    // A merged release's commits are kept; an open one can still change.
    for (const number of mergedMain) {
      const kept = keptCommits.get(number);
      if (kept) mainCommits.set(number, kept);
    }
    await inBatches([...mergedMain.filter((number) => !mainCommits.has(number)), ...openMain], async (number) => {
      const commits = await readCommits(readJson, number);
      // More commits than the pages read (a whole-develop release), or not
      // read: what its title names decides.
      if (!commits) return;
      mainCommits.set(number, commits);
      if (!openMain.includes(number)) keep(keptCommits, number, commits);
    });
    // First without files, to learn which could ride; only those are read,
    // with their own commits (merge commits left out) to tell whether main
    // already holds every one of them.
    const unchecked = qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files: new Map(), mainCommits, nowMs })
      .filter((candidate) => candidate.status === "unchecked")
      .map((candidate) => candidate.number);
    const toRead = unchecked.filter((number) => !keptFiles.has(number) || !keptCommits.has(number)).slice(0, NEW_READS_PER_ROUND);
    await inBatches(toRead, async (number) => {
      const [list, commits] = await Promise.all([
        keptFiles.has(number) ? null : readJson(`/pulls/${number}/files?per_page=100`).catch(() => null),
        keptCommits.has(number) ? null : readCommits(readJson, number),
      ]);
      if (Array.isArray(list)) keep(keptFiles, number, list.map((file) => String((file as { filename?: unknown }).filename ?? "")));
      if (commits) keep(keptCommits, number, commits);
    });
    // Files not read (this round's limit, or a failed read): left unchecked;
    // the train itself still leaves a workflow change out.
    const files = new Map<number, string[]>();
    const developCommits = new Map<number, string[]>();
    for (const number of unchecked) {
      const keptList = keptFiles.get(number);
      const commits = keptCommits.get(number);
      if (keptList) files.set(number, keptList);
      if (commits) developCommits.set(number, commits.filter((commit) => !commit.merge).map((commit) => commit.sha));
    }
    const value: QaReleaseTrainCargoCandidatesRead = {
      status: "ok",
      readAt: new Date(nowMs).toISOString(),
      candidates: qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files, mainCommits, developCommits, nowMs }),
    };
    cached = { atMs: nowMs, value, failed: false };
    lastGood = value;
    return value;
  } catch (error) {
    // A failed read no longer blanks the page (owner, 2026-10-26: "GitHub
    // could not be read" came up too often): the last good list stays, marked
    // with why it is not newer, and the read is retried after a minute. Why
    // it failed goes to the log too, a code only, never a URL or a body.
    const failure = error instanceof ReadFailure ? error.message : githubReadFailure(error);
    console.warn(JSON.stringify({ event: "qa_release_train_cargo_read_failed", failure, lastGoodAt: lastGood?.readAt ?? null }));
    const value: QaReleaseTrainCargoCandidatesRead = lastGood
      ? { ...lastGood, stale: { failure, failedAt: new Date(nowMs).toISOString() } }
      : { status: "unread", failure };
    cached = { atMs: nowMs, value, failed: true };
    return value;
  }
}

/** A list read that failed, named by where: its message is the failure code shown and logged. */
class ReadFailure extends Error {}
