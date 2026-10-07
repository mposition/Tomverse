/**
 * What the Admin genesis screen may say about one request
 * (docs/policy/sre-ops.md §3 rule 7, §8). Only a 200 carrying a genesis id is
 * "created", only a 409 carrying one of the store's pre-write refusal codes is
 * a refusal (nothing was written) -- `late` is not one, because the route
 * answers it for a deadline missed after the commit too --
 * and a step-up refusal is its own answer. Everything else -- a 500, an
 * unreadable body, a timeout, a lost response -- may have followed a commit,
 * so it is "unknown" and the screen re-reads the chain instead of claiming
 * the genesis was not approved.
 */
export type GenesisOutcome =
  | { kind: "created"; genesisId: string }
  | { kind: "refused"; code: string }
  | { kind: "requiresReauthentication" }
  | { kind: "unknown" };

/** The store's refusals, each decided before anything is written. */
export const GENESIS_PRE_WRITE_REFUSALS: readonly string[] = Object.freeze([
  "stale",
  "genesis_too_soon",
  "transition_refused",
  "already_consumed",
]);

export function genesisOutcome(
  answer: { status: number; payload: { code?: unknown; result?: { genesisId?: unknown } } } | "no_answer",
): GenesisOutcome {
  if (answer === "no_answer") return { kind: "unknown" };
  const { status, payload } = answer;
  if (status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") return { kind: "requiresReauthentication" };
  if (status === 409 && typeof payload.code === "string" && GENESIS_PRE_WRITE_REFUSALS.includes(payload.code)) {
    return { kind: "refused", code: payload.code };
  }
  if (status === 200 && typeof payload.result?.genesisId === "string") {
    return { kind: "created", genesisId: payload.result.genesisId };
  }
  return { kind: "unknown" };
}
