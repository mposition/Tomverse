import { strict as assert } from "node:assert";
import test from "node:test";

import {
    DEFAULT_PRODUCT_KEY_READ_MODE,
    LEGACY_FALLBACK_MAX_DAYS,
    parseRfc3339,
    readProductKey,
    resolveProductKeyReadMode,
} from "../lib/productKeyReadMode.ts";

/**
 * Decision record v1.2 §2 — the legacy fallback's expiry.
 *
 * Three refusals, and each one closes a different way the transition becomes
 * permanent: no value at all, a value that already passed, and a value further
 * out than the policy allows. The third is the one an operator reaches for
 * when the transition is inconvenient; without it, 2099 passes.
 */

const NOW = new Date("2026-08-22T00:00:00Z");
const DEPLOYED = "2026-08-22T00:00:00Z";

const resolve = (overrides) =>
    resolveProductKeyReadMode({
        mode: "legacy_fallback",
        expiresAt: "2026-09-10T00:00:00Z",
        expandDeployedAt: DEPLOYED,
        now: NOW,
        ...overrides,
    });

const codes = (resolution) => resolution.problems.map((problem) => problem.code);

/* ---------------------------------------------------------------- modes */

test("an unset mode is the transition's own state", () => {
    // So an expand deploy that has not been told about the variable still
    // reads old rows. It does not weaken the expiry -- see below.
    const resolution = resolve({ mode: undefined });
    assert.equal(resolution.mode, "legacy_fallback");
    assert.equal(DEFAULT_PRODUCT_KEY_READ_MODE, "legacy_fallback");
});

test("an unset mode still has to carry an expiry", () => {
    const resolution = resolve({ mode: undefined, expiresAt: undefined });
    assert.equal(resolution.mode, null);
    assert.deepEqual(codes(resolution), ["missing_expiry"]);
});

test("a mode nobody enumerated is refused, not defaulted", () => {
    const resolution = resolve({ mode: "lenient" });
    assert.equal(resolution.mode, null);
    assert.deepEqual(codes(resolution), ["unknown_mode"]);
});

test("strict needs no expiry: there is nothing left to expire", () => {
    const resolution = resolve({
        mode: "strict",
        expiresAt: undefined,
        expandDeployedAt: undefined,
    });
    assert.equal(resolution.mode, "strict");
    assert.deepEqual(resolution.problems, []);
});

/* ------------------------------------------------- the three refusals */

test("1. a missing expiry makes the fallback terminal, so it is refused", () => {
    const resolution = resolve({ expiresAt: undefined });
    assert.equal(resolution.mode, null);
    assert.deepEqual(codes(resolution), ["missing_expiry"]);
});

test("2. an expiry that has already passed is refused", () => {
    const resolution = resolve({ expiresAt: "2026-08-21T23:59:59Z" });
    assert.equal(resolution.mode, null);
    assert.ok(codes(resolution).includes("expiry_in_the_past"));
});

test("an expiry exactly now is past, not future", () => {
    const resolution = resolve({ expiresAt: "2026-08-22T00:00:00Z" });
    assert.ok(codes(resolution).includes("expiry_in_the_past"));
});

test("3. an expiry beyond the maximum lifetime is refused", () => {
    // Without this, 2099-01-01 passes every other check and the policy has no
    // teeth.
    const resolution = resolve({ expiresAt: "2099-01-01T00:00:00Z" });
    assert.equal(resolution.mode, null);
    assert.ok(codes(resolution).includes("expiry_beyond_maximum_lifetime"));
});

test("the maximum lifetime is measured from the expand deploy", () => {
    const lastAllowed = new Date(
        Date.parse(DEPLOYED) + LEGACY_FALLBACK_MAX_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    assert.equal(resolve({ expiresAt: lastAllowed }).mode, "legacy_fallback");
    assert.ok(
        codes(
            resolve({
                expiresAt: new Date(Date.parse(lastAllowed) + 1000).toISOString(),
            })
        ).includes("expiry_beyond_maximum_lifetime")
    );
});

test("a missing anchor is its own refusal, not a reason to skip the limit", () => {
    // A limit that stops applying when its input is missing is not a limit.
    const resolution = resolve({ expandDeployedAt: undefined });
    assert.equal(resolution.mode, null);
    assert.deepEqual(codes(resolution), ["missing_expand_anchor"]);
});

test("a malformed anchor is refused rather than interpreted", () => {
    const resolution = resolve({ expandDeployedAt: "2026-08-22" });
    assert.equal(resolution.mode, null);
    assert.ok(codes(resolution).includes("expand_anchor_not_rfc3339"));
});

/* ------------------------------------------------------------- RFC 3339 */

test("an offset is required, because a deadline cannot be ambiguous", () => {
    assert.equal(parseRfc3339("2026-09-10T00:00:00"), null);
    assert.ok(parseRfc3339("2026-09-10T00:00:00Z"));
    assert.ok(parseRfc3339("2026-09-10T09:00:00+09:00"));
    assert.ok(parseRfc3339("2026-09-10T00:00:00.500Z"));
});

test("a date without a time is not an RFC 3339 timestamp", () => {
    const resolution = resolve({ expiresAt: "2026-09-10" });
    assert.equal(resolution.mode, null);
    assert.deepEqual(codes(resolution), ["expiry_not_rfc3339"]);
});

test("prose and impossible dates are refused, not swallowed by Date", () => {
    for (const value of ["next tuesday", "2026", "2026-13-01T00:00:00Z", "soon", ""]) {
        assert.equal(parseRfc3339(value), null, value);
    }
});

/* -------------------------------------------------- what a reader does */

test("legacy_fallback reads NULL as review, and says it is not a defect", () => {
    assert.deepEqual(readProductKey(null, "legacy_fallback"), {
        productKey: "review",
        defect: false,
    });
});

test("strict reads NULL as a defect and refuses to guess", () => {
    assert.deepEqual(readProductKey(null, "strict"), {
        productKey: null,
        defect: true,
    });
});

test("a stored product is returned unchanged in both modes", () => {
    for (const mode of ["legacy_fallback", "strict"]) {
        assert.deepEqual(readProductKey("studio", mode), {
            productKey: "studio",
            defect: false,
        });
    }
});
