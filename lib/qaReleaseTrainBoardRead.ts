import "server-only";

import { createGithubRepoReader } from "@/lib/githubRepoRead";
import { qaReleaseTrainBoardRows, qaReleaseTrainOpenTrains, qaReleaseTrainPullStates, type QaReleaseTrainBoardRow } from "@/lib/qaReleaseTrainBoardCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainAdmissions, readQaReleaseTrainReports } from "@/lib/qaReleaseTrainStore";

/**
 * Reads the departure board (lib/qaReleaseTrainBoardCore.ts): the newest
 * trains from the audit chain, each train pull request's state from two
 * GitHub lists read through lib/githubRepoRead.ts (the CI admission App's
 * token when configured, as the cargo read), and pull request titles from the
 * cargo read's own cached list. The open list is read to its last page, so a
 * train missing from it is not open and the open trains come from it, not
 * from the board's limited history; the second list, the most recently
 * closed, says whether one was merged. Each list is kept five minutes and
 * shared by every viewer; a failed read is kept a minute, so a page left open
 * does not spend the hourly allowance retrying. A list that cannot be read in
 * full leaves states unknown, never wrong, and the tab says so.
 */
const CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const BOARD_ROWS = 20;
const OPEN = "/pulls?state=open&base=main&per_page=100";
const RECENTLY_CLOSED = "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100";
/** Open main pull requests beyond this many pages are not read: the open list is then incomplete. */
const OPEN_PAGE_CAP = 3;

export type QaReleaseTrainBoard = {
  rows: QaReleaseTrainBoardRow[];
  /** Both lists read in full: every state shown is GitHub's. */
  pullsRead: boolean;
  /** The open list read in full: a train not boarding is known not to be open. */
  openRead: boolean;
  /** Open train pull requests, newest first, from the open list itself. */
  openTrains: number[];
};

const cached = new Map<string, { atMs: number; json: unknown[] | null }>();

/** `whole`: read to the last page, and a list longer than `pages` is unread; otherwise the first `pages` only. */
async function readList(
  readJson: (path: string) => Promise<unknown>,
  path: string,
  pages: number,
  whole: boolean,
  nowMs: number,
): Promise<unknown[] | null> {
  const hit = cached.get(path);
  if (hit && nowMs - hit.atMs < (hit.json === null ? FAILURE_CACHE_MS : CACHE_MS)) return hit.json;
  let json: unknown[] | null = [];
  try {
    for (let page = 1; page <= pages; page += 1) {
      const list = await readJson(`${path}&page=${page}`);
      if (!Array.isArray(list)) throw new Error("github_shape");
      json.push(...list);
      if (list.length < 100) break;
      // A whole list the cap cuts short is unread, never partial.
      if (whole && page === pages) throw new Error("github_pages");
    }
  } catch {
    json = null;
  }
  cached.set(path, { atMs: nowMs, json });
  return json;
}

export async function readQaReleaseTrainBoard(nowMs = Date.now()): Promise<QaReleaseTrainBoard> {
  const readJson = createGithubRepoReader();
  const [admissions, reports, open, closed, candidates] = await Promise.all([
    readQaReleaseTrainAdmissions(BOARD_ROWS),
    readQaReleaseTrainReports(BOARD_ROWS * 2),
    readList(readJson, OPEN, OPEN_PAGE_CAP, true, nowMs),
    // The most recently closed hundred: older trains are history, shown as state unknown.
    readList(readJson, RECENTLY_CLOSED, 1, false, nowMs),
    readQaReleaseTrainCargoCandidates(nowMs),
  ]);
  const titles = new Map(candidates.status === "ok" ? candidates.candidates.map((c) => [c.number, c.title] as const) : []);
  const pullStates = qaReleaseTrainPullStates([...(closed ?? []), ...(open ?? [])]);
  return {
    rows: qaReleaseTrainBoardRows({ admissions, reports, pullStates, titles, nowMs }),
    pullsRead: open !== null && closed !== null,
    openRead: open !== null,
    openTrains: open === null ? [] : qaReleaseTrainOpenTrains(open),
  };
}
