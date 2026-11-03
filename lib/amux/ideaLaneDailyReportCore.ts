/**
 * The AMUX idea lane's daily report (owner, 2026-11-04): lane pull requests
 * merged into develop over the last day, so the owner can test them on
 * develop before picking them for a main release. The lane merges into
 * develop unattended (ci-admission readies its draft, the release train bot
 * merges it); this list is where the owner sees what came in.
 *
 * Lane pull requests are the AmuxIdeaLaneAttempt rows that opened one
 * (`outcome = 'pr_open'`). Merge time and whether main has it come from the
 * release train's cargo read (lib/qaReleaseTrainCargoCore.ts): a main pull
 * request carries it when its commits keep `Merge pull request #N`, name it,
 * or a train or content check found its change there -- the train replays
 * merges, so ancestry cannot tell.
 *
 * Pure: the read passes what it read.
 */
import type { QaReleaseTrainCargoCandidate } from "../qaReleaseTrainCargoCore.ts";

export const AMUX_IDEA_LANE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AmuxIdeaLaneDailyAttempt = { prNumber: number; ideaRequestId: string };

export type AmuxIdeaLaneDailyMain = "on_main" | "in_main_pull_request" | "not_on_main";

export type AmuxIdeaLaneDailyRow = {
  number: number;
  title: string;
  mergedAt: string;
  /** The idea's own detail in Admin. */
  ideaHref: string;
  main: AmuxIdeaLaneDailyMain;
  /** The main pull request that carries it or waits with it, when one names it. */
  mainPullRequest: number | null;
};

export type AmuxIdeaLaneDailyReport =
  | { status: "ok"; windowStart: string; windowEnd: string; readAt: string; stale: boolean; rows: AmuxIdeaLaneDailyRow[] }
  /** GitHub could not be read: unknown, never "none". */
  | { status: "unread"; failure: string };

export const amuxIdeaLaneIdeaHref = (requestId: string): string =>
  `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(requestId)}`;

export function amuxIdeaLaneDailyReport(input: {
  attempts: readonly AmuxIdeaLaneDailyAttempt[];
  read:
    | { status: "ok"; readAt: string; candidates: readonly QaReleaseTrainCargoCandidate[]; stale?: unknown }
    | { status: "unread"; failure: string };
  nowMs: number;
}): AmuxIdeaLaneDailyReport {
  if (input.read.status !== "ok") return { status: "unread", failure: input.read.failure };
  const since = input.nowMs - AMUX_IDEA_LANE_DAILY_WINDOW_MS;
  const ideaByPull = new Map<number, string>();
  for (const attempt of input.attempts) if (!ideaByPull.has(attempt.prNumber)) ideaByPull.set(attempt.prNumber, attempt.ideaRequestId);
  const rows = input.read.candidates
    .filter((candidate) => {
      const mergedMs = Date.parse(candidate.mergedAt);
      return ideaByPull.has(candidate.number) && mergedMs >= since && mergedMs <= input.nowMs;
    })
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .map((candidate): AmuxIdeaLaneDailyRow => {
      const main: AmuxIdeaLaneDailyMain =
        candidate.status === "on_main" ? "on_main" : candidate.status === "in_main_pull_request" ? "in_main_pull_request" : "not_on_main";
      return {
        number: candidate.number,
        title: candidate.title,
        mergedAt: candidate.mergedAt,
        ideaHref: amuxIdeaLaneIdeaHref(ideaByPull.get(candidate.number) as string),
        main,
        mainPullRequest: main === "not_on_main" ? null : candidate.mainPullRequest,
      };
    });
  return {
    status: "ok",
    windowStart: new Date(since).toISOString(),
    windowEnd: new Date(input.nowMs).toISOString(),
    readAt: input.read.readAt,
    stale: input.read.stale !== undefined,
    rows,
  };
}
