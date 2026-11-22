/**
 * Pure rules for the Execution board's hierarchy list (owner decision
 * 2026-11-21): which hierarchies still carry work, which are clean-up
 * candidates, how the list is sorted and how a search query matches.
 *
 * A hierarchy's numbers are a rollup of the Task cards under it. Cancelled
 * Tasks are counted apart and leave the total, so a hierarchy whose open work
 * was cancelled can finish. `openCards` mirrors the database archive guard
 * (any card directly under a Feature that is neither done nor cancelled,
 * archived cards included), so the list never offers an archive the database
 * would refuse.
 */

export const AMUX_HIERARCHY_SCOPES = ["active", "cleanup", "all"] as const;
export type AmuxHierarchyScope = (typeof AMUX_HIERARCHY_SCOPES)[number];
export const AMUX_HIERARCHY_SORTS = ["remaining", "activity", "created", "stale"] as const;
export type AmuxHierarchySort = (typeof AMUX_HIERARCHY_SORTS)[number];
export const AMUX_HIERARCHY_CREATED_WITHIN = [7, 30, 90] as const;
/** An active hierarchy with no card change for this long is shown as stalled. */
export const AMUX_HIERARCHY_STALE_DAYS = 7;
export const AMUX_HIERARCHY_SEARCH_MAX_LENGTH = 80;
/** One archive request names at most this many hierarchies. */
export const AMUX_HIERARCHY_ARCHIVE_MAX_NODES = 200;
export const AMUX_HIERARCHY_ARCHIVE_SWITCH = "AMUX_HIERARCHY_ARCHIVE_ENABLED";
export const AMUX_HIERARCHY_ARCHIVE_ACTION = "amux.hierarchy.archive";

const DAY_MS = 86_400_000;

export type AmuxHierarchyDistribution = {
  done: number; review: number; doing: number; todo: number;
  backlog: number; attention: number;
};

export type AmuxHierarchyRollup = {
  /** Tasks that are not cancelled and not archived. */
  total: number;
  done: number;
  cancelled: number;
  remaining: number;
  distribution: AmuxHierarchyDistribution;
  /** Cards the database archive guard would count as still open. */
  openCards: number;
  lastActivityAt: string | null;
};

export type AmuxHierarchyClass = "active" | "complete" | "empty";

export type AmuxHierarchyFact = {
  id: string;
  createdAt: string;
  rollup: AmuxHierarchyRollup;
};

export const emptyAmuxHierarchyRollup = (): AmuxHierarchyRollup => ({
  total: 0, done: 0, cancelled: 0, remaining: 0, openCards: 0, lastActivityAt: null,
  distribution: { done: 0, review: 0, doing: 0, todo: 0, backlog: 0, attention: 0 },
});

export type AmuxHierarchyRollupRow = {
  total: number; done: number; cancelled: number; review: number; doing: number;
  todo: number; backlog: number; attention: number; openCards: number;
  lastActivityAt: Date | null;
};

export function amuxHierarchyRollupFromRow(row: AmuxHierarchyRollupRow | undefined):
  AmuxHierarchyRollup {
  if (!row) return emptyAmuxHierarchyRollup();
  const n = (value: unknown) => Number(value) || 0;
  const total = n(row.total);
  const done = n(row.done);
  return {
    total, done, cancelled: n(row.cancelled), remaining: Math.max(total - done, 0),
    openCards: n(row.openCards),
    lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
    distribution: { done, review: n(row.review), doing: n(row.doing), todo: n(row.todo),
      backlog: n(row.backlog), attention: n(row.attention) },
  };
}

export function amuxHierarchyClass(rollup: AmuxHierarchyRollup): AmuxHierarchyClass {
  if (rollup.remaining > 0) return "active";
  return rollup.total > 0 ? "complete" : "empty";
}

/** The newest card change, or the hierarchy's own creation when it has none. */
export const amuxHierarchyActivityMs = (fact: AmuxHierarchyFact) =>
  Date.parse(fact.rollup.lastActivityAt ?? fact.createdAt);

export function amuxHierarchyStale(fact: AmuxHierarchyFact, nowMs: number) {
  return amuxHierarchyClass(fact.rollup) === "active" &&
    nowMs - amuxHierarchyActivityMs(fact) >= AMUX_HIERARCHY_STALE_DAYS * DAY_MS;
}

/** Archive only what has no remaining Task and no card the guard counts as open. */
export const amuxHierarchyArchivable = (rollup: AmuxHierarchyRollup) =>
  rollup.remaining === 0 && rollup.openCards === 0;

export const amuxHierarchyDefaultSort = (scope: AmuxHierarchyScope): AmuxHierarchySort =>
  scope === "active" ? "remaining" : scope === "cleanup" ? "stale" : "activity";

export function parseAmuxHierarchyScope(raw: string | null): AmuxHierarchyScope | null {
  if (raw === null) return "active";
  return AMUX_HIERARCHY_SCOPES.find((scope) => scope === raw) ?? null;
}

export function parseAmuxHierarchySort(raw: string | null, scope: AmuxHierarchyScope):
  AmuxHierarchySort | null {
  if (raw === null) return amuxHierarchyDefaultSort(scope);
  return AMUX_HIERARCHY_SORTS.find((sort) => sort === raw) ?? null;
}

/** `undefined` for a malformed value, `null` for no filter. */
export function parseAmuxHierarchyCreatedWithin(raw: string | null): number | null | undefined {
  if (raw === null) return null;
  const days = AMUX_HIERARCHY_CREATED_WITHIN.find((value) => String(value) === raw);
  return days ?? undefined;
}

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");

export function parseAmuxHierarchySearch(raw: string | null): string | null {
  if (raw === null) return null;
  const query = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!query || [...query].length > AMUX_HIERARCHY_SEARCH_MAX_LENGTH) return null;
  // Control and format characters never come from a person typing a search.
  if (/[\p{Cc}\p{Cf}]/u.test(query)) return null;
  return query;
}

/** Case- and width-insensitive substring match over any of the given texts. */
export function amuxHierarchyMatches(query: string, ...texts: Array<string | null | undefined>) {
  const needle = fold(query);
  return texts.some((text) => typeof text === "string" && fold(text).includes(needle));
}

export type AmuxHierarchySelection = {
  scope: AmuxHierarchyScope;
  sort: AmuxHierarchySort;
  createdWithinDays: number | null;
  nowMs: number;
};

export function selectAmuxHierarchies<T extends AmuxHierarchyFact>(facts: T[],
  selection: AmuxHierarchySelection): T[] {
  const { scope, sort, createdWithinDays, nowMs } = selection;
  const inScope = facts.filter((fact) => {
    const kind = amuxHierarchyClass(fact.rollup);
    if (scope === "active" && kind !== "active") return false;
    if (scope === "cleanup" && kind === "active") return false;
    if (createdWithinDays !== null &&
        nowMs - Date.parse(fact.createdAt) > createdWithinDays * DAY_MS) return false;
    return true;
  });
  const created = (fact: T) => Date.parse(fact.createdAt);
  const activity = amuxHierarchyActivityMs;
  const byId = (a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const compare: Record<AmuxHierarchySort, (a: T, b: T) => number> = {
    remaining: (a, b) => b.rollup.remaining - a.rollup.remaining ||
      activity(b) - activity(a) || created(a) - created(b) || byId(a, b),
    activity: (a, b) => activity(b) - activity(a) || created(b) - created(a) || byId(a, b),
    created: (a, b) => created(b) - created(a) || byId(a, b),
    stale: (a, b) => activity(a) - activity(b) || created(a) - created(b) || byId(a, b),
  };
  return inScope.sort(compare[sort]);
}

export type AmuxHierarchySummary = {
  active: number; complete: number; empty: number; stale: number;
  cleanup: number; all: number;
  tasksDone: number; tasksTotal: number; remaining: number;
};

export function summarizeAmuxHierarchies(facts: AmuxHierarchyFact[], nowMs: number):
  AmuxHierarchySummary {
  const summary: AmuxHierarchySummary = { active: 0, complete: 0, empty: 0, stale: 0,
    cleanup: 0, all: facts.length, tasksDone: 0, tasksTotal: 0, remaining: 0 };
  for (const fact of facts) {
    summary[amuxHierarchyClass(fact.rollup)] += 1;
    if (amuxHierarchyStale(fact, nowMs)) summary.stale += 1;
    summary.tasksDone += fact.rollup.done;
    summary.tasksTotal += fact.rollup.total;
    summary.remaining += fact.rollup.remaining;
  }
  summary.cleanup = summary.complete + summary.empty;
  return summary;
}

export const amuxHierarchyArchiveEnabled = (env: Record<string, string | undefined>) =>
  env[AMUX_HIERARCHY_ARCHIVE_SWITCH] === "1";

export type AmuxHierarchyArchiveRefusalCode =
  "disabled" | "not_found" | "not_active" | "remaining_work" | "open_cards";

export class AmuxHierarchyArchiveRefusal extends Error {
  constructor(readonly code: AmuxHierarchyArchiveRefusalCode, readonly nodeId: string | null) {
    super(`hierarchy archive refused: ${code}`);
    this.name = "AmuxHierarchyArchiveRefusal";
  }
}
