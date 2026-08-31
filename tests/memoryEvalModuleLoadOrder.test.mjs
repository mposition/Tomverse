/**
 * The eval dataset modules load in any order.
 *
 * A cycle among them is not automatically a bug — several exist, and they are
 * harmless while nothing reads across one during initialisation. What is a bug
 * is a cycle where somebody does, because then the failure depends on which
 * module the process happened to import first.
 *
 * That is what adding `mem-eval-succ-6` to the registry produced on
 * 2026-08-31. succ-6 builds its inherited cases from succ-5 at module scope,
 * and succ-4's manifest imported the registry, so importing succ-5 first ran
 * succ-5 → succ-4's manifest → the registry → succ-6 → succ-5 and read an
 * array that did not exist yet. Every unit test passed: the suite's entry
 * order never hit it, and neither did the checks. It surfaced only in a script
 * that imported succ-6 before the prompt module.
 *
 * So this test does not assert the absence of cycles. It asserts the property
 * that actually matters — that each module is importable first — by loading
 * each one in a fresh process, alone and paired with the others. A test in
 * this process could not do it: once the suite has loaded these modules, every
 * subsequent import is a cache hit and proves nothing about order.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const REPO = path.resolve(import.meta.dirname, "..");

/** The modules the succ-4/5/6 cycle runs through. */
const MODULES = [
    "memoryEvalSucc4Dataset",
    "memoryEvalSucc4Manifest",
    "memoryEvalSucc5",
    "memoryEvalSucc6",
    "memoryEvalDatasetRegistry",
    "memoryEvalDatasetCompositions",
    "memoryEvalHarnessTarget",
];

const loads = (modules) => {
    // `pathToFileURL`, not the path. A Windows path begins with a drive
    // letter, and an ESM specifier beginning `H:` is read as a URL scheme —
    // `ERR_UNSUPPORTED_ESM_URL_SCHEME`, "Received protocol 'h:'". The tests
    // passed here and failed on the reviewer's machine, which is the whole
    // failure mode of building a specifier by string concatenation.
    const source = modules
        .map(
            (name) =>
                `import ${JSON.stringify(
                    pathToFileURL(path.join(REPO, "lib", `${name}.ts`)).href
                )};`
        )
        .join("\n");
    const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        { cwd: REPO, encoding: "utf8" }
    );
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
};

test("each dataset module can be the first one imported", () => {
    for (const name of MODULES) {
        const { ok, output } = loads([name]);
        assert.ok(ok, `importing ${name} first fails:\n${output}`);
    }
});

test("no pair of them deadlocks on initialisation order", () => {
    // The shape the defect took: succ-5 then succ-6 threw while succ-6 alone
    // did not. Pairs are enough to catch it — a cycle needs only two entry
    // points to show its asymmetry — and the full permutation would be 5,040
    // processes for the same answer.
    for (const first of MODULES) {
        for (const second of MODULES) {
            if (first === second) continue;
            const { ok, output } = loads([first, second]);
            assert.ok(ok, `importing ${first} then ${second} fails:\n${output}`);
        }
    }
});

test("succ-4's manifest does not depend on the registry", () => {
    // The edge that was cut, asserted as source rather than as behaviour: the
    // pair test above would go green again if somebody restored this import
    // and also made succ-6 lazy, and then the next eager read would bring the
    // whole thing back.
    const source = readFileSync(
        path.join(REPO, "lib", "memoryEvalSucc4Manifest.ts"),
        "utf8"
    );
    assert.doesNotMatch(
        source,
        /import\s*\{[^}]*\}\s*from\s*"@\/lib\/memoryEvalDatasetRegistry"/,
        "succ-4's manifest imports the registry again, which is the cycle"
    );
    assert.match(source, /memoryEvalDatasetCompositions/);
});
