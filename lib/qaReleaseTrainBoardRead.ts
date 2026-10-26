import "server-only";

import { createGithubRepoReader } from "@/lib/githubRepoRead";
import {
  qaReleaseTrainBoardRows,
  qaReleaseTrainBoardSinceMs,
  qaReleaseTrainOpenTrains,
  qaReleaseTrainPullStates,
  type QaReleaseTrainBoardRow,
} from "@/lib/qaReleaseTrainBoardCore";
import { peekQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainAdmissions, readQaReleaseTrainReportsFor } from "@/lib/qaReleaseTrainStore";

/**
 * Reads the departure board (lib/qaReleaseTrainBoardCore.ts): the trains of
 * the last seven AEST days from the audit chain (the board pages them by day), their main pull requests' states from GitHub
 * through lib/githubRepoRead.ts (the CI admission App's token when
 * configured, as the cargo read), and pull request titles from whatever the
 * cargo read last read -- never waiting on that read, which is many GitHub
 * calls (a cold production server took 20-28 seconds on 2026-10-25, and the
 * tab did not move until it ended); the tab's own panels start it. Every
 * open main pull request is read, page by page,
 * so the open trains come from that list, not from the board's limited
 * history, and a train missing from it is not open; each such train's own
 * pull request then says whether it was merged or closed. Reads are shared
 * by every viewer: the open list for five minutes, a merged train for good
 * (that cannot change), a closed one for thirty minutes, and a failed read
 * for a minute, so a page left open does not spend the hourly allowance
 * retrying. What cannot be read is unknown, never guessed, and the tab says so.
 */
const OPEN_CACHE_MS = 5 * 60 * 1000;
const CLOSED_CACHE_MS = 30 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
/** "Read GitHub again" expires a cached read older than this; a newer one is kept, so clicks cannot spend the allowance. */
const FRESH_MIN_MS = 30 * 1000;
/** Settled trains' pull requests are read this many at a time, so a cold week does not burst GitHub. */
const PULL_READS_AT_ONCE = 8;
/** Open main pull requests beyond this many pages are not read: the open list is then unread, never partial. */
const OPEN_PAGE_CAP = 3;

export type QaReleaseTrainBoard = {
  rows: QaReleaseTrainBoardRow[];
  /** Every state shown is GitHub's. */
  pullsRead: boolean;
  /** The open list read in full: a train not boarding is known not to be open. */
  openRead: boolean;
  /** Open train pull requests, newest first, from the open list itself. */
  openTrains: number[];
};

let openCache: { atMs: number; json: unknown[] | null } | null = null;
const pullCache = new Map<number, { atMs: number; json: unknown | null; merged: boolean }>();

/**
 * The train tab's "Read GitHub again" (through the cargo read's `fresh`): the
 * next board read goes to GitHub for the open list and every train not
 * merged, unless that read is younger than thirty seconds. A merged train
 * cannot change and is kept.
 */
export function expireQaReleaseTrainBoardReads(nowMs: number): void {
  if (openCache && nowMs - openCache.atMs >= FRESH_MIN_MS) openCache = null;
  for (const [number, hit] of pullCache) if (!hit.merged && nowMs - hit.atMs >= FRESH_MIN_MS) pullCache.delete(number);
}

async function readOpen(readJson: (path: string) => Promise<unknown>, nowMs: number): Promise<unknown[] | null> {
  if (openCache && nowMs - openCache.atMs < (openCache.json === null ? FAILURE_CACHE_MS : OPEN_CACHE_MS)) return openCache.json;
  let json: unknown[] | null = [];
  try {
    for (let page = 1; ; page += 1) {
      const list = await readJson(`/pulls?state=open&base=main&per_page=100&page=${page}`);
      if (!Array.isArray(list)) throw new Error("github_shape");
      json.push(...list);
      if (list.length < 100) break;
      if (page === OPEN_PAGE_CAP) throw new Error("github_pages");
    }
  } catch {
    json = null;
  }
  openCache = { atMs: nowMs, json };
  return json;
}

async function readPull(readJson: (path: string) => Promise<unknown>, number: number, nowMs: number): Promise<unknown | null> {
  const hit = pullCache.get(number);
  if (hit && (hit.merged || nowMs - hit.atMs < (hit.json === null ? FAILURE_CACHE_MS : CLOSED_CACHE_MS))) return hit.json;
  let json: unknown | null;
  try {
    json = await readJson(`/pulls/${number}`);
  } catch {
    json = null;
  }
  const merged = typeof (json as { merged_at?: unknown } | null)?.merged_at === "string";
  pullCache.set(number, { atMs: nowMs, json, merged });
  return json;
}

export async function readQaReleaseTrainBoard(nowMs = Date.now()): Promise<QaReleaseTrainBoard> {
  const readJson = createGithubRepoReader();
  const candidates = peekQaReleaseTrainCargoCandidates();
  const [admissions, open] = await Promise.all([readQaReleaseTrainAdmissions(new Date(qaReleaseTrainBoardSinceMs(nowMs))), readOpen(readJson, nowMs)]);
  const reports = await readQaReleaseTrainReportsFor(admissions.map((admission) => admission.slot));
  // Trains on the board that opened a pull request no longer open: their own state.
  const shown = new Set(admissions.map((admission) => admission.slot));
  const openNumbers = new Set((open ?? []).map((pull) => (pull as { number?: unknown }).number));
  const settled =
    open === null
      ? []
      : [...new Set(reports.filter((r) => shown.has(r.slot) && r.report.pullRequestNumber !== null).map((r) => r.report.pullRequestNumber as number))].filter(
          (number) => !openNumbers.has(number),
        );
  const settledJson: (unknown | null)[] = [];
  for (let index = 0; index < settled.length; index += PULL_READS_AT_ONCE) {
    settledJson.push(...(await Promise.all(settled.slice(index, index + PULL_READS_AT_ONCE).map((number) => readPull(readJson, number, nowMs)))));
  }
  const titles = new Map(candidates?.status === "ok" ? candidates.candidates.map((c) => [c.number, c.title] as const) : []);
  const pullStates = qaReleaseTrainPullStates([...settledJson.filter((json) => json !== null), ...(open ?? [])]);
  return {
    rows: qaReleaseTrainBoardRows({ admissions, reports, pullStates, titles, nowMs }),
    pullsRead: open !== null && settledJson.every((json) => json !== null),
    openRead: open !== null,
    openTrains: open === null ? [] : qaReleaseTrainOpenTrains(open),
  };
}
