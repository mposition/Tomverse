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
import type { EvalBudgetTuple } from "@/lib/memoryEvalBudgetBinding";


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
        /**
         * The ceiling for ONE harness invocation.
         *
         * Named for what the code does with it: `decideEvalRunMode()` returns
         * it as `ceilingUsd`, and `accruedCostUsd` starts at zero on every
         * invocation. It has never been a programme total, and recording a
         * programme total here would have authorised that figure once per run
         * — two runs of a two-run approval spending twice what was approved.
         *
         * The programme total is `programmeMaxMicroUsd`, and dividing it by
         * the approved run count is what makes the two agree.
         */
        maxUsd: number;
        /**
         * The total this pair may spend across every approved run, in
         * microUSD so the figure is exact.
         *
         * Recorded rather than enforced, for the same reason
         * `maxProviderDispatchedRuns` is: this repository keeps no ledger of
         * runs, so nothing here can add up what previous invocations spent.
         * What is enforced per invocation is `maxUsd`, and what makes the two
         * consistent is that `maxUsd × maxProviderDispatchedRuns` may not
         * exceed this — checked by `findEvalRegisterProblems()`.
         *
         * Unused budget from one run does not carry into the next: the per-run
         * ceiling is the per-run ceiling, and raising it needs an approval.
         */
        programmeMaxMicroUsd?: number;
        ticket: string;
        approvedAt: string;
        /**
         * The instrument this budget was approved against.
         *
         * Optional on the type and required for a live run. Budgets recorded
         * before the 2026-08-28 re-approval carry none — they were real
         * approvals and are kept as history — and an unbound budget cannot
         * authorise a paid run: a ceiling attached to no dataset, contract or
         * prompt is a ceiling on a run whose shape nobody agreed to.
         * `evalBudgetBindingProblems()` refuses it, and
         * `evalBudgetTupleFailures()` refuses a bound one whose values the
         * tree no longer reproduces.
         */
        boundTuple?: EvalBudgetTuple;
        /**
         * The merge commit of the change that produced those digests.
         *
         * The run's own commit must be a **descendant** of this, never equal
         * to it: a registration PR cannot contain its own merge SHA, and a
         * later commit that still assembles the same instrument is still
         * running the approved one.
         */
        approvedImplementationSha?: string;
        /**
         * How many runs may reach a provider under this approval.
         *
         * Half-enforced, and the half matters. Nothing here can *count* runs:
         * this repository keeps no ledger of them and `accruedCostUsd` starts
         * at zero on every invocation. What is enforced is that a live run
         * states which of the approved runs it is (`--run-ordinal`) and that
         * the number is one this approval covers — so a third run of a
         * two-run approval refuses, and the operator's explicit instruction to
         * run is the ledger it already was procedurally.
         *
         * The §12.4 procedure is the rest of it and stays a human matter: the
         * second run is a reproducibility run rather than a retry, it starts
         * only after the first has been reviewed, and it is not made at all if
         * the first showed a structural failure or a clear miss.
         */
        maxProviderDispatchedRuns?: number;
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
            // **v4's US$15 did not travel here.** A budget does not follow a
            // version bump, and this one was approved on its own figures: the
            // ceiling below rests on `mem-eval-succ-3`, whose mean prompt is
            // 2,298 tokens against succ-2's 579, because 99 cases were
            // replaced with new conversations and the set's mean length moved
            // with them. US$15 still covers two runs on succ-3 and not the
            // third a repeat would need, so carrying it across would have
            // looked like a decision and been an accident.
            // **Measured and closed on 2026-08-27.** v5-run1 (run
            // 33065481093) scored all 1,150 cases of `mem-eval-succ-3` and
            // missed every §12.3 floor and the hard-zero gate. The run is
            // admissible — 6/6, no harness failures — so it is a citable
            // negative result rather than a spoiled one, and the blind review
            // of 40 cases was completed on it.
            //
            // `revoked` rather than `candidate`, on the precedent the two
            // `mem-extract-v1` entries set: this register uses it for a pair
            // that will not be approved, whether or not it ever was. It also
            // makes "we are not re-running this" a gate rather than a memory —
            // `decideEvalRunMode` refuses `pair_not_runnable` before it looks
            // at the budget or the key.
            //
            // The budget stays. The approval was real, US$0.5877 of it was
            // really spent, and deleting it would erase what the money bought.
            //
            // No `evaluation` block: §12.1's evidence fields are an approval
            // record (approver, approvedAt, expiresAt), and there was no
            // approval. The evidence is the audit below.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v5",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-27",
            notes:
                "Negative result, confirmed 2026-08-27. v5-run1 (run " +
                "33065481093, mem-eval-succ-3, commit b9402f28): precision " +
                "Wilson lower 0.8198 < 0.95, recall 0.8198 < 0.85, bulk " +
                "eligibility 0.8041 < 0.85, critical bulk-safe adoptions 25 " +
                "!= 0. Admissible 6/6, 0 harness failures, US$0.5877 spent. " +
                "Two opposing structural failures — rule 2 under-applied " +
                "(assistant-authored facts stored as the user's) and rule 1 " +
                "over-applied (legitimate facts dropped from injection " +
                "turns) — so it was not re-run " +
                "(docs/ops/memory-extraction-decision-grade-run.md §6.1). " +
                "Blind review and the gold defects it surfaced: " +
                ".github/audits/memory-eval-v5-run1-2026-08-27.md.",
            evalBudget: {
                approvedBy: "@mposition",
                // The §12.4 independent re-run's worst case on succ-3 is
                // US$12.36; a third run is US$18.54. US$20 is the same
                // reasoning issue 837 gave for its own ceiling — one failed
                // run can be repeated without a second approval — and a run
                // that behaves cannot approach it: at an assumed 1,024 output
                // tokens per answer, two runs cost US$3.88.
                maxUsd: 20,
                ticket: "https://github.com/mposition/Tomverse/issues/1135",
                approvedAt: "2026-08-27",
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate for v5, on the same terms as v4's.
            //
            // **Deliberately outside the 2026-08-27 approval.** Issue 1135
            // names one pair, and v4's backup carries no budget either. A
            // backup that quietly inherited the primary's ceiling would be a
            // second funded pair nobody approved.
            // Closed with the prompt version rather than on its own numbers:
            // it was never funded and never run, so there is nothing to
            // report about this pair. The same shape as `mem-extract-v1`'s
            // backup, which is `revoked` and says so.
            //
            // Left as a candidate it would be a live target for a version
            // whose primary pair has been measured and closed — one budget
            // approval away from running a prompt nobody intends to approve.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v5",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-27",
            notes:
                "Never funded and never run. Closed 2026-08-27 with " +
                "mem-extract-v5, whose primary pair is a confirmed negative " +
                "result: .github/audits/memory-eval-v5-run1-2026-08-27.md.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // **Measured, closed, and the budget stays on the record.**
            //
            // run1 (2026-08-29) reached a provider, scored all 1,150 cases and
            // missed every §12.3 floor by a wide margin — precision Wilson
            // lower 0.6826 against 0.95, recall 0.7212 against 0.85, bulk
            // eligibility 0.7163 against 0.85 — with 41 critical-category
            // bulk-safe adoptions against a gate of zero. The reviewer
            // declined the §12.4 reproducibility run on the ground that a
            // second run has no question left to answer at that distance, and
            // closed the pair
            // (.github/audits/memory-eval-v6-succ5-run1-2026-08-29.md §7).
            //
            // `revoked` rather than an emptied budget, because the approval
            // was real and US$0.7094 of it was really spent. The status gate
            // sits ahead of the budget in `decideEvalRunMode()`, so the row
            // keeps its history without keeping permission to run: unused
            // budget transfers to no other pair and to no later prompt
            // version, and the tuple it is bound to names `mem-extract-v6`.
            //
            // v6 existed because schema-3 scoring compares a candidate's
            // `polarity` to the gold's and a v5 candidate has no such field,
            // so no v5 pair could be scored against `mem-eval-succ-4` at all
            // (.github/audits/memory-eval-gold-contract-2026-08-27.md §10.1).
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v6",
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-28",
            notes:
                "Funded 2026-08-28 for mem-eval-succ-5 / mem-score-v3.4. " +
                "Implemented against schema 3: required polarity, evidence " +
                "quotes bound to the server's copy of the cited message, and " +
                "no candidate from evidence whose polarity a plain reading " +
                "cannot fix. Never run. The first budget, approved against " +
                "mem-eval-succ-4 / mem-score-v3.3, lapsed before registration " +
                "when v3.3 was found to describe itself as scoring schema 2 " +
                "and was excluded from decision-grade runs " +
                "(.github/audits/memory-eval-gold-contract-2026-08-27.md, " +
                "section 16). Nothing was spent under it. Instrument: " +
                "docs/release-gates/evidence/memory-extraction-instrument-2026-08-28.md. " +
                "Ceilings: US$6.285 per run, US$12.57 across the two approved " +
                "runs. Unused budget from the first run does not carry into " +
                "the second; a first run truncated at its ceiling is not " +
                "decision-grade and the ceiling is not raised without a new " +
                "approval. Run 1 ran on 2026-08-29 " +
                "(https://github.com/mposition/Tomverse/actions/runs/33226038813), " +
                "1,150/1,150 cases in 36m50s for US$0.7094, admissible 6/6, " +
                "and did not pass section 12.3. Closed the same day: the " +
                "reproducibility run was not approved and the pair is revoked. " +
                "Negative result, citable as evidence: " +
                ".github/audits/memory-eval-v6-succ5-run1-2026-08-29.md.",
            evalBudget: {
                approvedBy: "@mposition",
                // Per invocation, which is what the harness enforces: half of
                // the approved programme total, because the approval is for
                // two runs. US$12.57 was the programme figure and putting it
                // here would have allowed it twice — `accruedCostUsd` starts
                // at zero on every invocation.
                //
                // The programme figure is the worst case for two runs on
                // succ-5, from `npm run report:memory-eval-cost-estimate`:
                // every answer at the 4,096-token output ceiling across 1,150
                // cases, twice. Not a round number on purpose — a ceiling
                // rounded up is a ceiling nobody computed.
                maxUsd: 6.285,
                programmeMaxMicroUsd: 12_570_000,
                ticket:
                    ".github/audits/memory-eval-gold-contract-2026-08-27.md, section 17",
                approvedAt: "2026-08-28",
                // Two, and the second is the §12.4 reproducibility run rather
                // than a retry. Recorded rather than enforced: see the field's
                // own note.
                maxProviderDispatchedRuns: 2,
                // The merge commit of the v3.4 / succ-5 correction. A run's
                // own commit must descend from it.
                approvedImplementationSha:
                    "34a53ddc0247661e578422300ecc58801ea73fce",
                boundTuple: {
                    datasetVersion: "mem-eval-succ-5",
                    datasetDigest:
                        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0",
                    datasetManifestDigest:
                        "215b679444c610928975c63b8c095f98eefb0d0bd22f28acff3255fcaf464762",
                    scoringContractVersion: "mem-score-v3.4",
                    scoringContractDigest:
                        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
                    promptVersion: "mem-extract-v6",
                    promptDigest:
                        "c85389d8360a997fe80e4d8905304c223f67f67b1676fa2df483daf902b05052",
                },
            },
            evaluation: null,
        },
        {
            // §12.5 backup candidate for v6, unfunded on the same terms as
            // v4's and v5's. A backup that inherited a primary's ceiling
            // would be a second funded pair nobody approved -- and here
            // neither pair is funded at all.
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v6",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-08-28",
            notes:
                "Backup candidate for mem-extract-v6. Unfunded, never run. " +
                "The 2026-08-28 re-approval funds one pair and says so: a " +
                "budget cannot be transferred to another model, prompt " +
                "version, dataset or contract, and unspent budget cannot be " +
                "applied to another pair.",
            evalBudget: null,
            evaluation: null,
        },
        {
            // The pair for the boundary rule, registered on 2026-08-31 with
            // no budget — step 5 of
            // .github/audits/memory-boundary-decision-2026-08-30.md §5.3,
            // which says in terms that it starts unfunded.
            //
            // It exists so the tree has a pair for the version it ships. Until
            // now the register's newest pair was v6's, and bumping the prompt
            // left the harness unable to name the pair it would run — which
            // several gates report as a missing entry rather than as a
            // refusal, and a refusal is what this state should read as.
            //
            // v6's budget is NOT carried over and could not be: it is bound to
            // v6's prompt digest, and `memoryEvalBudgetBinding` compares that
            // tuple against the tree. A v7 run under v6's approval is exactly
            // what that comparison exists to stop.
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v7",
            // Closed 2026-09-02 after run 1. Not a bookkeeping label: this
            // field is the second thing `decideEvalRunMode()` reads, before
            // the budget, so a revoked pair refuses with `pair_not_runnable`
            // however much of its approval is left. The budget below still
            // funds a second run on paper, and that is exactly the gap this
            // closes -- "run 2 was not approved" lived only in an audit
            // document, and a manual dispatch does not read documents.
            status: "revoked",
            owner: "@mposition",
            registeredAt: "2026-08-31",
            notes:
                "Revoked 2026-09-02 after run 1 (#13, c3c5ff65) came back an " +
                "admissible decision-grade FAILURE, and run 2 was not " +
                "approved: precision Wilson lower 0.7123 against 0.95, recall " +
                "0.7268 against 0.85, and 20 critical bulk-safe adoptions " +
                "against a gate of zero. Wide misses, not a borderline result " +
                "reproduction would settle. The 40-case blind review " +
                "(@mposition, 36 appropriate / 4 not) found no execution or " +
                "scoring defect that would rescue the verdict. Record: " +
                ".github/audits/memory-eval-v7-run1-blind-review-2026-09-01.md. " +
                "The budget below is KEPT because the approval was real and " +
                "US$0.7893 was really spent against it; the run and its " +
                "artifacts (9802989240, 9802990649) stand as a citable " +
                "negative result. `evaluation` stays null because no approval " +
                "was ever granted. Superseded by nothing yet -- the three open " +
                "gold questions in that record's section 7 are decided " +
                "together, and only then does a successor dataset or prompt " +
                "get made. " +
                "Originally registered as a candidate for the boundary rule of " +
                "2026-08-30. Scores against the frozen mem-eval-succ-6 under " +
                "mem-score-v3.4. Funded 2026-08-31 for two runs, of which one " +
                "was dispatched. " +
                "v6's budget, approval and run history are not transferred: a " +
                "budget cannot move to another prompt version, and the ten " +
                "cases that shaped this rule left the decision set under B+ " +
                "so this pair is measured on cases it did not produce. " +
                "Approval: " +
                ".github/audits/memory-eval-v7-budget-approval-2026-08-31.md. " +
                "Ceilings: US$6.39 per run, US$12.78 across the two approved " +
                "runs. Unused budget from the first run does not carry into " +
                "the second; a run truncated at its ceiling is not " +
                "decision-grade and the ceiling is not raised without a new " +
                "approval. Ordinal 1 is spent: it reached the provider, so it " +
                "is consumed whatever it returned. Ordinal 2 was never " +
                "approved and is now unreachable through `status` regardless " +
                "of the remaining ceiling.",
            evalBudget: {
                approvedBy: "@mposition",
                // Per invocation, and half the programme total because the
                // approval is for two runs. `accruedCostUsd` starts at zero
                // on every invocation, so the programme figure written here
                // would be spendable twice.
                //
                // US$12.78 is the worst case from
                // `npm run report:memory-eval-cost-estimate` on succ-6: 1,150
                // cases with every answer at the 4,096-token output ceiling,
                // twice. Not rounded — a ceiling rounded up is a ceiling
                // nobody computed.
                maxUsd: 6.39,
                programmeMaxMicroUsd: 12_780_000,
                ticket:
                    ".github/audits/memory-eval-v7-budget-approval-2026-08-31.md",
                approvedAt: "2026-08-31",
                // Two: the decision-grade run and the §12.4 independent
                // reproduction. Recorded rather than enforced — see the
                // field's own note — and neither is started by this entry.
                maxProviderDispatchedRuns: 2,
                // The merge commit of the harness switch to succ-6 (#1220).
                // Every value in `boundTuple` was read from this commit. A
                // run's own commit must descend from it, and a clone that
                // cannot see it refuses rather than assuming.
                approvedImplementationSha:
                    "51bebe56fb9833f9a8209fd9ca32aa499865d3d4",
                boundTuple: {
                    datasetVersion: "mem-eval-succ-6",
                    datasetDigest:
                        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63",
                    datasetManifestDigest:
                        "b1904682a2920a6554f533001a2b59cbd2d4cdc06b517aa2b53588c094ce603d",
                    scoringContractVersion: "mem-score-v3.4",
                    scoringContractDigest:
                        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
                    promptVersion: "mem-extract-v7",
                    promptDigest:
                        "7ec5e591628ad719be7f13faf850a537c6f77cfcb22cc50471a245bee7beb912",
                },
            },
            evaluation: null,
        },
        {
            // Registered 2026-09-05, unfunded, and the pair the tree now
            // ships: `MEMORY_EXTRACTION_PROMPT_VERSION` is v8 and the harness
            // targets `mem-eval-succ-9`, so until this entry existed the
            // harness could not name the pair it would run — a state several
            // gates report as a missing entry when what it should read as is a
            // refusal.
            //
            // v7's budget is NOT carried over and could not be. It is bound to
            // v7's prompt digest and to succ-6's dataset and manifest, and
            // `evalBudgetTupleFailures()` compares that tuple against the tree:
            // every one of its seven terms has moved. That comparison is
            // exactly what stops a v8 run being funded by a v7 approval.
            //
            // v7 is also a recorded FAILURE rather than an unfinished
            // measurement — precision 0.7123 against 0.95, recall 0.7268
            // against 0.85, twenty critical bulk-safe adoptions against a gate
            // of zero — and its blind review found no execution or scoring
            // defect that would rescue it. What v8 and succ-9 change is the
            // instrument, not the verdict: nothing here predicts that this
            // pair will score differently, and the first live run is the first
            // measurement of it.
            extractionModelId: "gpt-5-6-luna",
            // Written out, never the shipped constant, for the reason the v1
            // entry gives: reading the constant would move every approval onto
            // the next version without anybody approving anything.
            promptVersion: "mem-extract-v8",
            status: "candidate",
            owner: "@mposition",
            registeredAt: "2026-09-05",
            notes:
                "Candidate for mem-extract-v8 against the frozen " +
                "mem-eval-succ-9, scored under mem-score-v3.5. Registered " +
                "unfunded and never run: `decideEvalRunMode()` refuses a live " +
                "run as `unknown_pair` without an entry and as " +
                "`no_eval_budget` without a budget, and this closes only the " +
                "first of those. (`pair_not_runnable` is a third refusal, for " +
                "a status that is neither candidate nor approved.) " +
                "A budget proposal with the figures to fill in is " +
                ".github/audits/memory-eval-v8-budget-proposal-2026-09-05.md " +
                "— US$6.56 per run and US$13.12 across two. The raw worst case " +
                "from `npm run report:memory-eval-cost-estimate` on succ-9, " +
                "with every answer at the 4,096-token ceiling, is US$6.5574902 " +
                "per run, rounded UP to the cent. Two corrections got it " +
                "there: the report rounded ceilings to nearest, which can put " +
                "a ceiling below the worst case it bounds, and it counted only " +
                "the prompt text while every request also carries the output " +
                "JSON schema as input. " +
                "What is left over the worst case is US$0.0025 per run, about " +
                "ten input tokens per case, and those token counts are " +
                "estimated rather than the provider's own — so whether to hold " +
                "margin above them for estimator error is the approver's " +
                "judgement and is not decided here. Approving is a human act " +
                "and is not done here. " +
                "v7's budget, approval and run history do not transfer: the " +
                "prompt digest, both dataset digests, the manifest digest and " +
                "the contract version have all moved, and v7's own record is a " +
                "decision-grade failure rather than an unfinished run. " +
                "The five cases the v8 examples' kind was counted from left " +
                "the decision set under B+ in succ-9, so this pair is measured " +
                "on cases its prompt did not help select. " +
                "Carried into blind review as a named observation rather than " +
                "a blocker: the matcher's substring residue, " +
                ".github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md " +
                "section 4.14 — a digit-form gold reaches a candidate through " +
                "an unrelated noun that begins with its counter, which no " +
                "right boundary on the Korean-numeral rule can prevent " +
                "because that rule constrains substitution only.",
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
                // The harness reads this as the spend ceiling for ONE
                // invocation. Zero would stop every live run at the first
                // case, and a negative number is a ceiling nobody chose.
                problems.push(
                    `${label}: eval budget maxUsd must be a positive number (got ${maxUsd})`
                );
            }
            // The two ceilings have to agree, and the direction that matters is
            // one way round: a per-run ceiling that, spent to the limit on
            // every approved run, exceeds the programme total is an approval
            // the register would let a runner overspend by simply running
            // again. `accruedCostUsd` restarts at zero on every invocation, so
            // nothing downstream would notice.
            const { programmeMaxMicroUsd, maxProviderDispatchedRuns } =
                entry.evalBudget;
            if (programmeMaxMicroUsd !== undefined) {
                if (
                    !Number.isInteger(programmeMaxMicroUsd) ||
                    programmeMaxMicroUsd <= 0
                ) {
                    problems.push(
                        `${label}: programmeMaxMicroUsd must be a positive whole ` +
                            `number of microUSD (got ${programmeMaxMicroUsd})`
                    );
                } else if (maxProviderDispatchedRuns !== undefined) {
                    const worstCase = Math.round(
                        maxUsd * 1_000_000 * maxProviderDispatchedRuns
                    );
                    if (worstCase > programmeMaxMicroUsd) {
                        problems.push(
                            `${label}: ${maxProviderDispatchedRuns} run(s) at ` +
                                `US$${maxUsd} is ${worstCase} microUSD, above the ` +
                                `approved programme total of ${programmeMaxMicroUsd}`
                        );
                    }
                }
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
