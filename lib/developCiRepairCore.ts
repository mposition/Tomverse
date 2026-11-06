/**
 * A red develop head becomes one SEV1 idea for the AMUX idea lane (owner
 * decision: a failing develop CI goes straight to the SEV1 slot, and the
 * agent's signal analysis is automatic). Pure: no I/O, so the decision is
 * tested without GitHub or a database.
 *
 * What it decides, and nothing more:
 *  - which completed check runs on develop's head are a code failure a coding
 *    agent can fix (checks that only compare branches or deployments are not);
 *  - that a head is red on two sightings at least ten minutes apart before
 *    anything is submitted, so a failure the next merge fixes costs nothing;
 *  - one repair in flight at a time, and a daily ceiling on new ones.
 * The coding agent reads the failure and decides the fix; nothing here
 * classifies a failure beyond its check name and conclusion.
 */
import { createHash } from "node:crypto";

export const DEVELOP_CI_REPAIR_MODE_SETTING_KEY = "developCiRepair.mode";
/** {redHeadSha, redSeenAt}: the last red sighting, moved only by the pass. */
export const DEVELOP_CI_REPAIR_STATE_SETTING_KEY = "developCiRepair.state";
export const DEVELOP_CI_REPAIR_SYSTEM_ACTOR = "develop-ci-repair" as const;
export const DEVELOP_CI_REPAIR_IDEA_ACTION = "develop_ci_repair.idea_submitted" as const;
export const DEVELOP_CI_REPAIR_IDEA_TARGET = "AmuxIdeaSubmission" as const;

/** New repair ideas per UTC day. Each one is at most AMUX_IDEA_LANE_MAX_ATTEMPTS lane runs. */
export const DEVELOP_CI_REPAIR_PER_DAY = 3;
/** Jobs whose log goes into one idea, and the tail kept from each. */
export const DEVELOP_CI_REPAIR_MAX_JOBS = 3;
export const DEVELOP_CI_REPAIR_LOG_TAIL_CHARS = 6_000;

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * Checks that report on branches or deployments, not on code: a commit
 * cannot make them pass. The back-merge and deployment checks are red by
 * design while main and develop differ (their workflows say so).
 */
export const DEVELOP_CI_REPAIR_IGNORED_CHECKS = new Set([
  "Deployed commit vs branch head",
  "main is in develop's ancestry",
  "Back-merge main into develop",
  "CI admission",
]);

export type DevelopCheckRun = { id: number; name: string; conclusion: string | null };

/** Failed code checks, in a stable order; cancelled runs are the operator's and never count. */
export const redChecksOf = (runs: readonly DevelopCheckRun[]): DevelopCheckRun[] =>
  runs
    .filter((run) => run.conclusion !== null && FAILED.has(run.conclusion) && !DEVELOP_CI_REPAIR_IGNORED_CHECKS.has(run.name))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

export type DevelopCiRepairMode = { mode: "off" } | { mode: "on"; ownerUserId: string };

/** The saved mode. "on:<owner id>", anything else is off. */
export const parseDevelopCiRepairMode = (value: string | null | undefined): DevelopCiRepairMode =>
  typeof value === "string" && value.startsWith("on:") && value.length > 3
    ? { mode: "on", ownerUserId: value.slice(3) }
    : { mode: "off" };

/**
 * The only thing the pass keeps between runs: which red head it saw last, and
 * when. Losing it costs one more sighting, never a limit. The limits are read
 * from what the submission wrote in its own transaction (the idea row by its
 * request id, and its system audit entry).
 */
export type DevelopCiRepairState = { redHeadSha: string | null; redSeenAt: string | null };

export const EMPTY_DEVELOP_CI_REPAIR_STATE: DevelopCiRepairState = { redHeadSha: null, redSeenAt: null };

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

export const readDevelopCiRepairState = (value: string | null | undefined): DevelopCiRepairState => {
  try {
    const parsed = JSON.parse(value ?? "") as Record<string, unknown>;
    const redSeenAt = text(parsed.redSeenAt);
    const redHeadSha = text(parsed.redHeadSha);
    if (!redHeadSha || !redSeenAt || Number.isNaN(Date.parse(redSeenAt))) return EMPTY_DEVELOP_CI_REPAIR_STATE;
    return { redHeadSha, redSeenAt };
  } catch {
    return EMPTY_DEVELOP_CI_REPAIR_STATE;
  }
};

/**
 * Between two sightings of one red head: under the cron's fifteen minutes so a
 * late tick still counts, long enough that an immediate retry or a second
 * caller is not a second sighting.
 */
export const DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS = 10 * 60_000;

export type DevelopCiRepairFacts = {
  /** An idea already exists for this head (its request id is per head). */
  submittedForHead: boolean;
  /** The newest repair idea still waits, runs or holds an unmerged PR. */
  repairInFlight: boolean;
  /** Repair ideas audited since the start of this UTC day. */
  submittedToday: number;
};

export type DevelopCiRepairDecision =
  | {
      action: "none";
      reason: "green" | "first_sighting" | "waiting" | "same_head_already_submitted" | "repair_in_flight" | "daily_limit";
      state: DevelopCiRepairState;
    }
  | { action: "submit"; headSha: string; checks: DevelopCheckRun[]; state: DevelopCiRepairState };

/** What one pass does with develop's head. The returned state is what it stores. */
export const decideDevelopCiRepair = (input: {
  state: DevelopCiRepairState;
  headSha: string;
  checkRuns: readonly DevelopCheckRun[];
  facts: DevelopCiRepairFacts;
  now: Date;
}): DevelopCiRepairDecision => {
  const { state, facts } = input;
  const red = redChecksOf(input.checkRuns);
  if (red.length === 0) return { action: "none", reason: "green", state: EMPTY_DEVELOP_CI_REPAIR_STATE };
  if (state.redHeadSha !== input.headSha || state.redSeenAt === null) {
    return {
      action: "none",
      reason: "first_sighting",
      state: { redHeadSha: input.headSha, redSeenAt: input.now.toISOString() },
    };
  }
  if (input.now.getTime() - Date.parse(state.redSeenAt) < DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS) {
    return { action: "none", reason: "waiting", state };
  }
  if (facts.submittedForHead) return { action: "none", reason: "same_head_already_submitted", state };
  if (facts.repairInFlight) return { action: "none", reason: "repair_in_flight", state };
  if (facts.submittedToday >= DEVELOP_CI_REPAIR_PER_DAY) return { action: "none", reason: "daily_limit", state };
  return { action: "submit", headSha: input.headSha, checks: red, state };
};

/** The start of the UTC day `now` falls in: the daily limit's window. */
export const developCiRepairDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** One idea per red head: a retried pass after a lost answer finds the same row. */
export const developCiRepairRequestId = (headSha: string) => {
  const bytes = createHash("sha256").update(`develop-ci-repair:${headSha}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** GitHub's timestamp prefix and ANSI colour codes, which only cost the model's reading. */
const cleanLogLine = (line: string) =>
  line
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
    .replace(/\u001b\[[0-9;]*m/g, "");

/** The end of a job log, where a failing step reports; the start is setup. */
export const developCiLogTail = (log: string, limit = DEVELOP_CI_REPAIR_LOG_TAIL_CHARS) => {
  const cleaned = log.split(/\r?\n/).map(cleanLogLine).join("\n").trimEnd();
  return cleaned.length <= limit ? cleaned : cleaned.slice(cleaned.length - limit);
};

/**
 * The idea the lane runs, within the idea size limit: log tails lose their
 * start until the whole fits. The repository and its CI logs are public, so
 * naming checks and quoting their logs adds nothing that is not public.
 */
export const developCiRepairIdea = (input: {
  headSha: string;
  checks: readonly { name: string; id: number; conclusion: string | null; logTail: string | null }[];
  /** The idea input limit (AMUX_IDEA_INPUT_MAX_BYTES). */
  maxBytes: number;
}) => {
  const { maxBytes } = input;
  const head = [
    `Fix the failing CI on develop (head ${input.headSha}).`,
    "",
    "The checks below failed on develop's head commit. Find why and fix the code or the test so they pass.",
    "Do not skip, weaken or delete a test or a check to make it pass; if a test is wrong, correct what it asserts and say why in the PR body.",
    "Reproduce locally first with the narrowest command that runs the failing part (one test file, one script), and run it again after the fix.",
    "If the failure is not in this repository's code (a provider outage, a runner problem, a flaky network call), change nothing.",
  ].join("\n");
  const render = (tailChars: number) =>
    [
      head,
      ...input.checks.map((check) => {
        const section = [`## ${check.name} (${check.conclusion ?? "unknown"})`, `https://github.com/mposition/Tomverse/runs/${check.id}`];
        const tail = check.logTail ? check.logTail.slice(Math.max(0, check.logTail.length - tailChars)) : "";
        if (tail) section.push("", "End of the job log:", "```", tail, "```");
        else section.push("", "The job log could not be read; find the failing step from the check name.");
        return section.join("\n");
      }),
    ].join("\n\n");
  let tailChars = DEVELOP_CI_REPAIR_LOG_TAIL_CHARS;
  let idea = render(tailChars);
  while (Buffer.byteLength(idea, "utf8") > maxBytes && tailChars > 0) {
    tailChars = Math.floor(tailChars * 0.8);
    idea = render(tailChars);
  }
  return idea;
};
