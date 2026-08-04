/**
 * What happens to a memory when the source it came from is deleted
 * (policy §13.1, settled as §23 item 3).
 *
 * Deleting an imported conversation removes its messages, and the foreign key
 * cascade removes the evidence rows that pointed at them. Left there, the
 * memory itself survives in `active` — still retrieved, still placed in
 * prompts, with nothing behind it. The user deleted the conversation and the
 * thing derived from it kept working. That is the gap this module closes.
 *
 * Three outcomes, and the distinction between them is what the user still has
 * after the delete:
 *
 *   * `keep` — other evidence survives (another conversation, or grounds the
 *     user typed themselves). Nothing to decide; the memory is still backed.
 *   * `derived` — nothing survives, and the statement is the extractor's
 *     work. §13.1 makes deleting it the default: the user asked for the
 *     source to be gone, and this is a thing made from it.
 *   * `user_touched` — nothing survives, but the user edited the statement.
 *     They wrote part of it, so it is not the extractor's to delete on their
 *     behalf. Default is to suspend, and the choice is offered separately.
 *
 * `manual_review_required` is deliberately not used for any of this: that
 * status means the §8.4 validator demoted something, and reusing it here
 * would make "a human must look at this" mean two unrelated things.
 *
 * Pure — the caller supplies the classification facts and applies the plan.
 */

export type SourceDeletionDisposition = "delete" | "suspend";

export type MemorySourceClassification = "keep" | "derived" | "user_touched";

/**
 * §13.1 defaults. Derived memories go with their source; anything the user
 * shaped is kept in a suspended state instead, because a suspended memory can
 * be restored by re-writing its evidence while a deleted one cannot.
 */
export const SOURCE_DELETE_DEFAULTS = {
    derived: "delete",
    userTouched: "suspend",
} as const satisfies Record<string, SourceDeletionDisposition>;

/** The status a suspended memory takes (§8.3). */
export const SOURCE_DELETE_SUSPENDED_STATUS = "suspended_by_source_delete";

export type MemoryDeletionFacts = {
    id: string;
    /**
     * True when at least one evidence row will still exist afterwards —
     * another source conversation, or manual grounds the user typed. Manual
     * evidence counts, which is why a hand-written memory is never disturbed
     * by deleting an import.
     */
    hasSurvivingEvidence: boolean;
    /** The user rewrote the statement at some point. */
    userEdited: boolean;
};

export function classifyMemoryForSourceDelete(
    facts: Pick<MemoryDeletionFacts, "hasSurvivingEvidence" | "userEdited">
): MemorySourceClassification {
    if (facts.hasSurvivingEvidence) return "keep";
    return facts.userEdited ? "user_touched" : "derived";
}

export type SourceDeletionPlan = {
    /** Memories to remove outright. */
    deleteIds: string[];
    /** Memories to move to `suspended_by_source_delete`. */
    suspendIds: string[];
    /** Untouched, because they are still backed by something. */
    keepIds: string[];
};

export function planSourceDeletion(input: {
    memories: readonly MemoryDeletionFacts[];
    derivedDisposition?: SourceDeletionDisposition;
    userTouchedDisposition?: SourceDeletionDisposition;
}): SourceDeletionPlan {
    const derived = input.derivedDisposition ?? SOURCE_DELETE_DEFAULTS.derived;
    const userTouched =
        input.userTouchedDisposition ?? SOURCE_DELETE_DEFAULTS.userTouched;

    const plan: SourceDeletionPlan = {
        deleteIds: [],
        suspendIds: [],
        keepIds: [],
    };
    for (const memory of input.memories) {
        const classification = classifyMemoryForSourceDelete(memory);
        if (classification === "keep") {
            plan.keepIds.push(memory.id);
            continue;
        }
        const disposition =
            classification === "derived" ? derived : userTouched;
        if (disposition === "delete") plan.deleteIds.push(memory.id);
        else plan.suspendIds.push(memory.id);
    }
    return plan;
}

/**
 * Content-free counts for the delete confirmation, so the user is told what
 * the delete will take with it *before* confirming rather than afterwards.
 */
export type SourceDeletionImpact = {
    derivedCount: number;
    userTouchedCount: number;
    keptCount: number;
};

export function summarizeSourceDeletionImpact(
    memories: readonly MemoryDeletionFacts[]
): SourceDeletionImpact {
    const impact: SourceDeletionImpact = {
        derivedCount: 0,
        userTouchedCount: 0,
        keptCount: 0,
    };
    for (const memory of memories) {
        const classification = classifyMemoryForSourceDelete(memory);
        if (classification === "keep") impact.keptCount += 1;
        else if (classification === "derived") impact.derivedCount += 1;
        else impact.userTouchedCount += 1;
    }
    return impact;
}
