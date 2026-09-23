/**
 * What a candidate's verdict can say, and when it is well formed.
 *
 * Dark, like the table. Nothing writes verdicts yet.
 *
 * ## Why this table exists at all
 *
 * `RoutingRun.rejectedByReason` records a count per reason, on the stated
 * ground that which models were refused is stable catalogue information a
 * reader can reconstruct. It is not. Candidates come from the runtime registry
 * -- `enabled`, `catalogDeleted`, `minimumPlan`, the context window and backend
 * readiness all move -- and the health and credit verdicts are that moment's
 * state. Nothing about a past decision can be rebuilt from a count.
 *
 * ## Why eligible candidates are recorded too
 *
 * An earlier draft held only rejections, which left it unable to answer why a
 * model that passed every filter still lost. That is the question the table
 * exists for; a rejection log answers a different one.
 *
 * Design: .github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md §8.5
 *
 * Pure: no database, no clock, no network.
 */

import { CANDIDATE_REJECTIONS } from "@/lib/routerCandidates";

export const ROUTING_CANDIDATE_VERDICTS = ["eligible", "rejected"] as const;

export type RoutingCandidateVerdictKind =
    (typeof ROUTING_CANDIDATE_VERDICTS)[number];

/**
 * Why a verdict row is not well formed, or an empty list.
 *
 * The database holds the same rules as CHECKs. Stated here so a caller can
 * refuse before writing and say which part is wrong, rather than catching a
 * constraint error that names only the constraint.
 */
export const routingCandidateVerdictProblems = (input: {
    verdict: string;
    reason?: string | null;
    rank?: number | null;
    rankBucket?: number | null;
}): readonly string[] => {
    if (!(ROUTING_CANDIDATE_VERDICTS as readonly string[]).includes(input.verdict)) {
        return [`unknown verdict ${JSON.stringify(input.verdict)}`];
    }

    const problems: string[] = [];

    if (input.verdict === "rejected") {
        // A rejection says why. Without one the row records that something was
        // refused and loses the only part worth keeping.
        if (!input.reason) problems.push("a rejection names its reason");
        // A rank is a position among the candidates that survived. A rejected
        // one was never in that order, and giving it a place puts it in an
        // order it was not in.
        if (input.rank !== null && input.rank !== undefined) {
            problems.push("a rejected candidate was never ranked");
        }
        if (input.rankBucket !== null && input.rankBucket !== undefined) {
            problems.push("a rejected candidate is in no rank bucket");
        }
    } else if (input.reason) {
        problems.push("an eligible candidate has no rejection reason");
    }

    if (
        input.reason &&
        !(CANDIDATE_REJECTIONS as readonly string[]).includes(input.reason)
    ) {
        problems.push(`unknown rejection reason ${JSON.stringify(input.reason)}`);
    }

    if (typeof input.rank === "number" && (!Number.isInteger(input.rank) || input.rank < 1)) {
        problems.push("a rank starts at one");
    }
    if (
        typeof input.rankBucket === "number" &&
        (!Number.isInteger(input.rankBucket) || input.rankBucket < 0)
    ) {
        problems.push("a rank bucket starts at zero");
    }

    return problems;
};
