/**
 * An answer call and a judge call do different work and must not share an
 * output budget.
 *
 * The 2026-08-28 pilot gave both 2,048 tokens. The product asks 128,000-384,000
 * for the same answer models and every one of them bills reasoning out of that
 * budget, so a reasoning model could spend the whole allowance thinking and
 * return nothing. 60 auto-arm answers came back empty and the run was void.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getModel } from "../lib/models.ts";
import {
    CALL_LIMIT_PROFILE_VERSION,
    JUDGE_MAX_OUTPUT_TOKENS,
    buildCallLimitManifest,
    callLimitManifestProblems,
    resolveCallLimit,
} from "../lib/routerCallLimits.ts";

const deepseek = getModel("deepseek-v4-flash");
const fable = getModel("claude-fable-5");

test("an answer call asks for what the product asks for", () => {
    const limit = resolveCallLimit(deepseek, "answer");
    assert.equal(limit.requestedMaxOutputTokens, limit.resolvedProductOutputCap);
    assert.ok(limit.requestedMaxOutputTokens > 2_048, "the cap that emptied 60 answers");
    assert.equal(limit.limitSource, "product_pricing_profile");
    assert.equal(limit.callRole, "answer");
    assert.equal(limit.apiModelId, "deepseek-v4-flash");
    assert.ok(limit.pricingVersion.length > 0);
    assert.equal(limit.profileVersion, CALL_LIMIT_PROFILE_VERSION);
});

test("a judge call gets a verdict-sized budget, not a chat-sized one", () => {
    const limit = resolveCallLimit(fable, "judge");
    assert.equal(limit.requestedMaxOutputTokens, JUDGE_MAX_OUTPUT_TOKENS);
    assert.equal(limit.limitSource, "judge_structured_verdict");
    // Still records what the product would have asked, because that is one of
    // the four conditions budget exhaustion is decided on.
    assert.ok(limit.resolvedProductOutputCap > JUDGE_MAX_OUTPUT_TOKENS);
});

test("the judge budget has room for the reasoning it is billed for", () => {
    // Not sized for the verdict -- a verdict is a few tokens. Sized for the
    // thinking in front of it, because that is billed out of the same budget
    // and a judge that exhausts it returns nothing to parse.
    assert.equal(resolveCallLimit(fable, "judge").reasoningTokenBilling, "billed_as_output");
    assert.ok(JUDGE_MAX_OUTPUT_TOKENS >= 4_096);
});

test("a manifest freezes one entry per model and role", () => {
    const manifest = buildCallLimitManifest(
        [
            { model: deepseek, callRole: "answer" },
            { model: deepseek, callRole: "answer" },
            { model: deepseek, callRole: "judge" },
            { model: fable, callRole: "judge" },
        ],
        () => new Date("2026-08-28T00:00:00.000Z")
    );
    assert.equal(manifest.entries.length, 3);
    assert.equal(manifest.frozenAt, "2026-08-28T00:00:00.000Z");
    assert.equal(manifest.profileVersion, CALL_LIMIT_PROFILE_VERSION);
    for (const entry of manifest.entries) {
        for (const field of [
            "modelId",
            "apiModelId",
            "callRole",
            "requestedMaxOutputTokens",
            "limitSource",
            "profileVersion",
            "pricingVersion",
        ]) {
            assert.ok(entry[field] !== undefined && entry[field] !== null, `${field} is frozen`);
        }
    }
    assert.deepEqual(callLimitManifestProblems(manifest), []);
});

test("a run that froze nothing cannot say what it asked for", () => {
    assert.equal(callLimitManifestProblems(null).length, 1);
    assert.match(callLimitManifestProblems(undefined)[0], /froze no call-limit manifest/);
});

test("a manifest from another profile version is refused", () => {
    const manifest = buildCallLimitManifest([{ model: deepseek, callRole: "answer" }]);
    const problems = callLimitManifestProblems({ ...manifest, profileVersion: "router-call-limits-v0" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /frozen under router-call-limits-v0/);
});

test("an answer arm capped below the product's own cap is refused", () => {
    // The defect itself, as a manifest: it says in writing that the run
    // measured the models under a cap the product never applies.
    const manifest = buildCallLimitManifest([{ model: deepseek, callRole: "answer" }]);
    const starved = {
        ...manifest,
        entries: [{ ...manifest.entries[0], requestedMaxOutputTokens: 2_048 }],
    };
    const problems = callLimitManifestProblems(starved);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /asks for 2048 against the product's/);
});
