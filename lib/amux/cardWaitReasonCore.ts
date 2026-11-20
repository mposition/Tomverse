/**
 * Why a card is not running, as data (owner decision 2026-11-15).
 *
 * Production 2026-11-15: the claim tick logged one aggregate line per round
 * (`skipped: {task_not_ready: 2, worker_unavailable: 1}`) and AMUX-FILEGEN2-003
 * and -004 were `task_not_ready` on every round with nothing on their cards to
 * say why. Each pass of the automatic promotion and the claim now stores, per
 * card it passed over, the reason code and its structured detail: the
 * readiness refusals, and for a card no worker could take, each approved
 * route's worker and the first reason it could not take it.
 *
 * Codes and worker names only; never a worker's text. The copy that turns a
 * code into a sentence lives in lib/adminMessages/amuxExecution.ts.
 *
 * Pure and dependency-free.
 */

export const AMUX_CARD_WAIT_STAGES = ["promotion", "claim"] as const;
export type AmuxCardWaitStage = (typeof AMUX_CARD_WAIT_STAGES)[number];

/** The most routes one detail names. */
export const AMUX_CARD_WAIT_MAX_ROUTES = 16;
/** A reason not seen again for this long no longer describes the card. */
export const AMUX_CARD_WAIT_STALE_MS = 30 * 60_000;
/** A card waiting this long for the same reason is raised as an incident. */
export const AMUX_CARD_WAIT_INCIDENT_MS = 60 * 60_000;
/** The most cards one incident names; the count says how many there were. */
export const AMUX_CARD_WAIT_INCIDENT_TASKS = 10;

export type AmuxCardWaitRoute = { worker: string; provider: string; why: string };
export type AmuxCardWaitDetail = {
  /** Readiness refusals (lib/amux/v4TaskReadyCore.ts). */
  reasons?: string[];
  /** Each approved route and the first reason it could not take the card. */
  routes?: AmuxCardWaitRoute[];
  /** The reason held every card of the pass, not this one alone. */
  holdsAll?: boolean;
  limit?: string;
  attemptsUsed?: number;
  maxAttempts?: number;
};

const CODE = /^[a-z0-9_]{1,64}$/;
const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ?
    value as number : undefined;

export const amuxCardWaitCodeValid = (value: unknown): value is string =>
  typeof value === "string" && CODE.test(value);

/** A stored or received detail with anything that is not a code dropped. */
export function amuxCardWaitDetail(value: unknown): AmuxCardWaitDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const detail: AmuxCardWaitDetail = {};
  if (Array.isArray(raw.reasons))
    detail.reasons = [...new Set(raw.reasons.filter(amuxCardWaitCodeValid))].slice(0, 16);
  if (Array.isArray(raw.routes)) detail.routes = raw.routes.flatMap((route) => {
    if (!route || typeof route !== "object") return [];
    const { worker, provider, why } = route as Record<string, unknown>;
    return typeof worker === "string" && NAME.test(worker) &&
      typeof provider === "string" && NAME.test(provider) && amuxCardWaitCodeValid(why) ?
      [{ worker, provider, why }] : [];
  }).slice(0, AMUX_CARD_WAIT_MAX_ROUTES);
  if (raw.holdsAll === true) detail.holdsAll = true;
  if (amuxCardWaitCodeValid(raw.limit)) detail.limit = raw.limit;
  const used = count(raw.attemptsUsed);
  const max = count(raw.maxAttempts);
  if (used !== undefined) detail.attemptsUsed = used;
  if (max !== undefined) detail.maxAttempts = max;
  return detail;
}

/** The stage a card's status is waited on in. */
const STAGE_STATUS: Readonly<Record<AmuxCardWaitStage, string>> = Object.freeze({
  promotion: "backlog", claim: "todo",
});

/** Whether a stored reason still describes the card as it is now. */
export function amuxCardWaitVisible(input: { stage: string; lastSeenAtMs: number;
  cardStatus: string; assigned: boolean; nowMs: number }): boolean {
  const status = (STAGE_STATUS as Record<string, string | undefined>)[input.stage];
  return status !== undefined && status === input.cardStatus && !input.assigned &&
    input.nowMs - input.lastSeenAtMs <= AMUX_CARD_WAIT_STALE_MS;
}

/**
 * The wait a card's own state shows when no pass stored one: a backlog card
 * the promotion never read because its score is stale or a dependency is
 * unfinished. Null when nothing is known.
 */
export function amuxCardWaitFromState(input: { sourceSystem: string | null;
  cardType: string | null; status: string; assigned: boolean; scoreFresh: boolean;
  openDependencies: number }): { stage: AmuxCardWaitStage; code: string } | null {
  if (input.sourceSystem !== "admin-idea-v4" || input.cardType !== "task" ||
      input.assigned || input.status !== "backlog") return null;
  if (input.openDependencies > 0) return { stage: "promotion", code: "dependency_incomplete" };
  if (!input.scoreFresh) return { stage: "promotion", code: "score_stale" };
  return null;
}

/** Waits that clear by themselves and are never raised: the workers are all
 * busy, another pass just took the card, or a dependency is still running. */
const ORDINARY = new Set(["global_capacity_full", "conflict", "not_unassigned_todo",
  "infra_retry_backoff", "result_retry_backoff"]);
const ORDINARY_READINESS = new Set(["dependency_incomplete", "already_assigned", "not_backlog"]);

export function amuxCardWaitOrdinary(code: string, detail: AmuxCardWaitDetail): boolean {
  if (ORDINARY.has(code)) return true;
  return code === "task_not_ready" && (detail.reasons ?? []).length > 0 &&
    (detail.reasons ?? []).every((reason) => ORDINARY_READINESS.has(reason));
}

export type AmuxCardWaitRow = {
  taskId: string;
  displayKey: string | null;
  stage: string;
  code: string;
  detail: AmuxCardWaitDetail;
  firstSeenAtMs: number;
  reportedAtMs: number | null;
};

/**
 * The cards a claim wait has held for AMUX_CARD_WAIT_INCIDENT_MS that were not
 * yet raised, and the one incident text naming them. The promotion stage has
 * its own notice (lib/amux/v22PromotionBlockedCore.ts) and is left out here.
 */
export function amuxCardWaitIncident(rows: readonly AmuxCardWaitRow[], nowMs: number):
  { taskIds: string[]; count: number; codes: Record<string, number>; tasks: string } | null {
  const due = rows.filter((row) => row.stage === "claim" && row.reportedAtMs === null &&
    !amuxCardWaitOrdinary(row.code, row.detail) &&
    nowMs - row.firstSeenAtMs >= AMUX_CARD_WAIT_INCIDENT_MS)
    .sort((a, b) => (a.displayKey ?? a.taskId).localeCompare(b.displayKey ?? b.taskId));
  if (due.length === 0) return null;
  const codes: Record<string, number> = {};
  for (const row of due) codes[row.code] = (codes[row.code] ?? 0) + 1;
  return {
    taskIds: due.map((row) => row.taskId),
    count: due.length,
    codes,
    tasks: due.slice(0, AMUX_CARD_WAIT_INCIDENT_TASKS).map((row) => {
      const why = row.detail.reasons?.length ? row.detail.reasons.join("+") :
        row.detail.routes?.length ?
          [...new Set(row.detail.routes.map((route) => route.why))].join("+") : null;
      return `${row.displayKey ?? row.taskId}: ${row.code}${why ? ` (${why})` : ""}`;
    }).join("; "),
  };
}
