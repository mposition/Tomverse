import "server-only";

import { qaReleaseTrainBoardRows, qaReleaseTrainPullStates, type QaReleaseTrainBoardRow } from "@/lib/qaReleaseTrainBoardCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainAdmissions, readQaReleaseTrainReports } from "@/lib/qaReleaseTrainStore";

/**
 * Reads the departure board (lib/qaReleaseTrainBoardCore.ts): the newest
 * trains from the audit chain, each train pull request's state from two
 * public GitHub lists (no credential, as the cargo read; each kept five
 * minutes and shared by every viewer), and pull request titles from the cargo
 * read's own cached list. Every open main pull request fits the first list,
 * so a train missing from it is not open; the second, the most recently
 * closed, says whether it was merged. A list that cannot be read leaves
 * states unknown, never wrong, and the board says so.
 */
const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60 * 1000;
const BOARD_ROWS = 20;
const OPEN = "/pulls?state=open&base=main&per_page=100";
const RECENTLY_CLOSED = "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100";

export type QaReleaseTrainBoard = {
  rows: QaReleaseTrainBoardRow[];
  /** Both lists read: every state shown is GitHub's. */
  pullsRead: boolean;
  /** The open list read: a train not boarding is known not to be open. */
  openRead: boolean;
};

const cached = new Map<string, { atMs: number; json: unknown[] }>();

async function readList(path: string, nowMs: number): Promise<unknown[] | null> {
  const hit = cached.get(path);
  if (hit && nowMs - hit.atMs < CACHE_MS) return hit.json;
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    if (!Array.isArray(json)) return null;
    cached.set(path, { atMs: nowMs, json });
    return json;
  } catch {
    return null;
  }
}

export async function readQaReleaseTrainBoard(nowMs = Date.now()): Promise<QaReleaseTrainBoard> {
  const [admissions, reports, open, closed, candidates] = await Promise.all([
    readQaReleaseTrainAdmissions(BOARD_ROWS),
    readQaReleaseTrainReports(BOARD_ROWS * 2),
    readList(OPEN, nowMs),
    readList(RECENTLY_CLOSED, nowMs),
    readQaReleaseTrainCargoCandidates(nowMs),
  ]);
  const titles = new Map(candidates.status === "ok" ? candidates.candidates.map((c) => [c.number, c.title] as const) : []);
  const pullStates = qaReleaseTrainPullStates([...(closed ?? []), ...(open ?? [])]);
  return {
    rows: qaReleaseTrainBoardRows({ admissions, reports, pullStates, titles, nowMs }),
    pullsRead: open !== null && closed !== null,
    openRead: open !== null,
  };
}
