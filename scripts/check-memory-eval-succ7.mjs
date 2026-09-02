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
import { existsSync } from "node:fs";

import { MEMORY_EVAL_SUCC6_CASES } from "../lib/memoryEvalSucc6.ts";
import { ASSISTANT_ONLY_SUBTYPES } from "../lib/memoryEvalAssistantOnlySubtypes.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";

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
        .filter((id) => [3, 4].includes(ASSISTANT_ONLY_SUBTYPES[id]?.subtype))
        .length;
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
