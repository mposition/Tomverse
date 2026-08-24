/**
 * Code register of memory-extraction model/prompt pairs (Release B, §12.1).
 *
 * docs/policy/external-conversation-import-and-memory.md §12.
 *
 * The register is code on purpose: commit history is the audit record, and
 * `scripts/check-memory-extraction-eval-register.mjs` (PR Fast Gate) refuses
 * an `approved` entry whose evidence does not carry everything §12.1 lists.
 * An implementation agent may add `candidate` entries; moving one to
 * `approved` is the §12.4 human procedure (decision-grade eval, blind
 * review, independent re-run, approver sign-off) and never automatic.
 *
 * Runtime effectiveness is narrower than register approval on purpose
 * (§12.1): effective = approved here ∧ extraction flag on ∧ verified
 * pricing ∧ plan allows the model ∧ promptVersion matches ∧ no operational
 * revocation (lib/memoryAccess.ts).
 */

import {
    isPairRevoked,
    type MemoryExtractionPairRef,
    type RevokedPairsState,
} from "@/lib/memoryAccess";
import {
    MEMORY_EVAL_CATEGORY_BY_POLICY_LABEL,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
} from "@/lib/memoryExtractionEvalCore";

/** The prompt contract version the B2 pipeline implements. */
export const MEMORY_EXTRACTION_PROMPT_VERSION = "mem-extract-v1";

export type MemoryExtractionEvalEntry = {
    extractionModelId: string;
    promptVersion: string;
    /** candidate → approved is human-only; revoked entries stay for audit. */
    status: "candidate" | "approved" | "revoked";
    owner: string;
    registeredAt: string; // ISO date
    notes?: string;
    /**
     * §12.5: human-approved budget for decision-grade eval runs. Required
     * before anything beyond smoke mode may be executed for this pair.
     */
    evalBudget: {
        approvedBy: string;
        maxUsd: number;
        ticket: string;
        approvedAt: string;
    } | null;
    /**
     * §12.1 evidence. Required (complete) on approved entries; null while
     * the pair is a candidate.
     */
    evaluation: {
        artifactRef: string;
        evaluatedCommit: string;
        datasetVersion: string;
        languages: readonly string[];
        /** per category (1-4) per language arm, §12.2: each ≥ 200. */
        sampleCounts: Readonly<Record<string, number>>;
        metrics: {
            precisionWilsonLowerAggregate: number;
            recallWilsonLowerAggregate: number;
            precisionWilsonLowerByArm: Readonly<Record<string, number>>;
            recallWilsonLowerByArm: Readonly<Record<string, number>>;
        };
        criticalFalseAcceptances: number;
        approver: string;
        approvedAt: string; // ISO date
        expiresAt: string; // ISO date — re-evaluation deadline
        knownLimitations: string;
    } | null;
};

export const MEMORY_EXTRACTION_EVAL_REGISTER: readonly MemoryExtractionEvalEntry[] =
    [
        {
            // **Never approved, superseded by v2.** The pair was the §12.5
            // first eval target and its only live run reached five
            // consecutive unscoreable answers: the prompt asked for JSON
            // "matching the requested schema" and the adapter requested no
            // schema, so the model guessed the field names and the type of
            // `confidence`. That is a wiring defect, not a measurement, and
            // the run is recorded as `abortedOnConsecutiveFailures` rather
            // than as a verdict. US$0.0012 was spent reaching it.
            //
            // Kept rather than deleted because the budget below was really
            // approved and really spent against, and a register that dropped
            // the entry would lose both facts.
            extractionModelId: "gpt-5-6-luna",
            // Written out, never `MEMORY_EXTRACTION_PROMPT_VERSION`. While
            // these entries read the live constant, bumping it moved every
            // approval onto the new version without anybody approving
            // anything -- which is precisely what a version is for.
            promptVersion: "mem-extract-v1",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-03",
            notes:
                "Never approved. Superseded by mem-extract-v2 (structured " +
                "outputs) on 2026-08-24. US$0.0012 spent; no verdict exists.",
            evalBudget: {
                approvedBy: "@mposition",
                maxUsd: 20,
                ticket: "https://github.com/mposition/Tomverse/issues/837",
                approvedAt: "2026-08-23",
            },
            evaluation: null,
        },
        {
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v1",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-03",
            notes:
                "Never approved. Superseded by mem-extract-v2 on 2026-08-24; " +
                "never had a budget and was never run.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // §12.5 first eval target under v2. **Still a candidate.** The
            // budget below is what opens `--live`; it is not approval of the
            // pair. That is the §12.4 procedure — decision-grade run,
            // artifact preservation, blind review, independent re-run, §12.3
            // judgement, approver signature, register merge, staging
            // verification — and none of it has happened for v2.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v2",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-24",
            evalBudget: {
                approvedBy: "@mposition",
                // Approved for v2 on its own, not carried across from v1:
                // #837 was amended rather than reused, because a budget that
                // migrates with a version bump is a budget nobody approved
                // for the thing it ends up paying for.
                //
                // US$11.57 is the worst case for two runs at the 4,096-token
                // output ceiling the product sends; the typical figure is
                // US$3.09. The headroom to US$20 absorbs the compatibility
                // probe and one failed run without a second approval.
                //
                // US$0.0012 was already spent under v1 finding the wiring
                // defect v2 fixes. It counts against this programme, and
                // nothing enforces that: the harness bounds a *run* through
                // --max-cost-usd and has no cumulative ledger, so the figure
                // is recorded here to be subtracted by a person.
                maxUsd: 20,
                ticket: "https://github.com/mposition/Tomverse/issues/837",
                approvedAt: "2026-08-24",
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate, evaluated only if the primary fails.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v2",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-24",
            evalBudget: null,
            evaluation: null,
        },
    ];

/** §12.3 acceptance thresholds — the register check re-verifies them. */
export const MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN = 0.95;
export const MEMORY_EVAL_RECALL_WILSON_LOWER_MIN = 0.85;
// The floor itself lives in `lib/memoryExtractionEvalCore.ts` and is imported
// rather than restated. It used to be declared here too, and two copies of a
// number that must agree is one edit away from the harness and the register
// enforcing different §12.2 floors.
export const MEMORY_EVAL_REQUIRED_LANGUAGES = ["ko", "en"] as const;

/**
 * The register-side half of pair resolution: approved, prompt-matched, not
 * operationally revoked. Pricing/plan/flag checks live with their owners.
 */
export function findApprovedEvalPair(
    pair: MemoryExtractionPairRef,
    revokedPairs: RevokedPairsState,
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER
): MemoryExtractionEvalEntry | null {
    const entry = register.find(
        (candidate) =>
            candidate.extractionModelId === pair.extractionModelId &&
            candidate.promptVersion === pair.promptVersion
    );
    if (!entry || entry.status !== "approved") return null;
    if (isPairRevoked(revokedPairs, pair)) return null;
    return entry;
}

/**
 * Structural problems that fail the register check (fail-closed). A
 * candidate entry with no budget is not a problem — it is the §12.5 waiting
 * state — but an approved entry missing anything §12.1/§12.3 requires is.
 */
export function findEvalRegisterProblems(
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER,
    now: Date = new Date()
): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const entry of register) {
        const label = `${entry.extractionModelId}::${entry.promptVersion}`;
        if (seen.has(label)) {
            problems.push(`duplicate register entry for ${label}`);
        }
        seen.add(label);
        if (!entry.owner || !entry.registeredAt) {
            problems.push(`${label}: owner and registeredAt are required`);
        }
        // A budget is checked wherever it appears, not only on approved
        // entries. Filling it is what opens `--live` (§12.5), so a candidate
        // carrying a half-filled one is the dangerous state: spending is
        // unlocked and the record that says who authorised it is incomplete.
        // A missing budget stays the ordinary waiting state.
        if (entry.evalBudget) {
            const { approvedBy, maxUsd, ticket, approvedAt } = entry.evalBudget;
            for (const [field, value] of [
                ["approvedBy", approvedBy],
                ["ticket", ticket],
                ["approvedAt", approvedAt],
            ] as const) {
                if (!value || String(value).trim() === "") {
                    problems.push(
                        `${label}: eval budget has an empty ${field} ` +
                            "(docs/policy/external-conversation-import-and-memory.md §12.5)"
                    );
                }
            }
            if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
                // The harness reads this as the spend ceiling. Zero would stop
                // every live run at the first case, and a negative number is a
                // ceiling nobody chose.
                problems.push(
                    `${label}: eval budget maxUsd must be a positive number (got ${maxUsd})`
                );
            }
        }
        if (entry.status !== "approved") continue;

        if (!entry.evalBudget) {
            problems.push(
                `${label}: approved without a human-approved eval budget (§12.5)`
            );
        }
        const evaluation = entry.evaluation;
        if (!evaluation) {
            problems.push(`${label}: approved without evaluation evidence (§12.1)`);
            continue;
        }
        for (const field of [
            evaluation.artifactRef,
            evaluation.evaluatedCommit,
            evaluation.datasetVersion,
            evaluation.approver,
            evaluation.approvedAt,
            evaluation.expiresAt,
            evaluation.knownLimitations,
        ]) {
            if (!field || String(field).trim() === "") {
                problems.push(`${label}: evaluation evidence has empty fields`);
                break;
            }
        }
        for (const language of MEMORY_EVAL_REQUIRED_LANGUAGES) {
            if (!evaluation.languages.includes(language)) {
                problems.push(`${label}: missing required eval language ${language}`);
            }
            for (const policyLabel of ["1", "2", "3", "4"] as const) {
                const count =
                    evaluation.sampleCounts[`${policyLabel}:${language}`] ?? 0;
                const minimum =
                    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[
                        MEMORY_EVAL_CATEGORY_BY_POLICY_LABEL[policyLabel]
                    ];
                if (count < minimum) {
                    problems.push(
                        `${label}: sample count ${policyLabel}:${language}=${count} below ` +
                            `${minimum} (docs/policy/external-conversation-import-and-memory.md §12.2)`
                    );
                }
            }
        }
        const { metrics } = evaluation;
        if (
            metrics.precisionWilsonLowerAggregate <
            MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN
        ) {
            problems.push(`${label}: aggregate precision below §12.3 threshold`);
        }
        if (
            metrics.recallWilsonLowerAggregate <
            MEMORY_EVAL_RECALL_WILSON_LOWER_MIN
        ) {
            problems.push(`${label}: aggregate recall below §12.3 threshold`);
        }
        for (const language of MEMORY_EVAL_REQUIRED_LANGUAGES) {
            if (
                (metrics.precisionWilsonLowerByArm[language] ?? 0) <
                MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN
            ) {
                problems.push(`${label}: ${language} precision below threshold`);
            }
            if (
                (metrics.recallWilsonLowerByArm[language] ?? 0) <
                MEMORY_EVAL_RECALL_WILSON_LOWER_MIN
            ) {
                problems.push(`${label}: ${language} recall below threshold`);
            }
        }
        if (evaluation.criticalFalseAcceptances !== 0) {
            problems.push(
                `${label}: critical false acceptances must be exactly 0 (§12.3)`
            );
        }
        if (new Date(evaluation.expiresAt).getTime() <= now.getTime()) {
            problems.push(`${label}: approval expired; re-evaluation required`);
        }
    }
    return problems;
}
