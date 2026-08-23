import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    MEMORY_EVAL_CATEGORY_BY_POLICY_LABEL,
} from "../lib/memoryExtractionEvalCore.ts";

/**
 * The policy states the sample floors in prose and the harness enforces them
 * as numbers. Nothing made the two agree.
 *
 * That gap is not hypothetical here. The 2026-08-23 amendment lowered the
 * critical-negative floor and moved review to a 20% sample, and three places
 * kept describing the rule it replaced: the review-sheet generator asked for
 * every case, and two sentences in this policy still said "critical negative
 * 전건 독립 검수". The generator was the expensive one -- it is what the
 * reviewer actually sees, so it was asking for roughly five times the verdicts
 * the policy wanted.
 *
 * A test cannot read prose for meaning, but it can read the numbers, and the
 * numbers are where a floor change would first disagree.
 */

const policy = readFileSync(
    fileURLToPath(
        new URL(
            "../docs/policy/external-conversation-import-and-memory.md",
            import.meta.url
        )
    ),
    "utf8"
);

/** §12.2's per-category floor lines: "① ...: 언어 arm당 최소 200개". */
const floorsFromPolicy = () => {
    const found = new Map();
    for (const line of policy.split("\n")) {
        const match = /^-\s+\*\*([①②③④]+)[^:*]*:\s*언어 arm당 최소 (\d+)개/.exec(
            line.trim()
        );
        if (!match) continue;
        for (const symbol of [...match[1]]) {
            found.set(symbol, Number(match[2]));
        }
    }
    return found;
};

const LABEL_BY_SYMBOL = { "①": "1", "②": "2", "③": "3", "④": "4" };

test("§12.2's stated floors are the floors the harness enforces", () => {
    const stated = floorsFromPolicy();
    assert.equal(
        stated.size,
        4,
        "expected §12.2 to state a floor for all four categories"
    );
    for (const [symbol, floor] of stated) {
        const category =
            MEMORY_EVAL_CATEGORY_BY_POLICY_LABEL[LABEL_BY_SYMBOL[symbol]];
        assert.equal(
            MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category],
            floor,
            `policy says ${symbol} (${category}) is ${floor} per arm; the harness ` +
                `says ${MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category]}`
        );
    }
});

test("§12.2's stated total is the sum of its own floors", () => {
    // Both arms of all four categories. The total is quoted separately in the
    // prose and in §12.5's budget basis, so it can drift from the per-category
    // lines above it without anything noticing.
    const expected =
        Object.values(MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM).reduce(
            (sum, floor) => sum + floor * 2,
            0
        );
    assert.match(
        policy,
        new RegExp(`전체 하한 \\*\\*${expected.toLocaleString("en-US")}개\\*\\*`),
        `§12.2's total should be ${expected}, the sum of its per-category floors`
    );
    assert.match(
        policy,
        new RegExp(`decision-grade 표본\\s*\\n?\\s*${expected.toLocaleString("en-US")}`),
        `§12.5's budget basis should rest on the same ${expected}`
    );
});

test("the policy does not pin a dataset version that adoption will move", () => {
    // `MEMORY_EVAL_DATASET_VERSION` rises on every adoption. A copy of its
    // value in the policy is wrong from the next adoption onward, and the
    // reader who checks it finds a mismatch with no way to tell which side is
    // stale. Naming the constant stays true.
    assert.doesNotMatch(
        policy,
        /`mem-eval-seed-\d+`/,
        "name MEMORY_EVAL_DATASET_VERSION rather than copying its value"
    );
});
