/**
 * HELP-NAV-01: scores the no-model matcher against the answer key.
 *
 * Runs on the local PC or in CI, needs no credentials and writes nothing.
 *
 *   npm run score:help-nav              both splits
 *   npm run score:help-nav -- --split dev
 *   npm run score:help-nav -- --json
 *
 * `dev` is what the rules were tuned on; `holdout` is what they were not.
 * A clarify case passes only when the matcher asks between exactly the same
 * two intents, in any order. Prints case ids and outcomes, never questions.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_NAVIGATION_MATCHER_VERSION, matchHelpQuestion } from "../lib/helpNavigationMatcher.ts";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

export const expectedOf = (entry) =>
    entry.expect
        ? { outcome: "intent", intentId: entry.expect }
        : entry.clarify
          ? { outcome: "clarify", intentIds: [...entry.clarify].sort() }
          : { outcome: "unsupported" };

export const sameOutcome = (expected, actual) => {
    if (expected.outcome !== actual.outcome) return false;
    if (expected.outcome === "intent") return expected.intentId === actual.intentId;
    if (expected.outcome === "clarify") {
        return JSON.stringify(expected.intentIds) === JSON.stringify([...actual.intentIds].sort());
    }
    return true;
};

export const scoreHelpMatcher = (cases, match = matchHelpQuestion) => {
    const bySplit = {};
    for (const entry of cases) {
        const expected = expectedOf(entry);
        const actual = match(entry.question);
        const passed = sameOutcome(expected, actual);
        const split = (bySplit[entry.split] ??= { total: 0, passed: 0, failures: [], unsafe: 0 });
        split.total += 1;
        if (passed) split.passed += 1;
        else {
            split.failures.push({
                id: entry.id,
                expected: expected.outcome === "intent" ? expected.intentId : expected.outcome,
                actual: actual.outcome === "intent" ? actual.intentId : actual.outcome,
            });
            // The failure that matters most: something that should be refused was
            // answered, or offered as a choice between answers.
            if (expected.outcome === "unsupported" && actual.outcome !== "unsupported") split.unsafe += 1;
        }
    }
    return bySplit;
};

const main = () => {
    const args = process.argv.slice(2);
    const splitIndex = args.indexOf("--split");
    const onlySplit = splitIndex >= 0 ? args[splitIndex + 1] : null;
    const key = JSON.parse(readFileSync(resolve(root, "docs/ops/help-nav/answer-key.v2.json"), "utf8"));
    const cases = key.cases.filter((entry) => !onlySplit || entry.split === onlySplit);
    const result = scoreHelpMatcher(cases);
    if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ matcher: HELP_NAVIGATION_MATCHER_VERSION, answerKey: key.version, splits: result }, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${HELP_NAVIGATION_MATCHER_VERSION} against ${key.version}\n`);
    for (const [split, score] of Object.entries(result)) {
        process.stdout.write(
            `${split}: ${score.passed}/${score.total} passed, ${score.unsafe} refusal(s) answered or offered as a choice\n`
        );
        for (const failure of score.failures) {
            process.stdout.write(`  ${failure.id}: expected ${failure.expected}, got ${failure.actual}\n`);
        }
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
