import {
    findApprovedEvalPair,
    MEMORY_EXTRACTION_EVAL_REGISTER,
    type MemoryExtractionEvalEntry,
} from "@/lib/memoryExtractionEvalRegister";
import type { RevokedPairsState } from "@/lib/memoryAccess";

/**
 * Whether an approved memory may reach a prompt at all (policy §8.1, §12.4,
 * §15).
 *
 * Four independent authorities have to agree, and they are deliberately not
 * collapsed into one boolean anywhere else in the codebase:
 *
 *   * the operator, through the `memoryInjectionEnabled` flag (§15);
 *   * the eval procedure, through the approved extraction pair (§12.4) —
 *     "flag가 켜져 있어도 승인 pair가 없거나 revoke되면 injection은
 *     fail-closed";
 *   * the account owner, through their own master toggle (§8.1), which is a
 *     privacy control and never a rollout control;
 *   * this conversation, through its memory mode.
 *
 * A guest has no account memory to inject, so they are refused first and for
 * a different reason — not because something is switched off, but because
 * there is nothing that could be theirs.
 *
 * Pure: every input is supplied by the caller. The reason is carried rather
 * than discarded because §22 counts *why* injection did not happen, and
 * "flag off" and "the user turned it off" are not the same observation.
 */

export type MemoryInjectionRefusal =
    | "guest"
    | "flag_off"
    | "no_approved_pair"
    | "account_off"
    | "conversation_off";

export type MemoryInjectionDecision =
    | { allowed: true }
    | { allowed: false; reason: MemoryInjectionRefusal };

export function decideMemoryInjection(input: {
    isAuthenticated: boolean;
    injectionFlagEnabled: boolean;
    /** True when at least one register pair is approved and not revoked. */
    hasApprovedExtractionPair: boolean;
    /** The account's own master toggle (§8.1). */
    accountMasterEnabled: boolean;
    /** This conversation's mode. Defaults to the account default upstream. */
    conversationMode: "on" | "off";
}): MemoryInjectionDecision {
    if (!input.isAuthenticated) return { allowed: false, reason: "guest" };
    if (!input.injectionFlagEnabled) {
        return { allowed: false, reason: "flag_off" };
    }
    if (!input.hasApprovedExtractionPair) {
        return { allowed: false, reason: "no_approved_pair" };
    }
    if (!input.accountMasterEnabled) {
        return { allowed: false, reason: "account_off" };
    }
    if (input.conversationMode === "off") {
        return { allowed: false, reason: "conversation_off" };
    }
    return { allowed: true };
}

/** True when any register entry is approved and not operationally revoked. */
export function hasApprovedExtractionPair(
    revokedPairs: RevokedPairsState,
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER
): boolean {
    return register.some((entry) =>
        Boolean(
            findApprovedEvalPair(
                {
                    extractionModelId: entry.extractionModelId,
                    promptVersion: entry.promptVersion,
                },
                revokedPairs,
                register
            )
        )
    );
}

/**
 * The pairs whose memories may reach a prompt: approved by the eval procedure
 * AND not operationally revoked.
 *
 * This is the per-item half of §12.4, and it is a *list* rather than a
 * per-row predicate because that is the shape the retrieval query needs.
 * Filtering rows after they are fetched would let a revoked pair's memories
 * occupy candidate slots and then be discarded, which silently shrinks
 * retrieval for accounts that have revocations — the same argument
 * `lib/memoryRetrievalService.ts` makes about its always-considered union.
 *
 * The account-level gate above cannot express this. It only knows whether
 * *some* pair is approved, so on its own a revoked pair's memories would keep
 * reaching prompts for as long as any other pair still stood.
 *
 * A user-authored memory carries no pair at all (§12, `extractionModelId`
 * null) and is not subject to extraction-quality approval — the user wrote it
 * and reviewed it themselves. The query admits those separately.
 */
export function injectableExtractionPairs(
    revokedPairs: RevokedPairsState,
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER
): Array<{ extractionModelId: string; promptVersion: string }> {
    return register
        .map((entry) => ({
            extractionModelId: entry.extractionModelId,
            promptVersion: entry.promptVersion,
        }))
        .filter((pair) => Boolean(findApprovedEvalPair(pair, revokedPairs, register)));
}
