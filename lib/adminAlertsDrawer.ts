/**
 * What the notification drawer shows, decided in one place.
 *
 * The drawer used to write rows only on a 2xx and say nothing otherwise, so a
 * 500, a 403 or a dropped connection left the list empty and the drawer
 * rendered "No notification records." An operator opening the alerts drawer
 * during an incident was told there were no alerts, on the strength of never
 * having read any.
 *
 * `lib/adminNavigationCounts.ts` already states the rule this breaks -- "zero
 * is a claim and an unknown count is not" -- and applies it to the sidebar
 * badges. The drawer those badges point at did not.
 *
 * A function rather than a ternary inside the component, because the defect
 * was the *order* of the branches and a branch order is only testable if
 * something can call it. `tests/adminAlertsDrawer.test.mjs` pins that an
 * unreadable response never reaches the empty state.
 *
 * Deliberately specific to this drawer. The same defect is in other admin
 * panels that fetch a list, and when one of them is fixed this is the shape
 * the fix takes -- but an interface written for one caller takes the shape of
 * that caller, so it gets generalised when there is a second, not before.
 */

/** Why a read produced nothing. Distinguished because the copy differs. */
export type AdminAlertsFailure =
  | { reason: "status"; status: number }
  | { reason: "network" };

export type AdminAlertsView =
  | { kind: "loading" }
  | { kind: "unreadable"; failure: AdminAlertsFailure }
  | { kind: "empty" }
  | { kind: "rows" };

export const adminAlertsDrawerView = (input: {
  loading: boolean;
  failure: AdminAlertsFailure | null;
  rowCount: number;
}): AdminAlertsView => {
  if (input.loading) return { kind: "loading" };
  // Before `empty`, always. This ordering is the whole point of the module:
  // a failed read holds no rows, so a later `rowCount === 0` test would
  // classify every failure as an empty inbox.
  if (input.failure) return { kind: "unreadable", failure: input.failure };
  return input.rowCount > 0 ? { kind: "rows" } : { kind: "empty" };
};

/**
 * Whether opening the drawer should fetch again.
 *
 * The old guard was `rows.length > 0 || loading`, which never re-fetched after
 * a failure: the list is still empty, so the guard returned every time and the
 * drawer stayed stuck on whatever it first failed with. A retry has to be
 * reachable by closing and reopening, not only by the button.
 */
export const adminAlertsShouldFetch = (input: {
  loading: boolean;
  failure: AdminAlertsFailure | null;
  rowCount: number;
}) => !input.loading && (input.failure !== null || input.rowCount === 0);
