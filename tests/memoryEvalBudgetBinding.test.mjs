/**
 * The budget's binding to an instrument, and the three refusals that enforce
 * it.
 *
 * The 2026-08-28 re-approval names an immutable tuple — dataset, contract and
 * prompt, each with its version and digest — and says the approval "loses
 * effect immediately" if any of them differs. A sentence in an audit cannot do
 * that, so this is the sentence as a gate, and these are its cases.
 *
 * The last test is the one that matters most in a year's time: it recomputes
 * the tuple from the tree and holds the registered values against it. A digest
 * that drifts fails here rather than in a paid run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
    evalBudgetBindingProblems,
    evalBudgetTupleFailures,
    isFullCommitSha,
} from "../lib/memoryEvalBudgetBinding.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findEvalRegisterProblems,
} from "../lib/memoryExtractionEvalRegister.ts";
import { MEMORY_EVAL_SUCC5_MANIFEST } from "../lib/memoryEvalSucc5.ts";
import { MEMORY_EVAL_SUCC9_MANIFEST } from "../lib/memoryEvalSucc9.ts";
import {
    MEMORY_EXTRACTION_PROMPT_VERSION,
    extractionPromptContract,
} from "../lib/memoryExtractionPrompt.ts";
import {
    harnessRunTuple,
    harnessTarget,
} from "../lib/memoryEvalHarnessTarget.ts";

const fundedPair = () => {
    const entry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (candidate) =>
            candidate.extractionModelId === "gpt-5-6-luna" &&
            candidate.promptVersion === "mem-extract-v6"
    );
    assert.ok(entry, "the funded pair is not registered");
    return entry;
};

/* ------------------------------------------------------------ the tuple -- */

const v7Pair = () => {
    const entry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (candidate) =>
            candidate.extractionModelId === "gpt-5-6-luna" &&
            candidate.promptVersion === "mem-extract-v7"
    );
    assert.ok(entry, "the v7 pair is not registered");
    return entry;
};

test("the v7 instrument no longer describes this tree, and says so", () => {
    // It did until the harness moved past succ-6 on 2026-09-03, and the change
    // in this assertion is the point rather than a breakage: an approval is of
    // a tuple, so pointing the harness at a different dataset ends what that
    // approval funds. v7 was approved on 2026-08-31 for succ-6, ran once
    // against succ-6, and is `revoked`; a run under it now would be a run
    // nobody approved.
    //
    // Every field of the tuple has now moved, and each is named so a later
    // reader can see what moved together: the sample and its record
    // (succ-6 -> succ-8 -> succ-9), the scoring contract (`mem-score-v3.4` ->
    // `mem-score-v3.5`, the Korean numeral amendment), and the prompt
    // (`mem-extract-v7` -> `mem-extract-v8`, which added the worked negated
    // examples). Nothing is left to assert equal, which is itself the
    // statement: v7's approval describes no part of this tree.
    const budget = v7Pair().evalBudget;
    assert.ok(budget?.boundTuple, "the v7 pair records no instrument");
    const actual = harnessRunTuple({
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        promptDigest: createHash("sha256")
            .update(extractionPromptContract(), "utf8")
            .digest("hex"),
    });
    const failures = [...evalBudgetTupleFailures(budget.boundTuple, actual)];
    assert.deepEqual(failures.map((line) => line.split(":")[0]).sort(), [
        "datasetDigest",
        "datasetManifestDigest",
        "datasetVersion",
        "promptDigest",
        "promptVersion",
        "scoringContractDigest",
        "scoringContractVersion",
    ]);
    assert.match(
        failures.find((line) => line.startsWith("datasetVersion")),
        /approved mem-eval-succ-6, this run would use mem-eval-succ-9/
    );
    assert.match(
        failures.find((line) => line.startsWith("scoringContractVersion")),
        /approved mem-score-v3\.4, this run would use mem-score-v3\.5/
    );
    // The prompt was the one term that had not moved until 2026-09-04, and
    // naming it here is how that stopped being true quietly.
    assert.match(
        failures.find((line) => line.startsWith("promptVersion")),
        /approved mem-extract-v7, this run would use mem-extract-v8/
    );
    assert.notEqual(budget.boundTuple.promptDigest, actual.promptDigest);

    // And the tuple check is not simply refusing everything: a budget bound to
    // what this tree would actually assemble passes. Without this half, the
    // assertion above would hold just as well if the check were broken.
    assert.deepEqual([...evalBudgetTupleFailures({ ...actual }, actual)], []);

    // The approved values, written out, so a diff of this file shows what was
    // approved rather than only that something moved
    // (.github/audits/memory-eval-v7-budget-approval-2026-08-31.md section 1).
    assert.deepEqual(budget.boundTuple, {
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
    });
    // A `null` manifest digest would compare equal to itself and pin nothing
    // about the record, so presence is asserted rather than only equality.
    assert.ok(budget.boundTuple.datasetManifestDigest);
});

test("the v7 ceilings are the approved figures, per run and per programme", () => {
    // Two numbers with different meanings, and the difference is the one this
    // file exists for: `accruedCostUsd` restarts at zero every invocation, so
    // `maxUsd` bounds one run and the programme total has to be its own
    // field. Writing US$12.78 into `maxUsd` would have allowed it twice.
    const budget = v7Pair().evalBudget;
    assert.equal(budget.maxUsd, 6.39);
    assert.equal(budget.programmeMaxMicroUsd, 12_780_000);
    assert.equal(budget.programmeMaxMicroUsd, Math.round(budget.maxUsd * 2 * 1_000_000));
    assert.equal(budget.maxProviderDispatchedRuns, 2);
    assert.equal(budget.approvedBy, "@mposition");
    assert.equal(budget.approvedAt, "2026-08-31");
    assert.equal(
        budget.approvedImplementationSha,
        "51bebe56fb9833f9a8209fd9ca32aa499865d3d4"
    );
    assert.match(budget.ticket, /memory-eval-v7-budget-approval-2026-08-31\.md/);
    // The budget is kept after revocation, which is the whole reason the
    // status has to carry the gate: the approval was real and US$0.7893 was
    // really spent against it, so the ceilings above still read as fundable.
    // `evaluation` stays null because no approval was ever granted.
    assert.equal(v7Pair().status, "revoked");
    assert.equal(v7Pair().evaluation, null);
});

test("a revoked pair refuses both ordinals, and would not have without the status", () => {
    // The gap this closes. Run 2 was refused in an audit document, and a
    // manual workflow dispatch does not read audit documents: with the pair
    // left `candidate` the same call comes back live, because the budget it
    // keeps still covers two runs.
    //
    // Both directions are asserted from the *registered* entry rather than a
    // synthetic one, so this fails if someone reopens the pair.
    const registered = v7Pair();
    const target = harnessTarget();
    const input = (entry, runOrdinal) => ({
        live: true,
        registerEntry: entry,
        hasApiKey: true,
        datasetFrozen: target.datasetFrozen,
        datasetPurpose: target.datasetPurpose,
        datasetSchemaVersion: target.datasetSchemaVersion,
        commitKnown: true,
        runSha: "c3c5ff65acd2cd0f4b3c8c6da6d488f4d7f6d1f8",
        runShaDescendsFromApproval: true,
        runTuple: harnessRunTuple({
            promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
            promptDigest: createHash("sha256")
                .update(extractionPromptContract(), "utf8")
                .digest("hex"),
        }),
        unimplementedPromptRules: [],
        requestedRunCapUsd: registered.evalBudget.maxUsd,
        runOrdinal,
    });

    for (const ordinal of [1, 2]) {
        assert.deepEqual(
            decideEvalRunMode(input(registered, ordinal)),
            { mode: "refused", reason: "pair_not_runnable" },
            `ordinal ${ordinal} must refuse while the pair is revoked`
        );
        // Red-before-green, permanently: the only field changed is the
        // status, and it is what turns a live decision into a refusal.
        //
        // This read `dataset_not_frozen` between 2026-09-03 and the signature
        // on 2026-09-04, because the harness pointed at an unsigned successor
        // and the freeze gate answered first. succ-8 is frozen now, so the
        // control is back to what it was written to say: with the status
        // reopened, nothing else refuses.
        assert.equal(
            decideEvalRunMode(input({ ...registered, status: "candidate" }, ordinal))
                .mode,
            "live",
            `ordinal ${ordinal} would run again if the pair were reopened`
        );
    }

    // And the freeze is the target's own, not a synthetic value. succ-8 was
    // signed on 2026-09-04; if it is ever unfrozen this line fails and the
    // control above has to be restated deliberately rather than drifting into
    // passing for a new reason.
    assert.equal(target.datasetFrozen, true);
});

test("v6's instrument cannot fund what this tree now ships", () => {
    // The whole point, and it reads inverted since 2026-08-31 because the
    // tree moved on. Every value below is still recomputed rather than
    // restated; what changed is which answer is correct.
    //
    // While the tree shipped v6 against succ-5 this asserted no divergence at
    // all. Four approved moves have happened since — the prompt to
    // `mem-extract-v7` on 2026-08-31, the harness target to the frozen
    // `mem-eval-succ-6` the same day, on to `mem-eval-succ-7` on 2026-09-03,
    // on again the same day to `mem-eval-succ-8`, which inherits succ-7's
    // 1,150 cases under the amended `mem-score-v3.5`, and on 2026-09-04 to
    // `mem-eval-succ-9`, which replaces five of them — so v6's instrument no
    // longer describes the bytes a run would use. The
    // comparison firing is the protection working. Asserting emptiness today
    // would assert that a v7 run against a different sample may proceed on
    // v6's approval, which is exactly what this file exists to prevent.
    //
    // The divergence is pinned by name, all six of them, so a *seventh* one
    // appearing cannot hide inside an expected failure. Every term of the
    // tuple has now moved away from v6, so nothing is left to assert equal.
    const budget = fundedPair().evalBudget;
    assert.ok(budget?.boundTuple, "the funded pair records no instrument");
    // The production builder, not a copy of it. This test used to assemble
    // the tuple itself, and that is how the live harness came to keep
    // `MEMORY_EVAL_SUCC5_MANIFEST` hard-coded through the switch to succ-6:
    // the test's own object was right, the harness's was not, and nothing
    // compared them. A succ-6 budget would then have been refused as a tuple
    // mismatch at the moment of spending.
    const actual = harnessRunTuple({
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        promptDigest: createHash("sha256")
            .update(extractionPromptContract(), "utf8")
            .digest("hex"),
    });
    // And it really is the dataset the harness would run, named here so a
    // builder that quietly stopped following the target fails.
    assert.equal(actual.datasetVersion, harnessTarget().datasetVersion);
    assert.equal(
        actual.datasetManifestDigest,
        MEMORY_EVAL_SUCC9_MANIFEST.manifestDigest
    );
    const failures = [...evalBudgetTupleFailures(budget.boundTuple, actual)];
    assert.ok(
        failures.length > 0,
        "v6's budget still matches the shipped prompt — a v7 run could take it"
    );
    assert.deepEqual(
        failures.map((line) => line.split(":")[0]).sort(),
        [
            "datasetDigest",
            "datasetManifestDigest",
            "datasetVersion",
            "promptDigest",
            "promptVersion",
            "scoringContractDigest",
            "scoringContractVersion",
        ].sort(),
        `only the prompt, the dataset and the contract were approved to move; failures were:\n${failures.join(
            "\n"
        )}`
    );
    // The contract moved on 2026-09-03 and is named rather than left to the
    // list above, because it is the newest of the four moves and the easiest
    // to mistake for drift: `mem-score-v3.5` amends the Korean numeral rule
    // so a numeral is only read at a word boundary
    // (.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md).
    assert.equal(budget.boundTuple.scoringContractVersion, "mem-score-v3.4");
    assert.equal(actual.scoringContractVersion, "mem-score-v3.5");
    // And v6's own record still says what it always said. The instrument is
    // evidence of an approval that happened; it is not edited when the tree
    // moves past it.
    assert.equal(budget.boundTuple.datasetVersion, "mem-eval-succ-5");
    assert.equal(
        budget.boundTuple.datasetDigest,
        MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest
    );

    // And the approved values, written out, so the diff of any future change
    // to this file shows what was approved rather than only that it moved.
    assert.deepEqual(budget.boundTuple, {
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
    });
});

test("the ceiling, the run count and the implementation SHA are recorded", () => {
    const budget = fundedPair().evalBudget;
    assert.equal(budget.approvedBy, "@mposition");
    assert.equal(budget.approvedAt, "2026-08-28");
    assert.equal(budget.maxProviderDispatchedRuns, 2);
    assert.equal(
        budget.approvedImplementationSha,
        "34a53ddc0247661e578422300ecc58801ea73fce"
    );
    assert.ok(isFullCommitSha(budget.approvedImplementationSha));
});

test("maxUsd is the per-run ceiling and the programme total is separate", () => {
    // The correction of 2026-08-28. `maxUsd` reached the harness as
    // `ceilingUsd` and was compared against `accruedCostUsd`, which starts at
    // zero on every invocation — so recording the US$12.57 programme figure
    // here authorised it *twice*, US$25.14 across the two approved runs. The
    // two numbers are now separate fields, and this is the pair of assertions
    // that keeps them from collapsing back into one.
    const budget = fundedPair().evalBudget;
    assert.equal(budget.maxUsd, 6.285);
    assert.equal(budget.programmeMaxMicroUsd, 12_570_000);
    assert.equal(
        budget.maxUsd * 1_000_000 * budget.maxProviderDispatchedRuns,
        budget.programmeMaxMicroUsd,
        "the per-run ceiling times the approved runs is not the programme total"
    );
    // Stated as its own assertion because it is the mistake, not a corollary:
    // the programme figure must not be what one run may spend.
    assert.notEqual(budget.maxUsd, budget.programmeMaxMicroUsd / 1_000_000);
});

test("a per-run ceiling that would overspend the programme is a register problem", () => {
    // The check that makes the two fields agree, exercised on the shape it
    // exists to catch: the programme figure written into `maxUsd` again.
    const budget = fundedPair().evalBudget;
    const problems = findEvalRegisterProblems([
        {
            ...fundedPair(),
            evalBudget: { ...budget, maxUsd: 12.57 },
        },
    ]);
    assert.ok(
        problems.some((line) => line.includes("above the")),
        problems.join(" | ")
    );
    // And the registered shape has none.
    assert.deepEqual(
        [...findEvalRegisterProblems(MEMORY_EXTRACTION_EVAL_REGISTER)],
        []
    );
});

test("exactly one v6 pair is funded, and it is the approved one", () => {
    // The re-approval funds one pair and says a budget cannot be transferred
    // or applied to another. A second funded v6 entry would be that transfer,
    // however it was labelled.
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
        (entry) => entry.promptVersion === "mem-extract-v6" && entry.evalBudget
    );
    assert.deepEqual(
        funded.map((entry) => entry.extractionModelId),
        ["gpt-5-6-luna"]
    );
    const backup = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-4-mini" &&
            entry.promptVersion === "mem-extract-v6"
    );
    assert.equal(backup.evalBudget, null);
});

test("every differing field is named, not just the first", () => {
    const approved = fundedPair().evalBudget.boundTuple;
    const failures = evalBudgetTupleFailures(approved, {
        ...approved,
        datasetVersion: "mem-eval-succ-4",
        datasetDigest: "f".repeat(64),
        promptDigest: "a".repeat(64),
    });
    assert.equal(failures.length, 3);
    for (const field of ["datasetVersion", "datasetDigest", "promptDigest"]) {
        assert.ok(
            failures.some((line) => line.startsWith(`${field}:`)),
            `${field} went unreported: ${failures.join(" | ")}`
        );
    }
});

/* --------------------------------------------------------- the binding -- */

test("a budget with no instrument cannot fund a run", () => {
    // Every budget recorded before 2026-08-28 is this shape. They were real
    // approvals and stay on the register; what they cannot do is authorise a
    // run, because "which instrument was this ceiling for" has no answer.
    const problems = evalBudgetBindingProblems({
        approvedBy: "@mposition",
        maxUsd: 20,
    });
    assert.equal(problems.length, 2, problems.join(" | "));
    assert.ok(problems.some((line) => line.includes("records no instrument")));
    assert.ok(problems.some((line) => line.includes("approvedImplementationSha")));
});

test("a short or malformed implementation SHA is refused", () => {
    const boundTuple = fundedPair().evalBudget.boundTuple;
    for (const sha of ["34a53ddc", "", "Z".repeat(40), "34A53DDC0247661E578422300ECC58801EA73FCE"]) {
        const problems = evalBudgetBindingProblems({
            boundTuple,
            approvedImplementationSha: sha,
        });
        assert.equal(problems.length, 1, `${sha}: ${problems.join(" | ")}`);
    }
    assert.deepEqual(
        [
            ...evalBudgetBindingProblems({
                boundTuple,
                approvedImplementationSha: "34a53ddc0247661e578422300ecc58801ea73fce",
            }),
        ],
        []
    );
});

test("a run count that is not a positive whole number is refused", () => {
    const boundTuple = fundedPair().evalBudget.boundTuple;
    for (const runs of [0, -1, 1.5, Number.NaN]) {
        const problems = evalBudgetBindingProblems({
            boundTuple,
            approvedImplementationSha: "34a53ddc0247661e578422300ecc58801ea73fce",
            maxProviderDispatchedRuns: runs,
        });
        assert.equal(problems.length, 1, `${runs}: ${problems.join(" | ")}`);
    }
});

/* ------------------------------------------------------------- the gate -- */

const liveInput = (overrides = {}) => ({
    live: true,
    registerEntry: { status: "candidate", evalBudget: { maxUsd: 20 } },
    hasApiKey: true,
    datasetFrozen: true,
    datasetPurpose: "decision",
    datasetSchemaVersion: harnessTarget().datasetSchemaVersion,
    commitKnown: true,
    budgetBindingProblems: [],
    budgetTupleFailures: [],
    runShaDescendsFromApproval: true,
    ...overrides,
});

test("the three budget conditions each refuse, in their own order", () => {
    assert.deepEqual(decideEvalRunMode(liveInput()), {
        mode: "live",
        ceilingUsd: 20,
    });

    for (const [override, reason] of [
        [{ budgetBindingProblems: ["unbound"] }, "budget_not_bound"],
        [{ budgetTupleFailures: ["datasetDigest: ..."] }, "budget_tuple_mismatch"],
        [{ runShaDescendsFromApproval: false }, "run_sha_not_descendant"],
        // Undefined is a refusal too: git could not answer, and an ancestry
        // nobody could check is an ancestry nobody has.
        [{ runShaDescendsFromApproval: undefined }, "run_sha_not_descendant"],
    ]) {
        assert.deepEqual(
            decideEvalRunMode(liveInput(override)),
            { mode: "refused", reason },
            JSON.stringify(override)
        );
    }

    // Order: an unbound budget answers before a mismatched tuple, because a
    // budget with no tuple has nothing to mismatch.
    assert.equal(
        decideEvalRunMode(
            liveInput({
                budgetBindingProblems: ["unbound"],
                budgetTupleFailures: ["datasetDigest: ..."],
                runShaDescendsFromApproval: false,
            })
        ).reason,
        "budget_not_bound"
    );
});

test("a caller that says nothing about the binding is refused", () => {
    // Fail-closed by omission. A live decision reached without the caller
    // establishing the binding is a live decision nobody checked, and the
    // whole point of the re-approval is that this cannot pass silently.
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "candidate", evalBudget: { maxUsd: 20 } },
        hasApiKey: true,
        datasetFrozen: true,
        datasetPurpose: "decision",
        datasetSchemaVersion: harnessTarget().datasetSchemaVersion,
        commitKnown: true,
    });
    assert.deepEqual(decision, {
        mode: "refused",
        reason: "run_sha_not_descendant",
    });
});

test("a run beyond the approved count refuses, and an unstated one too", () => {
    // The approval covers a fixed number of provider-dispatched runs and
    // nothing in the tree can count them, so the invocation says which run it
    // is. A budget that names no run count leaves the gate inert — every
    // budget recorded before 2026-08-28 is that shape — which is why the
    // entry here carries one.
    const twoRuns = (runOrdinal) =>
        liveInput({
            registerEntry: {
                status: "candidate",
                evalBudget: { maxUsd: 20, maxProviderDispatchedRuns: 2 },
            },
            runOrdinal,
        });

    for (const ordinal of [1, 2]) {
        assert.deepEqual(
            decideEvalRunMode(twoRuns(ordinal)),
            { mode: "live", ceilingUsd: 20 },
            `run ${ordinal}`
        );
    }
    for (const ordinal of [undefined, 0, 3, -1, 1.5, Number.NaN]) {
        assert.deepEqual(
            decideEvalRunMode(twoRuns(ordinal)),
            { mode: "refused", reason: "run_ordinal_not_approved" },
            String(ordinal)
        );
    }
    // Absent is a refusal rather than a default of 1. A default would make
    // every unstated run the first one, which is the accounting this gate
    // exists to prevent.
    assert.equal(
        decideEvalRunMode(twoRuns(undefined)).reason,
        "run_ordinal_not_approved"
    );
    // The instrument is checked first: a third run of the wrong instrument is
    // wrong for the instrument, whichever run it claims to be.
    assert.equal(
        decideEvalRunMode({
            ...twoRuns(3),
            budgetTupleFailures: ["datasetDigest: ..."],
        }).reason,
        "budget_tuple_mismatch"
    );
});

test("a budget that names no run count leaves the ordinal unasked", () => {
    // Every budget from before 2026-08-28. They cannot fund a run for other
    // reasons, and this gate is not one of them.
    assert.deepEqual(decideEvalRunMode(liveInput({ runOrdinal: undefined })), {
        mode: "live",
        ceilingUsd: 20,
    });
});

test("smoke mode is not gated by any of it", () => {
    // None of this is about smoke: it spends nothing, so there is no approval
    // to bind it to.
    assert.deepEqual(
        decideEvalRunMode(
            liveInput({
                live: false,
                budgetBindingProblems: ["unbound"],
                budgetTupleFailures: ["datasetDigest: ..."],
                runShaDescendsFromApproval: false,
            })
        ),
        { mode: "smoke" }
    );
});
