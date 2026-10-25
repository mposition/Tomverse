import "server-only";

import { qaReleaseTrainBoardRows, qaReleaseTrainPullStates, type QaReleaseTrainBoardRow } from "@/lib/qaReleaseTrainBoardCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { readQaReleaseTrainAdmissions, readQaReleaseTrainReports } from "@/lib/qaReleaseTrainStore";

/**
 * Reads the departure board (lib/qaReleaseTrainBoardCore.ts): the newest
 * trains from the audit chain, each train pull request's state from one
 * public GitHub list (no credential, as the cargo read; kept five minutes and
 * shared by every viewer), and pull request titles from the cargo read's own
 * cached list. A GitHub read that fails leaves states unknown, never wrong:
 * the board says it could not read them.
 */
const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60 * 1000;
const BOARD_ROWS = 20;

export type QaReleaseTrainBoard = { rows: QaReleaseTrainBoardRow[]; pullsRead: boolean };

let cached: { atMs: number; json: unknown } | null = null;

async function readMainPulls(nowMs: number): Promise<unknown | null> {
  if (cached && nowMs - cached.atMs < CACHE_MS) return cached.json;
  try {
    const response = await fetch(`${API}/pulls?state=all&base=main&sort=created&direction=desc&per_page=60`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    cached = { atMs: nowMs, json };
    return json;
  } catch {
    return null;
  }
}

export async function readQaReleaseTrainBoard(nowMs = Date.now()): Promise<QaReleaseTrainBoard> {
  const [admissions, reports, pulls, candidates] = await Promise.all([
    readQaReleaseTrainAdmissions(BOARD_ROWS),
    readQaReleaseTrainReports(BOARD_ROWS * 2),
    readMainPulls(nowMs),
    readQaReleaseTrainCargoCandidates(nowMs),
  ]);
  const titles = new Map(candidates.status === "ok" ? candidates.candidates.map((c) => [c.number, c.title] as const) : []);
  return {
    rows: qaReleaseTrainBoardRows({ admissions, reports, pullStates: qaReleaseTrainPullStates(pulls), titles, nowMs }),
    pullsRead: pulls !== null,
  };
}
