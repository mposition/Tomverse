/**
 * succ-7 structural checks.
 *
 * Runs while the successor is still being built, and FAILS until it is whole.
 * A half-assembled dataset that reports "OK" is the failure mode worth
 * spending a script on: succ-7 replaces 54 cases, and a tranche that landed
 * without its transition row, or a cell that quietly lost a case, is invisible
 * to every other check in the tree until a paid run scores the wrong sample.
 *
 * Nothing here freezes anything. Freezing stays a human act recorded in the
 * register (docs/policy/external-conversation-import-and-memory.md 12.4).
 */
import { existsSync, readFileSync } from "node:fs";

import { MEMORY_EVAL_SUCC6_CASES } from "../lib/memoryEvalSucc6.ts";
import { ASSISTANT_ONLY_SUBTYPES } from "../lib/memoryEvalAssistantOnlySubtypes.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";
import { SUCC7_ASSISTANT_ONLY_SUBTYPES } from "../lib/memoryEvalSucc7Replacements/subtypes.ts";
import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_FROZEN,
    buildSucc7DraftManifest,
    succ7AssemblyProblems,
} from "../lib/memoryEvalSucc7.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";
import { MEMORY_EVAL_SUCC6_MANIFEST, verifySucc6Manifest } from "../lib/memoryEvalSucc6.ts";

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const ok = (label, detail) =>
    notes.push(`OK    ${label}${detail ? `  — ${detail}` : ""}`);

const cellOf = (c) => `${c.category}:${c.language}`;
const succ6ById = new Map(MEMORY_EVAL_SUCC6_CASES.map((c) => [c.id, c]));

/* ------------------------------------------------- the transition table -- */

if (SUCC7_TRANSITION.length !== 54) {
    fail(`the transition names ${SUCC7_TRANSITION.length} moves, not 54`);
} else {
    ok("the transition is 54 moves", "54 out, 54 in");
}

const retired = SUCC7_TRANSITION.map((r) => r.retired);
const replacements = SUCC7_TRANSITION.map((r) => r.replacement);

for (const [label, ids] of [
    ["retired", retired],
    ["replacement", replacements],
]) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
        fail(`${label} ids repeat: ${[...new Set(dupes)].join(", ")}`);
    }
}
if (retired.some((id) => replacements.includes(id))) {
    fail("a case is listed as both retired and its own replacement");
}

for (const row of SUCC7_TRANSITION) {
    const from = succ6ById.get(row.retired);
    if (!from) {
        fail(`${row.retired} is retired but is not in succ-6`);
        continue;
    }
    if (succ6ById.has(row.replacement)) {
        fail(`${row.replacement} already exists in succ-6`);
    }
    // 1:1 means same cell, or the cell counts move and the floors move with
    // them. Checked per row rather than by comparing totals, because two
    // errors in opposite directions cancel in a total.
    const wantFamily = row.retired.split("-")[1];
    const wantLang = row.retired.split("-")[2];
    const gotFamily = row.replacement.split("-")[1];
    const gotLang = row.replacement.split("-")[2];
    if (wantFamily !== gotFamily || wantLang !== gotLang) {
        fail(
            `${row.retired} (${wantFamily}/${wantLang}) is replaced by ` +
                `${row.replacement} (${gotFamily}/${gotLang}) — not the same cell`
        );
    }
}
if (failures.length === 0) {
    ok("every replacement is same-cell and new", `${retired.length} rows`);
}

/* -------------------------------------- the assistant_only subtype floor -- */

for (const lang of ["ko", "en"]) {
    const cell = MEMORY_EVAL_SUCC6_CASES.filter(
        (c) => c.category === "assistant_only" && c.language === lang
    );
    const floor = Math.ceil(cell.length * 0.3);
    const leaving = retired.filter((id) =>
        id.startsWith(`succ-assistant-${lang}-`)
    );
    const leavingS34 = leaving.filter((id) =>
        [3, 4].includes(ASSISTANT_ONLY_SUBTYPES[id]?.subtype)
    );
    const present = cell.filter((c) =>
        [3, 4].includes(ASSISTANT_ONLY_SUBTYPES[c.id]?.subtype)
    ).length;
    // Every departing case is subtype 3, and both arms sit exactly on the
    // floor, so the replacements have no slack: each one has to be subtype 3
    // or 4 or the arm is under the moment succ-7 exists.
    const required = leavingS34.length;
    const declared = replacements
        .filter((id) => id.startsWith(`succ-assistant-${lang}-`))
        .filter((id) =>
            [3, 4].includes(SUCC7_ASSISTANT_ONLY_SUBTYPES[id]?.subtype)
        ).length;
    if (declared < required) {
        fail(
            `assistant_only:${lang} — ${required} replacement(s) must be ` +
                `subtype 3 or 4 (the departing cases are), ${declared} are ` +
                `declared in ASSISTANT_ONLY_SUBTYPES. Floor is ${floor} of ` +
                `${cell.length}, currently met with 0 to spare (${present}).`
        );
    } else {
        ok(
            `assistant_only:${lang} subtype floor`,
            `${required} replacement(s) declared subtype 3/4, floor ${floor}`
        );
    }
}

/* ---------------------------------------------- the replacement bodies --- */

const bodyPath = new URL(
    "../lib/memoryEvalSucc7Replacements/index.ts",
    import.meta.url
).pathname;
let bodies = [];
if (existsSync(bodyPath)) {
    ({ MEMORY_EVAL_SUCC7_REPLACEMENTS: bodies = [] } = await import(
        "../lib/memoryEvalSucc7Replacements/index.ts"
    ));
}
const built = new Set(bodies.map((c) => c.id));
const missing = replacements.filter((id) => !built.has(id));
const stray = [...built].filter((id) => !replacements.includes(id));

if (stray.length > 0) {
    fail(`written but not in the transition: ${stray.join(", ")}`);
}
if (missing.length > 0) {
    const byCell = {};
    for (const id of missing) {
        const k = `${id.split("-")[1]}:${id.split("-")[2]}`;
        byCell[k] = (byCell[k] ?? 0) + 1;
    }
    fail(
        `${missing.length} of 54 replacement bodies are not written yet — ` +
            Object.entries(byCell)
                .sort()
                .map(([k, n]) => `${k} ${n}`)
                .join(", ")
    );
} else {
    ok("all 54 replacement bodies exist");
}


/* ------------------------------------------------- the assembled dataset -- */

for (const problem of succ7AssemblyProblems()) fail(problem);

const cellsOf = (cases) => {
    const counts = {};
    for (const c of cases) {
        const k = `${c.category}:${c.language}`;
        counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
};
const before = cellsOf(MEMORY_EVAL_SUCC6_CASES);
const after = cellsOf(MEMORY_EVAL_SUCC7_CASES);
if (MEMORY_EVAL_SUCC7_CASES.length !== MEMORY_EVAL_SUCC6_CASES.length) {
    fail(
        `succ-7 holds ${MEMORY_EVAL_SUCC7_CASES.length} cases, succ-6 holds ` +
            `${MEMORY_EVAL_SUCC6_CASES.length} — a 1:1 transition changes neither`
    );
} else {
    ok("case count preserved", `${MEMORY_EVAL_SUCC7_CASES.length}`);
}
const movedCells = Object.keys({ ...before, ...after }).filter(
    (cell) => before[cell] !== after[cell]
);
if (movedCells.length > 0) {
    fail(`cell counts moved: ${movedCells.join(", ")}`);
} else {
    ok("every cell count preserved");
}

// The subtype composition, not merely the floor. All fourteen departing cases
// are subtype 3, so a replacement declared subtype 4 would hold the floor and
// still change what the arm measures.
for (const lang of ["ko", "en"]) {
    const out = retired.filter((id) => id.startsWith(`succ-assistant-${lang}-`));
    const inn = replacements.filter((id) =>
        id.startsWith(`succ-assistant-${lang}-`)
    );
    const tally = (ids, table) => {
        const t = {};
        for (const id of ids) {
            const s = table[id]?.subtype;
            if (s !== undefined) t[s] = (t[s] ?? 0) + 1;
        }
        return JSON.stringify(t);
    };
    const outT = tally(out, ASSISTANT_ONLY_SUBTYPES);
    const inT = tally(inn, SUCC7_ASSISTANT_ONLY_SUBTYPES);
    if (outT !== inT) {
        fail(
            `assistant_only:${lang} subtype composition changed — out ${outT}, in ${inT}`
        );
    } else {
        ok(`assistant_only:${lang} subtype composition preserved`, outT);
    }
}

/* ---------------------------------------------------- regression corpus -- */

if (SUCC7_REGRESSION_CORPUS.length !== 54) {
    fail(`the regression corpus holds ${SUCC7_REGRESSION_CORPUS.length}, not 54`);
}
const decisionIds = new Set(MEMORY_EVAL_SUCC7_CASES.map((c) => c.id));
const crossed = SUCC7_REGRESSION_CORPUS.filter((e) =>
    decisionIds.has(e.originalCase.id)
);
if (crossed.length > 0) {
    fail(
        `${crossed.length} regression case(s) are still in the decision set: ` +
            crossed.map((e) => e.originalCase.id).join(", ")
    );
} else {
    ok("decision and regression do not intersect", "0 shared ids");
}
const approved = SUCC7_REGRESSION_CORPUS.filter((e) => e.basis === "approved10");
const carried = SUCC7_REGRESSION_CORPUS.filter((e) => e.basis === "polarity44");
if (approved.length !== 10 || carried.length !== 44) {
    fail(`bases split ${approved.length}/${carried.length}, not 10/44`);
} else {
    ok("the two preservation bases are kept apart", "10 corrected, 44 as held");
}
for (const entry of approved) {
    if (entry.correctionRecord.length === 0) {
        fail(`${entry.originalCase.id} is approved10 but records no correction`);
        continue;
    }
    // A corrected gold that cannot anchor is no more scoreable than a
    // metadata row, which is what section 12.2 refuses.
    const messages = new Map(
        (entry.originalCase.conversations ?? []).flatMap((cv) =>
            (cv.messages ?? []).map((m) => [m.externalMessageId, m.content])
        )
    );
    for (const gold of entry.correctionRecord) {
        const source = messages.get(gold.evidence?.evidenceMessageId);
        if (source === undefined) {
            fail(`${entry.originalCase.id} corrected gold cites an unknown message`);
            continue;
        }
        if (!source.includes(gold.evidence.evidenceQuote)) {
            fail(`${entry.originalCase.id} corrected quote is not in its message`);
        }
        for (const token of gold.factValueAll ?? []) {
            if (!gold.evidence.evidenceQuote.includes(token)) {
                fail(
                    `${entry.originalCase.id} corrected gold token "${token}" ` +
                        `is outside its own quote`
                );
            }
        }
    }
}
for (const entry of carried) {
    if (entry.regressionCase !== entry.originalCase) {
        fail(`${entry.originalCase.id} is polarity44 but its gold was rewritten`);
    }
}
if (failures.length === 0) ok("corrected golds anchor, carried golds untouched");

/* ------------------------------------------------------ transition types -- */

// The split is a claim about what the dataset measures, so it is asserted
// rather than reported. A coverage repair folded into the same-boundary count
// would have the manifest say 54 boundaries are still covered when one is not.
const sameBoundary = SUCC7_TRANSITION.filter(
    (r) => r.transitionType === "same_boundary"
);
const coverageRepair = SUCC7_TRANSITION.filter(
    (r) => r.transitionType === "coverage_repair"
);
if (sameBoundary.length !== 53 || coverageRepair.length !== 1) {
    fail(
        `transition types split ${sameBoundary.length}/${coverageRepair.length}, ` +
            `not 53 same_boundary / 1 coverage_repair`
    );
} else {
    ok("transition types", "53 same_boundary / 1 coverage_repair, counted apart");
}
for (const row of coverageRepair) {
    if (!row.unresolvedPolicy) {
        fail(`${row.retired} is a coverage repair and records no open question`);
    }
    const entry = SUCC7_REGRESSION_CORPUS.find(
        (e) => e.originalCase.id === row.retired
    );
    if (!entry?.unresolvedPolicy) {
        fail(`${row.retired}'s open question is not preserved in regression`);
    }
}
for (const row of sameBoundary) {
    if (row.unresolvedPolicy) {
        fail(`${row.retired} is same_boundary but carries an open question`);
    }
}
{
    const manifest = buildSucc7DraftManifest();
    if (
        manifest.transitionTypes.same_boundary !== sameBoundary.length ||
        manifest.transitionTypes.coverage_repair !== coverageRepair.length
    ) {
        fail("the manifest's transition tally disagrees with the transition");
    }
    if (manifest.unresolvedPolicies.length !== coverageRepair.length) {
        fail("the manifest does not carry every open question");
    }
    if (failures.length === 0) {
        ok(
            "the tally and the open question are bound into the digest",
            `manifestDigest ${manifest.manifestDigest.slice(0, 16)}…`
        );
    }
}

/* --------------------------------------------------------- import graph -- */

// The regression corpus must not be reachable from the decision loader. It
// holds the cases succ-7 exists to have removed, and a module that can see
// them can score them: an import here is how a retired case gets back into a
// run without anyone deciding to put it there. Checked as text, because that
// is what an import is — reading the module and inspecting its exports would
// have already executed the import being forbidden.
const DECISION_LOADERS = [
    "../lib/memoryEvalSucc7.ts",
    "../lib/memoryEvalSucc7Replacements/index.ts",
    "../lib/memoryEvalSucc7Replacements/assistantOnly.ts",
    "../lib/memoryEvalSucc7Replacements/durableFacts.ts",
    "../lib/memoryEvalSucc7Replacements/injectionDirectives.ts",
    "../lib/memoryEvalSucc7Transition.ts",
];
let importsRegression = false;
for (const rel of DECISION_LOADERS) {
    const text = readFileSync(new URL(rel, import.meta.url).pathname, "utf8");
    for (const line of text.split("\n")) {
        const code = line.replace(/^\s*/, "");
        if (code.startsWith("*") || code.startsWith("//")) continue;
        if (/\bfrom\s+["'][^"']*memoryEvalSucc7Regression["']/.test(code)) {
            fail(`${rel} imports the regression corpus`);
            importsRegression = true;
        }
    }
}
if (!importsRegression) {
    ok("the decision loader cannot reach the regression corpus");
}

/* ------------------------------------------------------ succ-6 untouched -- */

const drift = verifySucc6Manifest();
if (drift.length > 0) {
    fail(`succ-6 no longer matches its signed manifest: ${drift.join("; ")}`);
} else {
    ok("succ-6 still matches its signed manifest", "sample, digests, signature");
}
const manifest = buildSucc7DraftManifest();
if (manifest.composition.sourceDatasetDigest !== MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest) {
    fail("succ-7 records a source digest succ-6's own manifest does not agree with");
} else {
    ok("succ-7's source digest is succ-6's pinned digest");
}

/* ------------------------------------------------------------- not frozen -- */

if (MEMORY_EVAL_SUCC7_DATASET_FROZEN !== false || manifest.frozen !== false) {
    fail("succ-7 claims to be frozen; adoption is a human act and has not happened");
} else {
    ok("succ-7 is assembled and NOT frozen", "assembled=true reviewed=false frozen=false");
}

console.log("");
console.log(`  datasetVersion    ${manifest.datasetVersion}`);
console.log(`  supersedes        ${manifest.supersedes}`);
console.log(`  caseCount         ${manifest.caseCount}`);
console.log(`  datasetDigest     ${manifest.datasetDigest}`);
console.log(`  manifestDigest    ${manifest.manifestDigest}`);
console.log(
    `  transitions       same_boundary ${manifest.transitionTypes.same_boundary}` +
        ` / coverage_repair ${manifest.transitionTypes.coverage_repair}`
);
console.log(`  unresolvedPolicy  ${manifest.unresolvedPolicies.length}`);
console.log(`  frozen            ${manifest.frozen}`);
console.log(`  harness target    mem-eval-succ-6 (unchanged)`);
console.log("");

/* ------------------------------------------------------------- report --- */

for (const line of notes) console.log(line);
if (failures.length > 0) {
    console.error("\nsucc-7 is not whole:\n");
    for (const f of failures) console.error(`  FAIL  ${f}`);
    console.error(
        "\nThis check fails by design until the successor is complete. It " +
            "does not freeze anything either way."
    );
    process.exit(1);
}
console.log("\nsucc-7 structural checks all hold. Freezing is still a human act.");
