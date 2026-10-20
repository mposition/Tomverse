/**
 * CI admission's judgements (owner decision 2026-10-20). GitHub's 40 concurrent
 * jobs are shared per job, so when more pull requests run CI at once than the
 * runners hold, every one of them finishes late. Admission keeps the number
 * running at once inside a budget of slots, holds the rest as drafts (a draft
 * runs no CI) in a line the operator orders in Admin, and releases the head of
 * that line when a slot frees.
 *
 * - A pull request into develop takes 1 slot, one into main (release or
 *   hotfix) takes 2; the budget is 3 by default, set in Admin. Three develop
 *   pull requests, or one into main and one into develop, run at once.
 * - No class jumps the line: a hotfix waits like any other until the operator
 *   moves it to the top, so it never competes with running pull requests.
 * - A pull request uses its slots while its CI runs. One admission released or
 *   let through also reserves its slots until GitHub shows its runs (or the
 *   grace period ends), so a burst of events cannot let several through
 *   against the same free slot; once its runs are seen, they alone count, so
 *   a CI that finishes fast frees its slots at once. One whose CI finished and
 *   only waits to be merged holds none.
 * - Arrival is a pull request becoming ready for review (or opened or reopened
 *   ready). If anything waits in line, or its slots do not fit, it goes back
 *   to draft, its just-started runs are cancelled, and it joins the end of the
 *   line. Pushes to develop and main are never held.
 * - A draft runs no CI, so a draft with a pull_request run queued or in
 *   progress is a re-run of an event from before it became a draft (GitHub
 *   re-runs replay the original event, draft flag included): that run is
 *   cancelled.
 * - Stacked pull requests (base other than develop or main) and forks are not
 *   handled.
 *
 * Pure: no clock, network or database. lib/ciAdmissionService.ts passes what it
 * read and carries out the actions.
 */
import { z } from "zod";

export const CI_ADMISSION_STATE_SETTING_KEY = "ci_admission_state";
export const CI_ADMISSION_DEFAULT_CAPACITY = 3;
export const CI_ADMISSION_MAX_CAPACITY = 20;
/** How long a released or admitted pull request is reserved (and its own ready event recognised) before GitHub shows its runs. */
export const CI_ADMISSION_RELEASE_GRACE_MS = 5 * 60 * 1000;
const MAX_EVENTS = 50;
const MAX_QUEUE = 100;

export type CiAdmissionMode = "off" | "shadow" | "on";

/** The mode, or null when the value is not one of the three. Undeclared or empty is off. */
export function parseCiAdmissionMode(text: string | undefined): CiAdmissionMode | null {
  const value = (text ?? "").trim();
  if (value === "") return "off";
  return value === "off" || value === "shadow" || value === "on" ? value : null;
}

/** Slots a pull request takes, or null when admission does not handle it. */
export function ciAdmissionUnits(pull: Pick<CiAdmissionPull, "base" | "fork">): number | null {
  if (pull.fork) return null;
  if (pull.base === "develop") return 1;
  if (pull.base === "main") return 2;
  return null;
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
};

const queueEntrySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(200),
    base: z.string().max(100),
    head: z.string().max(200),
    queuedAt: z.string().max(30),
  })
  .strict();

const eventSchema = z
  .object({
    at: z.string().max(30),
    kind: z.enum(["held", "released", "admitted", "dropped", "cancelled", "failed"]),
    number: z.number().int().positive(),
    shadow: z.boolean(),
    detail: z.string().max(120).nullable(),
  })
  .strict();

const stateSchema = z
  .object({
    version: z.literal(1),
    capacity: z.number().int().min(1).max(CI_ADMISSION_MAX_CAPACITY),
    queue: z.array(queueEntrySchema).max(MAX_QUEUE),
    /** Pull requests this admission released or let through, within the grace period. */
    released: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            atMs: z.number().int().nonnegative(),
            /** Its runs have been seen: from then on they, not the reservation, count. */
            observed: z.boolean().default(false),
          })
          .strict(),
      )
      .max(MAX_QUEUE),
    events: z.array(eventSchema).max(MAX_EVENTS),
    /** The latest round: when, how many slots were in use after it, and by which pull requests. */
    lastRound: z
      .object({
        at: z.string().max(30),
        used: z.number().int().nonnegative(),
        running: z
          .array(z.object({ number: z.number().int().positive(), title: z.string().max(200), base: z.string().max(100) }).strict())
          .max(MAX_QUEUE),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CiAdmissionQueueEntry = z.infer<typeof queueEntrySchema>;
export type CiAdmissionEvent = z.infer<typeof eventSchema>;
export type CiAdmissionState = z.infer<typeof stateSchema>;

export const emptyCiAdmissionState = (): CiAdmissionState => ({
  version: 1,
  capacity: CI_ADMISSION_DEFAULT_CAPACITY,
  queue: [],
  released: [],
  events: [],
  lastRound: null,
});

/** The stored state, or an empty one when nothing (or something unreadable) is stored. */
export function parseCiAdmissionState(value: string | null | undefined): CiAdmissionState {
  if (!value) return emptyCiAdmissionState();
  try {
    const parsed = stateSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : emptyCiAdmissionState();
  } catch {
    return emptyCiAdmissionState();
  }
}

export type CiAdmissionAction =
  | { kind: "hold"; pull: CiAdmissionPull }
  | { kind: "release"; pull: CiAdmissionPull }
  | { kind: "cancel"; pull: CiAdmissionPull };

export type CiAdmissionEvaluation = {
  state: CiAdmissionState;
  actions: CiAdmissionAction[];
  /** Slots in use after this evaluation's releases. */
  used: number;
  /**
   * When someone waits and a reservation is still unobserved: how long until it
   * expires, so the caller can judge again then without waiting for an event.
   */
  nextCheckInMs: number | null;
};

/**
 * One evaluation. `arrival` is the pull request whose event triggered it when
 * that event made it ready for review; `runningShas` are the head SHAs with a
 * pull_request workflow run queued or in progress.
 */
export function evaluateCiAdmission(input: {
  state: CiAdmissionState;
  openPulls: readonly CiAdmissionPull[];
  runningShas: ReadonlySet<string>;
  arrival: number | null;
  nowMs: number;
  shadow: boolean;
}): CiAdmissionEvaluation {
  const { nowMs, shadow } = input;
  const at = new Date(nowMs).toISOString();
  const open = new Map(input.openPulls.map((pull) => [pull.number, pull]));
  const events: CiAdmissionEvent[] = [];
  const event = (kind: CiAdmissionEvent["kind"], number: number, detail: string | null = null) =>
    events.push({ at, kind, number, shadow, detail });

  const released = input.state.released
    .filter((entry) => nowMs - entry.atMs < CI_ADMISSION_RELEASE_GRACE_MS && open.get(entry.number)?.draft === false)
    .map((entry) => ({ ...entry, observed: entry.observed || input.runningShas.has(open.get(entry.number)!.headSha) }));
  // Ours: its own ready event is not an arrival. Reserved: counts until its runs are seen.
  const releasedNumbers = new Set(released.map((entry) => entry.number));
  const reserved = () => new Set(released.filter((entry) => !entry.observed).map((entry) => entry.number));

  // The line keeps only open drafts admission still handles.
  const queue: CiAdmissionQueueEntry[] = [];
  for (const entry of input.state.queue) {
    const pull = open.get(entry.number);
    if (!pull || ciAdmissionUnits(pull) === null) {
      event("dropped", entry.number, pull ? "not_handled" : "closed");
      continue;
    }
    if (!pull.draft && entry.number !== input.arrival) {
      // Made ready by someone else while waiting: it runs; it no longer waits.
      event("dropped", entry.number, "ready_elsewhere");
      continue;
    }
    queue.push({ ...entry, title: pull.title.slice(0, 200), base: pull.base, head: pull.head.slice(0, 200) });
  }

  const running = (pull: CiAdmissionPull) => !pull.draft && (input.runningShas.has(pull.headSha) || reserved().has(pull.number));
  const usedBy = (exclude: number | null) =>
    input.openPulls.reduce((sum, pull) => {
      const units = ciAdmissionUnits(pull);
      return units !== null && pull.number !== exclude && running(pull) ? sum + units : sum;
    }, 0);

  const actions: CiAdmissionAction[] = [];
  const capacity = input.state.capacity;

  const arrival = input.arrival === null ? undefined : open.get(input.arrival);
  if (arrival && !arrival.draft && ciAdmissionUnits(arrival) !== null && !releasedNumbers.has(arrival.number)) {
    const units = ciAdmissionUnits(arrival)!;
    const waiting = queue.some((entry) => entry.number !== arrival.number);
    if (waiting || usedBy(arrival.number) + units > capacity) {
      actions.push({ kind: "hold", pull: arrival });
      if (!queue.some((entry) => entry.number === arrival.number)) {
        queue.push({ number: arrival.number, title: arrival.title.slice(0, 200), base: arrival.base, head: arrival.head.slice(0, 200), queuedAt: at });
      }
      event("held", arrival.number, waiting ? "line_waiting" : "no_slot");
    } else {
      const index = queue.findIndex((entry) => entry.number === arrival.number);
      if (index >= 0) queue.splice(index, 1);
      released.push({ number: arrival.number, atMs: nowMs, observed: input.runningShas.has(arrival.headSha) });
      event("admitted", arrival.number, null);
    }
  }

  // A draft running CI is a replayed event: stop it. (A pull request held in
  // this evaluation has its runs cancelled by the hold itself.)
  const holding = new Set(actions.map((action) => action.pull.number));
  for (const pull of input.openPulls) {
    if (!pull.draft || ciAdmissionUnits(pull) === null || holding.has(pull.number)) continue;
    if (!input.runningShas.has(pull.headSha)) continue;
    actions.push({ kind: "cancel", pull });
    event("cancelled", pull.number, "draft_rerun");
  }

  // Release strictly from the top: the operator's order is the order.
  let used = usedBy(null);
  const releasedNow = new Set<number>();
  const heldNow = new Set(actions.filter((action) => action.kind === "hold").map((action) => action.pull.number));
  while (queue.length > 0) {
    const top = queue[0];
    const pull = open.get(top.number);
    if (!pull) break;
    const units = ciAdmissionUnits(pull)!;
    // A pull request held in this same evaluation is a draft from here on.
    const asDraft = heldNow.has(pull.number) ? { ...pull, draft: true } : pull;
    if (used + units > capacity) break;
    queue.shift();
    actions.push({ kind: "release", pull: asDraft });
    released.push({ number: pull.number, atMs: nowMs, observed: false });
    releasedNow.add(pull.number);
    used += units;
    event("released", pull.number, null);
  }

  return {
    state: {
      version: 1,
      capacity,
      queue,
      released,
      events: [...input.state.events, ...events].slice(-MAX_EVENTS),
      lastRound: {
        at,
        used,
        running: input.openPulls
          .filter((pull) => ciAdmissionUnits(pull) !== null && (running(pull) || releasedNow.has(pull.number)))
          .map((pull) => ({ number: pull.number, title: pull.title.slice(0, 200), base: pull.base })),
      },
    },
    actions,
    used,
    nextCheckInMs:
      queue.length === 0
        ? null
        : released
            .filter((entry) => !entry.observed)
            .reduce<number | null>((soonest, entry) => {
              const left = Math.max(1_000, entry.atMs + CI_ADMISSION_RELEASE_GRACE_MS - nowMs);
              return soonest === null ? left : Math.min(soonest, left);
            }, null),
  };
}

/** The queue in a new order the operator gave: exactly the same numbers, rearranged. */
export function reorderCiAdmissionQueue(state: CiAdmissionState, order: readonly number[]): CiAdmissionState | null {
  const current = state.queue.map((entry) => entry.number);
  if (order.length !== current.length || new Set(order).size !== order.length) return null;
  if (!order.every((number) => current.includes(number))) return null;
  const byNumber = new Map(state.queue.map((entry) => [entry.number, entry]));
  return { ...state, queue: order.map((number) => byNumber.get(number)!) };
}
