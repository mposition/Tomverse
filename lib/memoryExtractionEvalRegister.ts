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
    MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
} from "@/lib/memoryExtractionEvalCore";


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
        /**
         * Which dataset schema that version is written in.
         *
         * Optional on the type and required on an approved entry, which is
         * the fail-closed direction: an approval that does not say cannot be
         * read as schema 2. A schema-1 dataset carries no
         * `expectedDisposition` and no `goldCompleteness`, so it cannot
         * produce bulk eligibility recall or the sensitive-review bulk-safe
         * misclassification count — an approval resting on it would be
         * resting on metrics that were never computed
         * (`.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md`).
         */
        datasetSchemaVersion?: number;
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
            // Written out, never the shipped constant. While
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
            // **Never approved, diagnostic only, superseded by v3.** v2 fixed
            // v1's wiring -- the schema is requested now, and two probes
            // returned zero unparseable answers -- and in doing so let the
            // measurement be read for the first time. What it showed was four
            // contract defects, none of them the model:
            //
            //   A. the prompt never says which language a statement is
            //      written in, and the ko gold labels are Korean tokens, so a
            //      correct extraction written in English fails that arm;
            //   B. the kind taxonomy is not mutually exclusive -- the model
            //      picks `verbosity`/`tone` where the labels said the generic
            //      `preference` -- and matching requires exact equality;
            //   C. v2's strict schema made `sensitivity` required, so the
            //      model now marks health facts `sensitive`; the validator
            //      may raise that but never lower it, and a candidate that is
            //      not bulk-safe can never match a gold label. "Correctly
            //      extracted, awaiting review" scores as "not extracted";
            //   D. gold labels enumerate one memory per case, so a correct
            //      extra extraction costs precision.
            //
            // Together they make §12.3's bounds unreachable regardless of
            // model quality, so the pair is closed here rather than run: a
            // full run would have bought an uninterpretable number with the
            // budget. The findings and both probes are recorded in
            // docs/ops/memory-extraction-eval-diagnostics.md.
            //
            // Revoked rather than left a candidate because the budget below
            // is real and stays: `decideEvalRunMode` reads status first, so a
            // closed pair cannot spend what remains of it.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v2",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-24",
            notes:
                "Never approved. Diagnostic only: two probes (20 cases, " +
                "US$0.0056) established the wiring and surfaced findings A-D. " +
                "Superseded by mem-extract-v3.",
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
            // §12.5 backup candidate. Closed with the primary: the four
            // findings are contract defects, not model behaviour, so nothing
            // about them would differ under another model.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v2",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-24",
            notes:
                "Never approved. Superseded by mem-extract-v3; never had a " +
                "budget and was never run.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // The pair the amended contract will actually be measured on.
            // v3 carries the four fixes v2's probes surfaced: the output
            // language rule, a mutually exclusive kind order with a
            // residual, the settled-choice boundary on `decision`, and
            // health information as extractable-but-always-sensitive
            // including the minimised third-party form
            // (.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §1, §2, §9).
            //
            // **No budget, deliberately.** A budget does not travel with a
            // version bump: v2's US$20 was approved for v2, and reusing it
            // here would be spending an approval nobody gave for this pair
            // (.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §6).
            // Until a person records one, `decideEvalRunMode` refuses a live
            // run with `no_eval_budget` and only smoke mode works.
            //
            // The successor dataset is also still a candidate pool, so even
            // a funded run would be refused: `legacy_dataset_schema` holds
            // until the schema-2 set is adopted and frozen.
            //
            // **Closed after its probe.** Run 32928284069 (17 cases,
            // US$0.006050) answered the question it was funded for: the
            // numbers are readable, and one of them read as a real defect —
            // an injected Korean directive stored as a bulk-safe
            // communication_style. mem-extract-v4 fixes it.
            //
            // Revoked rather than left a candidate, for the same reason v2
            // was: most of the US$1 is unspent and `decideEvalRunMode` reads
            // status before budget, so closing the pair is what stops a
            // superseded prompt from spending it.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v3",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-26",
            notes:
                "Development probe only, and it ran: 17 cases, US$0.006050, " +
                "run 32928284069. Recall 12/12 and sensitive-review " +
                "misclassifications 0; one critical bulk-safe adoption " +
                "(probe-injection-ko). Superseded by mem-extract-v4.",
            evalBudget: {
                approvedBy: "@mposition",
                // **Probe-scoped, deliberately.** The 17-case development
                // probe costs well under a cent at v2's observed rate; the
                // dollar is headroom, not an estimate.
                //
                // Not the US$11.57-worst-case figure a decision-grade run
                // needs, because that approval should rest on the probe's
                // answer. mem-extract-v2 spent US$0.0056 buying a precision of
                // 0.12 that meant nothing, and a full run under a contract
                // nobody had checked would have spent three to eleven dollars
                // on the same kind of number. This buys the check first.
                maxUsd: 1,
                ticket: "https://github.com/mposition/Tomverse/issues/837",
                approvedAt: "2026-08-26",
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate for v3. Closed with the primary: the
            // finding is a prompt defect, not model behaviour, so nothing
            // about it would differ under another model.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v3",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-26",
            notes:
                "Never had a budget and was never run. Superseded by " +
                "mem-extract-v4.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // The pair v4 is probed on. v4 narrows one v3 rule: an imperative
            // in imported content becomes a preference only when honouring it
            // would change how an answer is *presented*, and is dropped when
            // it would change what the assistant is *permitted to do*.
            //
            // **Its own budget, not v3's.** The US$1 above was approved for
            // v3 and stays with v3 — the rule this file states twice is that
            // a budget does not travel with a version bump, and a re-run on a
            // new prompt is exactly the case it is there for.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v4",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-26",
            notes:
                "Decision-grade approved. US$1 on 2026-08-26 for the 18-case " +
                "development probe (run 32929511265, US$0.006917 spent), then " +
                "raised to US$15 the same day for the decision-grade run over " +
                "mem-eval-succ-1 once the probe showed the numbers are readable.",
            evalBudget: {
                approvedBy: "@mposition",
                // **US$15, and the worst case is what it covers.**
                //
                // `npm run report:memory-eval-cost-estimate` measures the
                // input side at US$0.68 for the two §12.4 runs and prices the
                // output side three ways: US$0.89 at the rate probe2 actually
                // showed (~77 tokens an answer), US$3.51 at the report's
                // standing assumption, US$11.98 if every answer hit the 4,096
                // ceiling.
                //
                // The ceiling is set from the last of those and not the
                // first. A run stopped by --max-cost-usd is truncated, and a
                // truncated run is not decision-grade — so a ceiling set to
                // the expected spend buys nothing and loses the run. The
                // headroom over US$11.98 absorbs a longer mean prompt than
                // the 18-case probe showed, and provider-side rounding.
                maxUsd: 15,
                ticket: "https://github.com/mposition/Tomverse/issues/837",
                approvedAt: "2026-08-26",
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate for v4, on the same terms.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v4",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-26",
            notes:
                "Backup candidate. No budget; smoke mode only until a person " +
                "records one.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // v5 carries the five rules frozen in
            // `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`
            // (approved 2026-08-27) after run1 measured all 1,150 cases and
            // failed: precision 0.720, recall 0.797, and 49 critical
            // bulk-safe adoptions against a gate of zero.
            //
            // **No budget, deliberately.** v4's US$15 stays with v4. This
            // file states the rule twice already and a third case does not
            // weaken it: a budget does not travel with a version bump, and a
            // re-run on a new prompt is exactly what it exists for. The
            // approval on 2026-08-27 covered the wording and the case
            // verdicts and said outright that it did not cover this.
            //
            // **Smoke mode only until a person records one**, which is what
            // `decideEvalRunMode` enforces — so nothing here can spend before
            // that entry exists.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v5",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-27",
            notes:
                "Carries the five rules frozen on 2026-08-27 after run1 " +
                "(run 32972243326, mem-eval-succ-2). No budget; smoke mode " +
                "only until a person records one. A run on this pair also " +
                "needs mem-eval-succ-3, which is not frozen yet.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // §12.5 backup candidate for v5, on the same terms as v4's.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v5",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-27",
            notes:
                "Backup candidate. No budget; smoke mode only until a person " +
                "records one.",
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
        if (
            evaluation.datasetSchemaVersion !==
            MEMORY_EVAL_DATASET_SCHEMA_VERSION
        ) {
            problems.push(
                `${label}: approved against dataset schema ` +
                    `${evaluation.datasetSchemaVersion ?? "(unstated)"}; ` +
                    `§12.3 as amended requires schema ${MEMORY_EVAL_DATASET_SCHEMA_VERSION}`
            );
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
