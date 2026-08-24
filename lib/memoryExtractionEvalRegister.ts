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
            // §12.5 first eval target. **Still a candidate.** The budget below
            // is filled, which is what opens `--live`; it is not approval of
            // the pair. That is the §12.4 procedure — decision-grade run,
            // artifact preservation, blind review, independent re-run, §12.3
            // judgement, approver signature, register merge, staging
            // verification — and none of it has happened.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-03",
            evalBudget: {
                approvedBy: "@mposition",
                // US$17.36 is the worst case for three runs: §12.4 asks for two
                // and the third absorbs one failed run without a second
                // approval. The worst case prices every call at the harness's
                // 4,096-token output ceiling, so a run that behaves cannot
                // approach this — the typical figure for two runs is US$3.09.
                // Derivation and what it does not measure: issue #837.
                maxUsd: 20,
                ticket: "https://github.com/mposition/Tomverse/issues/837",
                approvedAt: "2026-08-23",
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate, evaluated only if the primary fails.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-03",
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
