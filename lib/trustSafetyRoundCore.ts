/**
 * The round's two decisions, with no database and no clock of their own
 * (docs/policy/trust-safety-compliance-agent.md §5.5, §6, §4).
 *
 * `lib/trustSafetyObserverRound.ts` runs the transactions; these are the
 * judgements it makes between them, kept here so they can be checked without a
 * database:
 *
 *   - whether a batch may start at all, which §5.5 fixes as "not with less
 *     than its guarded budget left";
 *   - what the round answers for a derived activation, which §4 narrows to
 *     three values and §6 keeps distinct from each other.
 */

import { trustSafetyBound, type TrustSafetyTransactionKind } from "@/lib/trustSafetyBoundsCore";
import type { ActivationState } from "@/lib/trustSafetyActivationCore";

/**
 * Whether `kind` may start with `elapsedMs` of the route budget spent.
 *
 * §5.5: a batch that does not fit in what is left does not start, and not
 * starting means no run row and no ping. The comparison is against the kind's
 * guarded budget rather than its deadline because they are the same figure by
 * §12's one expression -- and against a monotonic elapsed time, so a wall-clock
 * step does not hand the round budget it does not have.
 */
export const budgetAllowsBatch = ({
  kind,
  elapsedMs,
  budgetMs,
}: {
  readonly kind: TrustSafetyTransactionKind;
  readonly elapsedMs: number;
  readonly budgetMs: number;
}): boolean => {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return budgetMs - elapsedMs >= trustSafetyBound(kind).cGuardedMs;
};

/** What the round does next, once activation is derived. */
export type ActivationVerdict = "observe" | "disabled" | "failed";

/**
 * §4's enum, chosen from §6's derivation.
 *
 * The three answers are not interchangeable, and the policy is explicit about
 * two of them: a fault that stops counting is **not** `disabled`, because
 * reporting an unverifiable chain as "off" would make a tampered switch look
 * like a deliberate one. And the sixth fault -- on with no ping URL -- is not a
 * failure: it withholds the ping and the round still observes and records, so
 * the monitor reports the silence instead.
 */
/**
 * Where to look for check 7's successor: the next entry by position, never by
 * the link being checked.
 *
 * Independent review found the mistake this replaces. Selecting the successor
 * with `previousHash = <the bound entry's hash>` asks the chain whether it is
 * intact and believes the answer: cut the next entry's `previousHash` and the
 * query returns nothing, the derivation reads that as "no successor exists",
 * and the round observes and pings with the chain broken behind it. The
 * successor is whichever entry comes next, and whether it points back at the
 * bound one is then a question the derivation can actually answer.
 *
 * The order is `createdAt` then `id`, matching the order the newest entry is
 * chosen with, so a pair written inside the same millisecond resolves the same
 * way in both directions. The tiebreak is why the condition is a disjunction
 * rather than `createdAt > x`: entries sharing a timestamp would otherwise be
 * skipped, and the one that cut the chain could be among them.
 */
export const successorAfterEntry = ({
  createdAt,
  id,
}: {
  readonly createdAt: Date;
  readonly id: string;
}) => ({
  where: {
    OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }],
  },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
}) as const;

export const activationVerdict = (state: ActivationState): ActivationVerdict => {
  // A null mode is exactly §6's refusal: every fault that stops counting
  // leaves the mode unbelieved. `countPermitted` is not the test here -- an
  // observer that is legitimately off also counts nothing, and reading it as
  // the signal would report a switch someone turned off as a failure.
  if (state.mode === null) return "failed";
  return state.mode === "on" ? "observe" : "disabled";
};
