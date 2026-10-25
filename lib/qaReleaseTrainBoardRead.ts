import "server-only";

import { createGithubRepoReader } from "@/lib/githubRepoRead";
import { qaReleaseTrainBoardRows, qaReleaseTrainOpenTrains, qaReleaseTrainPullStates, type QaReleaseTrainBoardRow } from "@/lib/qaReleaseTrainBoardCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainAdmissions, readQaReleaseTrainReports } from "@/lib/qaReleaseTrainStore";

/**
 * Reads the departure board (lib/qaReleaseTrainBoardCore.ts): the newest
 * trains from the audit chain, their main pull requests' states from GitHub
 * through lib/githubRepoRead.ts (the CI admission App's token when
 * configured, as the cargo read), and pull request titles from the cargo
 * read's own cached list. Every open main pull request is read, page by page,
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
const BOARD_ROWS = 20;
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
  const [admissions, reports, open, candidates] = await Promise.all([
    readQaReleaseTrainAdmissions(BOARD_ROWS),
    readQaReleaseTrainReports(BOARD_ROWS * 2),
    readOpen(readJson, nowMs),
    readQaReleaseTrainCargoCandidates(nowMs),
  ]);
  // Trains on the board that opened a pull request no longer open: their own state.
  const shown = new Set(admissions.map((admission) => admission.slot));
  const openNumbers = new Set((open ?? []).map((pull) => (pull as { number?: unknown }).number));
  const settled =
    open === null
      ? []
      : [...new Set(reports.filter((r) => shown.has(r.slot) && r.report.pullRequestNumber !== null).map((r) => r.report.pullRequestNumber as number))].filter(
          (number) => !openNumbers.has(number),
        );
  const settledJson = await Promise.all(settled.map((number) => readPull(readJson, number, nowMs)));
  const titles = new Map(candidates.status === "ok" ? candidates.candidates.map((c) => [c.number, c.title] as const) : []);
  const pullStates = qaReleaseTrainPullStates([...settledJson.filter((json) => json !== null), ...(open ?? [])]);
  return {
    rows: qaReleaseTrainBoardRows({ admissions, reports, pullStates, titles, nowMs }),
    pullsRead: open !== null && settledJson.every((json) => json !== null),
    openRead: open !== null,
    openTrains: open === null ? [] : qaReleaseTrainOpenTrains(open),
  };
}
