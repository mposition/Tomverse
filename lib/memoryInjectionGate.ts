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
 * Per-item half of the same rule.
 *
 * The account-level gate asks whether *any* approved pair exists; this asks
 * whether the pair that produced **this** memory is still approved. Both are
 * needed: revoking one pair must stop its memories from being injected
 * without stopping every other memory in the account, and an account-level
 * check alone cannot see which pair produced what.
 *
 * A user-authored memory carries no extraction pair (§12, `extractionModelId`
 * null) and is not subject to extraction-quality approval — the user wrote it
 * and reviewed it themselves. A row carrying only one half of a pair is
 * malformed provenance and is excluded: fail-closed is the direction the rest
 * of this feature takes with unreadable provenance.
 */
export function isInjectableProvenance(
    memory: { extractionModelId: string | null; promptVersion: string | null },
    revokedPairs: RevokedPairsState,
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER
): boolean {
    if (memory.extractionModelId === null && memory.promptVersion === null) {
        return true;
    }
    if (!memory.extractionModelId || !memory.promptVersion) return false;
    return Boolean(
        findApprovedEvalPair(
            {
                extractionModelId: memory.extractionModelId,
                promptVersion: memory.promptVersion,
            },
            revokedPairs,
            register
        )
    );
}
