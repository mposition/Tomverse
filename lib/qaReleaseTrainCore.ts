/**
 * The release train's judgements (docs/policy/qa-release-agent.md section 8
 * item 12): when a train departs, which develop pull requests it carries and
 * in what order, and the main pull request it opens. Owner decisions
 * 2026-10-20: departures at 08, 11, 14, 17 and 20 AEST (UTC+10, no daylight
 * saving), configurable as one value; the cargo is the merged develop pull
 * requests the operator picked in Admin (2026-10-23; until then a `main:next`
 * label) that are not already on main; a conflicting
 * one is left out and named, never resolved; one open train at a time.
 *
 * Pure: no clock, network, git or database. The service
 * (lib/qaReleaseTrainService.ts) passes what it read.
 */

export const QA_RELEASE_TRAIN_DEFAULT_SLOTS = "08,11,14,17,20";
/** How long after a departure time a round may still start that departure: six 10-minute crons. */
export const QA_RELEASE_TRAIN_WINDOW_MS = 60 * 60 * 1000;
export const QA_RELEASE_TRAIN_BRANCH_PREFIX = "release/train-";
/** At most this many pull requests ride one train; the rest wait for the next. */
export const QA_RELEASE_TRAIN_MAX_CARGO = 30;

const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
const SLOT = /^\d{8}-\d{4}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The departure hours, or null when the value is not a comma list of distinct hours 0-23. */
export function parseQaReleaseTrainSlots(text: string | undefined): number[] | null {
  const raw = (text ?? "").trim() === "" ? QA_RELEASE_TRAIN_DEFAULT_SLOTS : (text ?? "").trim();
  const hours: number[] = [];
  for (const part of raw.split(",")) {
    if (!/^\d{1,2}$/.test(part.trim())) return null;
    const hour = Number(part.trim());
    if (hour > 23 || hours.includes(hour)) return null;
    hours.push(hour);
  }
  return hours.sort((a, b) => a - b);
}

/**
 * The departure this moment belongs to: the latest departure today (AEST) at
 * or before now, while within the window. Its id is `YYYYMMDD-HHMM` in AEST.
 */
export function qaReleaseTrainDeparture(nowMs: number, hours: readonly number[]): { slot: string; departsAtMs: number } | null {
  const aest = new Date(nowMs + AEST_OFFSET_MS);
  const y = aest.getUTCFullYear();
  const m = aest.getUTCMonth();
  const d = aest.getUTCDate();
  for (const hour of [...hours].sort((a, b) => b - a)) {
    const departsAtMs = Date.UTC(y, m, d, hour) - AEST_OFFSET_MS;
    if (nowMs >= departsAtMs && nowMs < departsAtMs + QA_RELEASE_TRAIN_WINDOW_MS) {
      const pad = (n: number) => String(n).padStart(2, "0");
      return { slot: `${y}${pad(m + 1)}${pad(d)}-${pad(hour)}00`, departsAtMs };
    }
  }
  return null;
}

export const qaReleaseTrainBranch = (slot: string): string => {
  if (!SLOT.test(slot)) throw new Error("train slot");
  return `${QA_RELEASE_TRAIN_BRANCH_PREFIX}${slot}`;
};

export type QaReleaseTrainCandidate = { number: number; title: string; mergeCommitSha: string; mergedAt: string };

/** Picked develop pull requests in develop merge order, deduplicated; malformed entries are dropped. */
export function orderQaReleaseTrainCandidates(candidates: readonly QaReleaseTrainCandidate[]): QaReleaseTrainCandidate[] {
  const seen = new Set<number>();
  return candidates
    .filter((c) => Number.isInteger(c.number) && c.number > 0 && SHA.test(c.mergeCommitSha) && !Number.isNaN(Date.parse(c.mergedAt)))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number)
    .filter((c) => (seen.has(c.number) ? false : (seen.add(c.number), true)));
}

export type QaReleaseTrainSkip = "no_departure" | "train_open" | "no_cargo";

/** Whether this round starts a train. The admission (one per departure, lane state) is the app's. */
export function qaReleaseTrainShouldDepart(input: {
  departure: { slot: string } | null;
  openTrainPullRequests: number;
  candidates: number;
}): { depart: true } | { depart: false; reason: QaReleaseTrainSkip } {
  if (input.departure === null) return { depart: false, reason: "no_departure" };
  if (input.openTrainPullRequests > 0) return { depart: false, reason: "train_open" };
  if (input.candidates === 0) return { depart: false, reason: "no_cargo" };
  return { depart: true };
}

/** What happened to one pull request when the train was assembled. */
export type QaReleaseTrainPick = {
  number: number;
  /**
   * `changes_workflows`: it changes `.github/workflows/**`, which the merge
   * lane's App may not push (no workflows permission, by design); it is left
   * out and released on its own.
   */
  outcome: "included" | "already_in_main" | "conflict" | "over_capacity" | "changes_workflows";
};

/** Outcomes that leave a picked pull request for a later release. */
export const QA_RELEASE_TRAIN_LEFT_OUT: ReadonlySet<QaReleaseTrainPick["outcome"]> = new Set(["conflict", "over_capacity", "changes_workflows"]);

export function qaReleaseTrainPullRequest(input: {
  slot: string;
  candidates: readonly QaReleaseTrainCandidate[];
  picks: readonly QaReleaseTrainPick[];
  rcSha: string;
  rollbackSha: string;
}): { title: string; body: string } {
  const title = (n: number) => input.candidates.find((c) => c.number === n)?.title.replace(/\s+/g, " ").slice(0, 120) ?? "";
  const included = input.picks.filter((p) => p.outcome === "included");
  const left = input.picks.filter((p) => QA_RELEASE_TRAIN_LEFT_OUT.has(p.outcome));
  const already = input.picks.filter((p) => p.outcome === "already_in_main");
  const reason = {
    conflict: "cherry-pick conflict on main; pick it again for a later train once resolved",
    over_capacity: "train full; pick it again for the next train",
    changes_workflows: "changes .github/workflows, which the train cannot push; release it on its own (release/** or hotfix/**)",
  } as const;
  const lines = [
    `Release train ${input.slot} (AEST), opened by the QA-release agent. Selective release, \`.github/RELEASE_CHECKLIST.md\` 7.9.1: each pull request below was cherry-picked onto main with \`-m 1\` in develop merge order. A person merges this pull request.`,
    "",
    `## Included (${included.length})`,
    "",
    ...included.map((p) => `- #${p.number} ${title(p.number)}`),
    "",
    `## Left out (${left.length})`,
    "",
    ...(left.length === 0 ? ["None."] : left.map((p) => `- #${p.number} ${title(p.number)} — ${reason[p.outcome as keyof typeof reason]}`)),
    "",
    `Already on main, skipped: ${already.length === 0 ? "none" : already.map((p) => `#${p.number}`).join(", ")}.`,
    "",
    "## 7.9.1",
    "",
    "```",
    `RC SHA:             ${input.rcSha}`,
    "Verified on:        ____________________",
    "Verified by / how:  ____________________",
    `Rollback SHA:       ${input.rollbackSha}`,
    "Back-merge run:     ____________________",
    "```",
    "",
    "🤖 Generated by the QA-release agent's release train",
  ];
  return { title: `release: train ${input.slot} (${included.length} PR${included.length === 1 ? "" : "s"})`, body: lines.join("\n") };
}
