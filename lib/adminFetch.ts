/**
 * `fetch` for the Admin Console, with a deadline.
 *
 * Thirty-three of the console's thirty-four fetching panels had none. The one
 * that did -- `AdminModelRegistryPanel`, on a single call -- put it there by
 * hand. `/api/ready` has used a timeout on its database probe since it was
 * written, so this is not a technique the codebase lacked; the console just
 * never got it.
 *
 * A request with no deadline does not fail, it hangs, and a panel spinning
 * forever is the same defect as one that reports something untrue: the operator
 * learns nothing either way, and has nothing to act on. It matters most when
 * the platform is slow, which is when they are looking.
 *
 * ## Deliberately a drop-in
 *
 * Same signature as `fetch`, same return, one added behaviour. Seventy-eight
 * call sites already parse their own responses in ways that differ for good
 * reasons, and rewriting all of them to a richer client would have been a large
 * semantic change to code nobody can exercise panel by panel. This changes only
 * what every one of them was missing. Richer handling -- 409 approvals, 428
 * step-ups -- stays in `lib/adminApiOutcome.ts`, where the panels that can
 * receive those answers call it explicitly.
 *
 * `tests/adminFetchDeadline.test.mjs` forbids a bare `fetch(` under
 * `components/admin/`, which is what stops the next panel from omitting it.
 */

/**
 * Long enough that a slow but working request finishes, short enough that a
 * hung one is reported while the operator is still looking at the screen.
 *
 * Fifteen seconds rather than the browser default of none. Admin reads are
 * bounded queries and admin writes are single transactions; the endpoint that
 * legitimately runs longer -- the audit chain walk -- is given its own value by
 * its caller rather than raising the floor for everything.
 */
export const ADMIN_FETCH_TIMEOUT_MS = 15_000;

export type AdminFetchInit = RequestInit & {
  /** Overrides the default deadline. Pass `null` to opt out entirely. */
  timeoutMs?: number | null;
};

/**
 * Combines the caller's abort signal with the deadline.
 *
 * `AbortSignal.any` is what this wants and is not guaranteed everywhere the
 * console runs, so the fallback keeps the deadline rather than dropping it:
 * losing the caller's own cancellation is recoverable, losing the deadline is
 * the defect being fixed.
 */
const withDeadline = (
  signal: AbortSignal | null | undefined,
  timeoutMs: number
): AbortSignal => {
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, deadline]);
  }
  return deadline;
};

export const adminFetch = (
  input: RequestInfo | URL,
  init: AdminFetchInit = {}
): Promise<Response> => {
  const { timeoutMs, signal, ...rest } = init;
  if (timeoutMs === null) {
    return fetch(input, { ...rest, ...(signal ? { signal } : {}) });
  }
  return fetch(input, {
    ...rest,
    signal: withDeadline(signal, timeoutMs ?? ADMIN_FETCH_TIMEOUT_MS),
  });
};

/**
 * Whether a caught error is this deadline rather than a real failure.
 *
 * `AbortSignal.timeout` rejects with `TimeoutError`; a caller's own abort
 * rejects with `AbortError`. A panel that reports "the request failed" for an
 * abort it issued itself is telling the operator about its own bookkeeping.
 */
export const isAdminFetchTimeout = (error: unknown) =>
  error instanceof DOMException && error.name === "TimeoutError";

export const isAdminFetchAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";
