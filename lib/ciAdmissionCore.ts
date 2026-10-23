/**
 * CI admission's judgements (owner decisions 2026-10-20, revised 2026-10-21).
 * GitHub's concurrent jobs are shared per job, so when more pull requests run
 * CI at once than the runners hold, every one of them finishes late.
 *
 * The line is every open pull request into develop or main, drafts included,
 * in one priority order the operator sets in Admin. It is read from GitHub
 * every round, so it never depends on which webhook arrived: a new pull request
 * joins at the bottom, a closed one leaves, and nothing else moves it.
 *
 * - The budget is GitHub's concurrent-job limit for hosted runners, 40 by
 *   default, set in Admin (owner, 2026-10-23: runners, not slots). Each kind
 *   of CI needs the runners its peak used (measured 2026-10-23): a pull
 *   request into develop 15, into main (release or hotfix) 34, push CI on
 *   develop 18 and on main 19 (what Railway waits for; never held). A CI that
 *   runs is counted at its need, not at the jobs it holds now, since its jobs
 *   start in waves; runners GitHub shows in use beyond that (other workflows)
 *   count too.
 * - Runners go from the top of the line down. A ready pull request whose CI is
 *   running keeps its slots while they fit; one further down whose CI runs
 *   past the budget goes back to draft and its runs are cancelled. A draft
 *   that the slots reach is marked ready -- CI starts -- when it has no
 *   conflict with its base, is not behind it, and carries no hold label;
 *   otherwise it is passed over and says why. The first draft that does not
 *   fit stops the walk for drafts: nothing jumps a higher one.
 * - A ready pull request whose CI is not running (finished, waiting to be
 *   merged) takes no slot and is left alone.
 * - A release reserves its slots until GitHub shows its runs or the grace
 *   period ends, so two rounds never fill the same free slot.
 * - A draft with a run queued or in progress is a replayed event: cancelled.
 * - Stacked pull requests (base other than develop or main) and forks are not
 *   handled.
 *
 * Pure: no clock, network or database. lib/ciAdmissionRound.ts passes what it
 * read and carries out the actions.
 */

import { z } from "zod";

export const CI_ADMISSION_STATE_SETTING_KEY = "ci_admission_state";
/** GitHub Pro's concurrent-job limit for standard hosted runners: the default budget, in runners. */
export const CI_ADMISSION_DEFAULT_CAPACITY = 40;
export const CI_ADMISSION_MAX_CAPACITY = 200;
/** Runners each kind of CI needs: the peak measured on recent runs, 2026-10-23. */
export const CI_ADMISSION_DEFAULT_NEEDS = Object.freeze({ develop: 15, main: 34, developPush: 18, mainPush: 19 });
export type CiAdmissionNeeds = { develop: number; main: number; developPush: number; mainPush: number };
/** How long a released pull request is reserved before GitHub shows its runs. */
export const CI_ADMISSION_RELEASE_GRACE_MS = 5 * 60 * 1000;
/** A pull request with this label is never marked ready by admission. */
export const CI_ADMISSION_HOLD_LABEL = "ci:hold";
/** How many drafts at the top of the line a round checks for conflicts and lag. */
export const CI_ADMISSION_CHECK_LIMIT = 6;
const MAX_EVENTS = 50;
const MAX_QUEUE = 300;
const SHA = /^[0-9a-f]{40}$/;

export type CiAdmissionMode = "off" | "shadow" | "on";

/** The mode, or null when the value is not one of the three. Undeclared or empty is off. */
export function parseCiAdmissionMode(text: string | undefined): CiAdmissionMode | null {
  const value = (text ?? "").trim();
  if (value === "") return "off";
  return value === "off" || value === "shadow" || value === "on" ? value : null;
}

export type CiAdmissionPull = {
  number: number;
  nodeId: string;
  title: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
  fork: boolean;
  labels?: readonly string[];
};

/** Runners a pull request's CI needs, or null when admission does not handle it. */
export function ciAdmissionUnits(pull: Pick<CiAdmissionPull, "base" | "fork">, needs: CiAdmissionNeeds = CI_ADMISSION_DEFAULT_NEEDS): number | null {
  if (pull.fork) return null;
  if (pull.base === "develop") return needs.develop;
  if (pull.base === "main") return needs.main;
  return null;
}

/** What GitHub says about a draft before it is marked ready; null where it could not tell. */
export type CiAdmissionCheck = { conflict: boolean | null; behind: boolean | null };

/**
 * Where a pull request stands after a round:
 * running -- its CI runs inside the budget; done -- ready, CI not running;
 * next -- a draft the slots reached, released this round (or as soon as runs
 * being cancelled stop); waiting -- a draft the slots did not reach; conflict,
 * behind, hold -- a draft the slots reached but passed over; checking -- GitHub
 * has not said yet whether it conflicts; held -- sent back to draft this round.
 */
export const CI_ADMISSION_ENTRY_STATUSES = ["running", "done", "next", "waiting", "conflict", "behind", "hold", "checking", "held"] as const;
export type CiAdmissionEntryStatus = (typeof CI_ADMISSION_ENTRY_STATUSES)[number];

const queueEntrySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(200),
    base: z.string().max(100),
    head: z.string().max(200),
    headSha: z.string().max(40).default(""),
    /** When it joined the line. */
    queuedAt: z.string().max(30),
    draft: z.boolean().default(true),
    status: z.enum(CI_ADMISSION_ENTRY_STATUSES).default("waiting"),
  })
  .strict();

const deploySchema = z
  .object({
    branch: z.enum(["develop", "main"]),
    sha: z.string().max(40),
    /** The run's title: the merge commit's first line. */
    title: z.string().max(200),
  })
  .strict();

const eventSchema = z
  .object({
    at: z.string().max(30),
    kind: z.enum(["held", "released", "admitted", "dropped", "cancelled", "failed", "stopped"]),
    number: z.number().int().positive(),
    shadow: z.boolean(),
    detail: z.string().max(120).nullable(),
  })
  .strict();

const needSchema = z.number().int().min(1).max(CI_ADMISSION_MAX_CAPACITY);
const needsSchema = z.object({ develop: needSchema, main: needSchema, developPush: needSchema, mainPush: needSchema }).strict();

const stateSchema = z
  .object({
    version: z.literal(3),
    /** The budget, in runners. */
    capacity: z.number().int().min(1).max(CI_ADMISSION_MAX_CAPACITY),
    needs: needsSchema,
    /** Every handled open pull request, in priority order. */
    queue: z.array(queueEntrySchema).max(MAX_QUEUE),
    /** Released pull requests whose runs GitHub has not shown yet, within the grace period. */
    released: z
      .array(z.object({ number: z.number().int().positive(), headSha: z.string().max(40), atMs: z.number().int().nonnegative() }).strict())
      .max(MAX_QUEUE),
    /**
     * Commits whose `CI admission` status admission set to pending when it sent
     * their pull request back to draft. Each is set back to success once that
     * pull request is ready again, moved on to a new head, or closed, so none
     * is left holding a merge back.
     */
    pendingStatus: z.array(z.object({ number: z.number().int().positive(), headSha: z.string().regex(SHA) }).strict()).max(MAX_QUEUE),
    events: z.array(eventSchema).max(MAX_EVENTS),
    /** The latest round: when, how many slots were in use after it, and by which pull requests. */
    lastRound: z
      .object({
        at: z.string().max(30),
        used: z.number().int().nonnegative(),
        running: z
          .array(z.object({ number: z.number().int().positive(), title: z.string().max(200), base: z.string().max(100) }).strict())
          .max(MAX_QUEUE),
        /** Push runs on develop and main (the deploy CI Railway waits for), one per commit. */
        deploys: z.array(deploySchema).max(MAX_QUEUE).default([]),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CiAdmissionQueueEntry = z.infer<typeof queueEntrySchema>;
export type CiAdmissionEvent = z.infer<typeof eventSchema>;
export type CiAdmissionDeploy = z.infer<typeof deploySchema>;
export type CiAdmissionState = z.infer<typeof stateSchema>;

/** Runners a deploy's CI needs. */
export const ciAdmissionDeployUnits = (branch: CiAdmissionDeploy["branch"], needs: CiAdmissionNeeds = CI_ADMISSION_DEFAULT_NEEDS) =>
  branch === "main" ? needs.mainPush : needs.developPush;

export const emptyCiAdmissionState = (): CiAdmissionState => ({
  version: 3,
  capacity: CI_ADMISSION_DEFAULT_CAPACITY,
  needs: { ...CI_ADMISSION_DEFAULT_NEEDS },
  queue: [],
  released: [],
  pendingStatus: [],
  events: [],
  lastRound: null,
});

/** The first stored shape (a line of held drafts built from events): its budget and order carry over. */
const legacySchema = z
  .object({
    version: z.literal(1),
    capacity: z.number().int().min(1).max(CI_ADMISSION_MAX_CAPACITY),
    queue: z.array(z.object({ number: z.number().int().positive() }).passthrough()),
  })
  .passthrough();

/** The stored state, or an empty one when nothing (or something unreadable) is stored. */
export function parseCiAdmissionState(value: string | null | undefined): CiAdmissionState {
  if (!value) return emptyCiAdmissionState();
  try {
    const json = JSON.parse(value) as unknown;
    const parsed = stateSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    // Version 2 counted slots: everything carries over but the budget, which
    // becomes the runner default (a slot count means nothing in runners).
    const slots = stateSchema.safeParse({ ...(json as object), version: 3, capacity: CI_ADMISSION_DEFAULT_CAPACITY, needs: { ...CI_ADMISSION_DEFAULT_NEEDS } });
    if ((json as { version?: unknown } | null)?.version === 2 && slots.success) return slots.data;
    const legacy = legacySchema.safeParse(json);
    if (!legacy.success) return emptyCiAdmissionState();
    // Only the order survives (its budget counted slots); the next round reads the rest from GitHub.
    return {
      ...emptyCiAdmissionState(),
      queue: legacy.data.queue.slice(0, MAX_QUEUE).map((entry) => {
        const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
        return {
          number: entry.number,
          title: text(entry.title, 200),
          base: text(entry.base, 100),
          head: text(entry.head, 200),
          headSha: SHA.test(text(entry.headSha, 40)) ? text(entry.headSha, 40) : "",
          queuedAt: text(entry.queuedAt, 30) || new Date(0).toISOString(),
          draft: true,
          status: "waiting" as const,
        };
      }),
    };
  } catch {
    return emptyCiAdmissionState();
  }
}

/**
 * A pull_request run is identified by the pull request it runs for and the
 * head it runs on: two pull requests can point at the same commit, and a run
 * for one must never count, or be cancelled, for the other.
 */
export const ciRunKey = (number: number, headSha: string) => `${number}@${headSha}`;

export type CiAdmissionAction =
  /** Back to draft, its runs cancelled, its commit's status pending. */
  | { kind: "hold"; pull: CiAdmissionPull }
  /** Marked ready: CI starts. */
  | { kind: "release"; pull: CiAdmissionPull }
  /** A draft's replayed runs cancelled. */
  | { kind: "cancel"; pull: CiAdmissionPull }
  /** A pending status this admission left, set back to success. */
  | { kind: "clear_status"; number: number; headSha: string };

export type CiAdmissionEvaluation = {
  state: CiAdmissionState;
  actions: CiAdmissionAction[];
  /** Slots in use after this evaluation's releases. */
  used: number;
  /** When something waits on a reservation or a cancellation: when to judge again without an event. */
  nextCheckInMs: number | null;
};

/**
 * The line: the stored order kept for pull requests still open and handled,
 * new ones appended by number (oldest first). The only place order is decided.
 */
export function ciAdmissionOrder(stored: readonly Pick<CiAdmissionQueueEntry, "number">[], openPulls: readonly CiAdmissionPull[]): CiAdmissionPull[] {
  const handled = new Map(openPulls.filter((pull) => ciAdmissionUnits(pull) !== null).map((pull) => [pull.number, pull]));
  const kept = stored.map((entry) => handled.get(entry.number)).filter((pull): pull is CiAdmissionPull => pull !== undefined);
  const seen = new Set(kept.map((pull) => pull.number));
  const added = [...handled.values()].filter((pull) => !seen.has(pull.number)).sort((a, b) => a.number - b.number);
  return [...kept, ...added].slice(0, MAX_QUEUE);
}

/**
 * The drafts a round asks GitHub about before judging: those the free slots
 * reach, judged without any check (so each says "checking"), at most
 * CI_ADMISSION_CHECK_LIMIT. With no free slot it asks about none.
 */
export function ciAdmissionDraftsToCheck(input: Omit<Parameters<typeof evaluateCiAdmission>[0], "checks" | "shadow">): CiAdmissionPull[] {
  const open = new Map(input.openPulls.map((pull) => [pull.number, pull]));
  return evaluateCiAdmission({ ...input, checks: new Map(), shadow: true })
    .state.queue.filter((entry) => entry.status === "checking")
    .slice(0, CI_ADMISSION_CHECK_LIMIT)
    .flatMap((entry) => {
      const pull = open.get(entry.number);
      return pull ? [pull] : [];
    });
}

/** One evaluation of the whole line. `running` holds `ciRunKey(number, head)` for every queued or in-progress pull_request run. */
export function evaluateCiAdmission(input: {
  state: CiAdmissionState;
  openPulls: readonly CiAdmissionPull[];
  running: ReadonlySet<string>;
  /** The base of each pull request with a running run, open or not. */
  runningBases?: ReadonlyMap<number, string>;
  deploys?: readonly CiAdmissionDeploy[];
  /** What GitHub said about drafts (ciAdmissionDraftsToCheck); a draft missing here is "checking". */
  checks?: ReadonlyMap<number, CiAdmissionCheck>;
  /** GitHub-hosted jobs running or queued right now, repository-wide; null when unread. */
  liveRunners?: number | null;
  nowMs: number;
  shadow: boolean;
}): CiAdmissionEvaluation {
  const { nowMs, shadow, state } = input;
  const at = new Date(nowMs).toISOString();
  const checks = input.checks ?? new Map<number, CiAdmissionCheck>();
  const events: CiAdmissionEvent[] = [];
  const event = (kind: CiAdmissionEvent["kind"], number: number, detail: string | null = null) =>
    events.push({ at, kind, number, shadow, detail });

  const line = ciAdmissionOrder(state.queue, input.openPulls);
  const open = new Map(input.openPulls.map((pull) => [pull.number, pull]));
  const runningNumbers = new Set([...input.running].map((key) => Number(key.split("@")[0])));
  // A reservation lasts until runs for its head show or the grace period ends.
  const released = state.released.filter((entry) => {
    const pull = open.get(entry.number);
    return (
      nowMs - entry.atMs < CI_ADMISSION_RELEASE_GRACE_MS &&
      pull?.draft === false &&
      pull.headSha === entry.headSha &&
      !input.running.has(ciRunKey(entry.number, entry.headSha))
    );
  });
  const reserved = new Set(released.map((entry) => entry.number));
  const occupying = (pull: CiAdmissionPull) => runningNumbers.has(pull.number) || (!pull.draft && reserved.has(pull.number));

  const needs = state.needs;
  const unitsOf = (pull: Pick<CiAdmissionPull, "base" | "fork">) => ciAdmissionUnits(pull, needs);
  // Runners nobody here can give back: deploy CI and runs of closed pull requests.
  const closedRunning = [...runningNumbers].filter((number) => !open.has(number));
  const closedUnits = closedRunning.reduce((sum, number) => sum + (unitsOf({ base: input.runningBases?.get(number) ?? "", fork: false }) ?? 0), 0);
  const deploys = input.deploys ?? [];
  const knownFixed = closedUnits + deploys.reduce((sum, deploy) => sum + ciAdmissionDeployUnits(deploy.branch, needs), 0);
  const knownUsed = knownFixed + line.reduce((sum, pull) => (occupying(pull) ? sum + unitsOf(pull)! : sum), 0);
  // Runners GitHub shows in use beyond what the known CI needs: other
  // workflows (nightly, CodeQL, scheduled jobs). They cannot be given back either.
  const others = typeof input.liveRunners === "number" ? Math.max(0, input.liveRunners - knownUsed) : 0;
  const fixedUnits = knownFixed + others;
  // Runners in use now, by every run GitHub shows: a cancellation asked for
  // frees nothing until the runs stop.
  let used = knownUsed + others;

  const status = new Map<number, CiAdmissionEntryStatus>();
  const actions: CiAdmissionAction[] = [];
  const budget = state.capacity - fixedUnits;
  let allotted = 0;
  let draftsBlocked = false;
  let waitingOnRuns = false;
  for (const pull of line) {
    // A CI that needs more than the whole budget still runs alone, never waits forever.
    const units = Math.min(unitsOf(pull)!, state.capacity);
    if (!pull.draft) {
      if (!occupying(pull)) {
        status.set(pull.number, "done");
      } else if (allotted + units <= budget) {
        allotted += units;
        status.set(pull.number, "running");
      } else {
        actions.push({ kind: "hold", pull });
        status.set(pull.number, "held");
        event("held", pull.number, "over_budget");
      }
      continue;
    }
    if (runningNumbers.has(pull.number)) {
      actions.push({ kind: "cancel", pull });
      event("cancelled", pull.number, "draft_rerun");
    }
    if ((pull.labels ?? []).includes(CI_ADMISSION_HOLD_LABEL)) {
      status.set(pull.number, "hold");
      continue;
    }
    if (draftsBlocked || allotted + units > budget) {
      draftsBlocked = true;
      status.set(pull.number, "waiting");
      continue;
    }
    const check = checks.get(pull.number);
    if (!check || check.conflict === null) {
      status.set(pull.number, "checking");
      continue;
    }
    if (check.conflict) {
      status.set(pull.number, "conflict");
      continue;
    }
    if (check.behind === true) {
      status.set(pull.number, "behind");
      continue;
    }
    allotted += units;
    status.set(pull.number, "next");
    // Released only once it fits beside every run GitHub still shows: runs
    // being cancelled hold their runners until they stop.
    if (used + units > state.capacity) {
      draftsBlocked = true;
      waitingOnRuns = true;
      continue;
    }
    used += units;
    actions.push({ kind: "release", pull });
    released.push({ number: pull.number, headSha: pull.headSha, atMs: nowMs });
    event("released", pull.number, null);
  }

  // Pending statuses this admission left are set back to success once their
  // pull request is ready again, on a new head, or closed. One sent back to
  // draft this round is recorded; its status is written by the hold.
  const held = actions.flatMap((action) => (action.kind === "hold" ? [action.pull] : []));
  const releasing = new Set(actions.flatMap((action) => (action.kind === "release" ? [action.pull.number] : [])));
  for (const entry of state.pendingStatus) {
    const pull = open.get(entry.number);
    if (held.some((h) => h.number === entry.number && h.headSha === entry.headSha)) continue;
    const stillWaiting = pull !== undefined && pull.draft && !releasing.has(entry.number) && pull.headSha === entry.headSha;
    if (!stillWaiting) actions.push({ kind: "clear_status", number: entry.number, headSha: entry.headSha });
  }
  const pendingStatus = [...state.pendingStatus];
  for (const pull of held) {
    if (SHA.test(pull.headSha) && !pendingStatus.some((p) => p.number === pull.number && p.headSha === pull.headSha)) {
      pendingStatus.push({ number: pull.number, headSha: pull.headSha });
    }
  }

  const heldNumbers = new Set(held.map((pull) => pull.number));
  const queuedAt = new Map(state.queue.map((entry) => [entry.number, entry.queuedAt]));
  const queue: CiAdmissionQueueEntry[] = line.map((pull) => ({
    number: pull.number,
    title: pull.title.slice(0, 200),
    base: pull.base,
    head: pull.head.slice(0, 200),
    headSha: pull.headSha.slice(0, 40),
    queuedAt: queuedAt.get(pull.number) ?? at,
    draft: (pull.draft || heldNumbers.has(pull.number)) && !releasing.has(pull.number),
    status: status.get(pull.number) ?? "waiting",
  }));
  const inLine = new Set(line.map((pull) => pull.number));
  for (const entry of state.queue) {
    if (!inLine.has(entry.number) && entry.title !== "") event("dropped", entry.number, "closed");
  }

  return {
    state: {
      version: 3,
      capacity: state.capacity,
      needs,
      queue,
      released: released.slice(-MAX_QUEUE),
      // Cleared entries are taken off by the round once their status is written.
      pendingStatus: pendingStatus.slice(-MAX_QUEUE),
      events: [...state.events, ...events].slice(-MAX_EVENTS),
      lastRound: {
        at,
        used,
        running: line
          .filter((pull) => occupying(pull) || releasing.has(pull.number))
          .map((pull) => ({ number: pull.number, title: pull.title.slice(0, 200), base: pull.base }))
          .concat(
            closedRunning
              .filter((number) => unitsOf({ base: input.runningBases?.get(number) ?? "", fork: false }) !== null)
              .map((number) => ({ number, title: "", base: input.runningBases?.get(number) ?? "" })),
          ),
        deploys: deploys.slice(0, MAX_QUEUE).map((deploy) => ({ ...deploy, title: deploy.title.slice(0, 200) })),
      },
    },
    actions,
    used,
    nextCheckInMs:
      waitingOnRuns || released.length > 0
        ? released.reduce((soonest, entry) => Math.min(soonest, Math.max(1_000, entry.atMs + CI_ADMISSION_RELEASE_GRACE_MS - nowMs)), 60_000)
        : null,
  };
}

/**
 * The line in the order the operator gave. Pull requests the operator did not
 * see (opened since the page loaded) keep their order after the given ones;
 * numbers no longer in line are ignored. Null when the order names nothing.
 */
export function reorderCiAdmissionQueue(state: CiAdmissionState, order: readonly number[]): CiAdmissionState | null {
  const byNumber = new Map(state.queue.map((entry) => [entry.number, entry]));
  const given = [...new Set(order)].filter((number) => byNumber.has(number));
  if (given.length === 0) return null;
  const rest = state.queue.filter((entry) => !given.includes(entry.number));
  return { ...state, queue: [...given.map((number) => byNumber.get(number)!), ...rest] };
}

/** One pull request moved to the top or the bottom of the line; null when it is not in line. */
export function moveCiAdmissionEntry(state: CiAdmissionState, number: number, to: "top" | "bottom"): CiAdmissionState | null {
  const entry = state.queue.find((queued) => queued.number === number);
  if (!entry) return null;
  const rest = state.queue.filter((queued) => queued.number !== number);
  return { ...state, queue: to === "top" ? [entry, ...rest] : [...rest, entry] };
}
