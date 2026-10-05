/**
 * What the Admin genesis screen may say about one request
 * (docs/policy/sre-ops.md §3 rule 7, §8). Only a 200 carrying a genesis id is
 * "created", only a 409 carrying a code is a refusal (nothing was written),
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

export function genesisOutcome(
  answer: { status: number; payload: { code?: unknown; result?: { genesisId?: unknown } } } | "no_answer",
): GenesisOutcome {
  if (answer === "no_answer") return { kind: "unknown" };
  const { status, payload } = answer;
  if (status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") return { kind: "requiresReauthentication" };
  if (status === 409 && typeof payload.code === "string") return { kind: "refused", code: payload.code };
  if (status === 200 && typeof payload.result?.genesisId === "string") {
    return { kind: "created", genesisId: payload.result.genesisId };
  }
  return { kind: "unknown" };
}
