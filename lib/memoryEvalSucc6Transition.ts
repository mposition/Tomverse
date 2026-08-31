/**
 * The ten `succ-5` -> `succ-6` supersessions, and why each one moves.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 moves a case
 * out of the decision set when it was used to **form** a rule, and leaves it
 * when an already-frozen rule was merely applied to it. The boundary rule of
 * 2026-08-30 was formed on ten cases and applied to twelve more; these are the
 * ten (.github/audits/memory-boundary-decision-2026-08-30.md §4).
 *
 * Two grounds, and they are not the same thing. Six cases had correct gold and
 * moved because the reviewer was reading them while the rule was written. Five
 * had gold that this decision found wrong. `succ-assistant-ko-23` is both: its
 * retraction candidate is a violation the rule now names, and its
 * privacy-preference candidate is a gold defect the rule now fixes. One case,
 * two grounds, one transition — `ko-23` is a single case however many
 * candidates it produced, and counting its two judgements as two moves would
 * ask for eleven replacements where ten are needed.
 */

export type Succ6TransitionGround =
    /** The case was in front of the reviewer while the rule was written. */
    | "rule-formation"
    /** This decision found the case's gold wrong and corrected it. */
    | "gold-correction";

export type Succ6Transition = {
    originalId: string;
    replacementId: string;
    grounds: readonly Succ6TransitionGround[];
    /** Which clause of the boundary rule this case shaped, where it shaped one. */
    clause?: "retraction" | "correction" | "hypothetical" | "third-party";
    auditRef: string;
};

export const SUCC6_TRANSITIONS: readonly Succ6Transition[] = [
    {
        originalId: "succ-assistant-ko-3",
        replacementId: "succ-assistant-ko-501",
        grounds: ["rule-formation"],
        clause: "retraction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §4.1`,
    },
    {
        originalId: "succ-assistant-ko-15",
        replacementId: "succ-assistant-ko-502",
        grounds: ["rule-formation"],
        clause: "hypothetical",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §4.1`,
    },
    {
        originalId: "succ-assistant-ko-12",
        replacementId: "succ-assistant-ko-503",
        grounds: ["rule-formation"],
        clause: "third-party",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §4.1`,
    },
    {
        originalId: "succ-assistant-ko-19",
        replacementId: "succ-assistant-ko-504",
        grounds: ["rule-formation"],
        clause: "correction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §4.1`,
    },
    {
        // Both grounds. The retraction candidate shaped the clause; the
        // privacy-preference candidate is the gold defect
        // .github/audits/memory-boundary-decision-2026-08-30.md §1.1 corrected.
        originalId: "succ-assistant-ko-23",
        replacementId: "succ-assistant-ko-505",
        grounds: ["rule-formation", "gold-correction"],
        clause: "retraction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §4.1`,
    },
    {
        originalId: "succ-assistant-ko-53",
        replacementId: "succ-assistant-ko-506",
        grounds: ["rule-formation"],
        clause: "hypothetical",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §4.1`,
    },
    {
        originalId: "succ-assistant-en-311",
        replacementId: "succ-assistant-en-501",
        grounds: ["rule-formation", "gold-correction"],
        clause: "retraction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §4.2`,
    },
    {
        originalId: "succ-assistant-en-92",
        replacementId: "succ-assistant-en-502",
        grounds: ["rule-formation", "gold-correction"],
        clause: "correction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §4.2`,
    },
    {
        // No clause: what this case established is that a plain self-assertion
        // falls outside every suppression, which is the absence of a clause
        // rather than one of them.
        originalId: "succ-assistant-en-10",
        replacementId: "succ-assistant-en-503",
        grounds: ["rule-formation", "gold-correction"],
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §4.2`,
    },
    {
        originalId: "succ-assistant-en-27",
        replacementId: "succ-assistant-en-504",
        grounds: ["rule-formation", "gold-correction"],
        clause: "correction",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §4.2`,
    },
];

export const SUCC6_SUPERSEDED_CASE_IDS: ReadonlySet<string> = new Set(
    SUCC6_TRANSITIONS.map((transition) => transition.originalId)
);

export const SUCC6_REPLACEMENT_CASE_IDS: ReadonlySet<string> = new Set(
    SUCC6_TRANSITIONS.map((transition) => transition.replacementId)
);

/** The transition for one superseded id, or `undefined`. */
export function succ6TransitionFor(
    originalId: string
): Succ6Transition | undefined {
    return SUCC6_TRANSITIONS.find(
        (transition) => transition.originalId === originalId
    );
}
