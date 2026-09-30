/**
 * Applies the pre-registered admissibility rules to a finished eval run.
 *
 *   npm run check:memory-eval-run -- --artifact=artifacts/mem-eval-run1.json
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2 requires the
 * exclusion and re-run rules to be fixed **before** the run, because rules
 * chosen after the numbers are read explain the numbers. The rules were fixed
 * and confirmed on 2026-08-24 and live in
 * docs/ops/memory-extraction-decision-grade-run.md §3. This applies them.
 *
 * ## Why a script and not a reading
 *
 * The rules are a handful of signals in a manifest — mostly booleans, and one
 * derived from a pair of numbers for artifacts that predate its flag — and
 * re-deciding what each one means at the end of a run, with the verdict
 * already on screen, is exactly the drift the pre-registration exists to
 * prevent. Written down here, "was this run admissible" stops being a
 * judgement and goes back to being a lookup.
 *
 * The count used to be written as "five boolean fields". It was six by the
 * time anybody noticed, and one of them is not a boolean.
 *
 * ## What it does not decide
 *
 * Whether the run **passed**. That is §12.3, computed by the harness and read
 * by a person. This answers the earlier question: may that verdict be cited at
 * all. An inadmissible run's numbers are not bad news, they are not news.
 */

import { readFileSync } from "node:fs";

// Plain `.mjs`, so this script keeps running under bare `node` with no loader.
// The same function decides the question inside the harness, which is what
// stops the two drifting into different answers about the same run.
import { manifestExceededSpendCeiling } from "../lib/memoryEvalSpendCeiling.mjs";

const argValue = (name, fallback) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const artifactPath = argValue("artifact", "");
if (!artifactPath) {
    console.error("--artifact=<path> is required.");
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(artifactPath, "utf8")).manifest ?? {};

/**
 * The pre-registered rules, in the order they are written in §3.
 *
 * `discards` separates the two kinds deliberately. A dirty tree and a
 * truncated sample are reasons the run cannot be cited; an unpriced call is a
 * cost-accounting problem and not a quality one, and folding it in would
 * either throw away a sound run or let an unbounded one pass as bounded.
 */
const RULES = [
    {
        // First, because `workingTreeDirty` cannot be trusted without it: a
        // run with no git metadata reports the tree clean and the commit
        // "unknown", which reads like a spotless checkout. The harness now
        // refuses such a run outright; this stays for artifacts made before
        // it did.
        key: "commitSha",
        fails: (m) => !m.commitSha || m.commitSha === "unknown",
        discards: true,
        met: "the run cannot name the commit it ran",
        action: "discard — an artifact with no commit is not evidence",
    },
    {
        key: "workingTreeDirty",
        fails: (m) => m.workingTreeDirty === true,
        discards: true,
        met: "the commit does not describe what ran",
        action: "discard and re-run from a clean tree",
    },
    {
        key: "truncatedByCostCeiling",
        fails: (m) => m.truncatedByCostCeiling === true,
        discards: true,
        met: "stopped at the cost ceiling, so this is not the whole sample",
        action: "discard and re-run with a ceiling that fits the run",
    },
    {
        // Its own rule, not folded into the truncation above. The two are
        // different facts about a run and only one of them was checked: a
        // truncated run stopped early at the ceiling, an over-ceiling run
        // finished having passed it on a call the pre-dispatch comparison
        // could not see. An artifact carrying `exceededCostCeiling: true` and
        // `decisionGrade: true` — which the harness will not now produce, but
        // which an older artifact or a hand-edited one can — read as
        // Admissible with exit 0.
        key: "exceededCostCeiling",
        // A `false` flag never rescues; a `true` flag can always condemn.
        //
        // Not "the flag first", which is how this comment used to read and is
        // not what `manifestExceededSpendCeiling()` does: numbers that say a
        // run went over beat a `false` flag beside them, and numbers that
        // cannot be read are not rescued by one either. A `true` flag outlives
        // both — the harness wrote it from its own live state — and honouring
        // it records the more specific reason, since either way the run is
        // discarded.
        //
        // The first version read only the flag, so an artifact written before
        // 2026-09-05 — carrying `accruedCostUsd: 7.0001` beside
        // `runCeilingUsd: 7` and no verdict — came back Admissible with exit 0.
        // Every artifact this project has ever produced is in that category,
        // which makes reading the figures the part that matters.
        fails: (m) => manifestExceededSpendCeiling(m).exceeded,
        discards: true,
        met: "finished having spent more than the approved ceiling",
        action: "discard — the run that happened is not the run approved",
    },
    {
        // Not the same as "did not overspend". A live artifact carrying no
        // spend figures, or a corrupted one, produces
        // `{ exceeded: false, source: "unknown" }` — and the rule above reads
        // only `.exceeded`, so it printed `OK exceededCostCeiling` and the run
        // exited 0. That is a live run whose spend nobody can compare against
        // its ceiling, presented as one that stayed inside it.
        //
        // Distinct from `spendCeilingReliable`, which is deliberately not a
        // discard: that says *some calls* could not be priced, so the accrued
        // figure is a lower bound and the verdict stands while the cost is
        // settled from the invoice. This says the artifact cannot state what it
        // spent at all, which is not a cost-accounting problem but a missing
        // fact about the run.
        key: "spendComparableToCeiling",
        fails: (m) =>
            m.mode === "live" &&
            manifestExceededSpendCeiling(m).source === "unknown",
        discards: true,
        met: "a live run with no comparable spend and ceiling figures",
        action: "discard — nothing here can say the run stayed within approval",
    },
    {
        key: "abortedOnConsecutiveFailures",
        fails: (m) => m.abortedOnConsecutiveFailures === true,
        discards: true,
        met: "five consecutive unscoreable answers — broken, not unlucky",
        action: "discard and find the cause before spending again",
    },
    {
        key: "decisionGrade",
        fails: (m) => m.decisionGrade !== true,
        discards: true,
        met: "one of live / at-floor / frozen is missing",
        action: "not citable as a decision-grade run",
    },
    {
        key: "spendCeilingReliable",
        fails: (m) => m.spendCeilingReliable !== true,
        discards: false,
        met: "some calls could not be priced, so the accrued figure is a lower bound",
        action: "the verdict stands; settle the cost from the provider invoice",
    },
];

console.log(`\nRun admissibility — ${artifactPath}`);
console.log(
    `  ${manifest.modelId}::${manifest.promptVersion}  ` +
        `${manifest.datasetVersion}  ${String(manifest.commitSha).slice(0, 12)}\n`
);

const triggered = RULES.filter((rule) => rule.fails(manifest));
for (const rule of RULES) {
    const hit = rule.fails(manifest);
    const mark = !hit ? "OK  " : rule.discards ? "STOP" : "NOTE";
    console.log(
        `${mark}  ${rule.key.padEnd(30)} ${
            hit ? `${rule.met} → ${rule.action}` : ""
        }`
    );
}

const discarding = triggered.filter((rule) => rule.discards);
if (discarding.length === 0) {
    console.log(
        `\nAdmissible. ${
            triggered.length > 0
                ? "Note the line above before quoting a cost.\n"
                : "Whether it passed is docs/policy/external-conversation-import-and-memory.md §12.3, which the harness computed.\n"
        }`
    );
    process.exit(0);
}
console.log(
    `\nNot admissible: ${discarding.map((rule) => rule.key).join(", ")}.\n` +
        "The pre-registered rule discards this run, so its verdict is not a result\n" +
        "either way — a re-run of it is a first run again, not the independent\n" +
        "re-run §12.2 asks for.\n"
);
process.exit(1);
