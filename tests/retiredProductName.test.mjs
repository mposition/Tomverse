import { strict as assert } from "node:assert";
import test from "node:test";

import {
    allowlistEntryFor,
    CURRENT_PRODUCT_NAME,
    describeFindings,
    findRetiredProductName,
    HISTORICAL_ALLOWLIST,
    RETIRED_PRODUCT_NAME,
} from "../scripts/check-retired-product-name-core.mjs";

/**
 * The rename is held by an absence, so the only thing that can go wrong with
 * the check is what it counts. Two failure modes, and both are worse than no
 * check:
 *
 *   - too narrow, and the retired name lands in a locale nobody reads;
 *   - too broad, and the check fails an unrelated change with a naming error,
 *     which is how a gate gets switched off.
 *
 * `tests/pushScope.test.mjs` set the precedent: the false positives are pinned
 * as deliberately as the true ones.
 */

const find = (sources) => findRetiredProductName({ sources });

/* ----------------------------------------------------- true positives */

test("the retired name in live locale copy is a finding", () => {
    const findings = find([
        { path: "locales/en.ts", text: 'title: "Tomverse Insight",' },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "locales/en.ts");
    assert.equal(findings[0].line, 1);
    assert.equal(findings[0].matched, "Tomverse Insight");
});

test("the German hyphenated compound is a finding", () => {
    // de.ts carried `Tomverse-Insight-Familie`. A space-only search walks past
    // it, which is precisely the occurrence a bulk replace leaves behind.
    const findings = find([
        { path: "locales/de.ts", text: "Willkommen in der Tomverse-Insight-Familie." },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].matched, "Tomverse-Insight");
});

test("a non-breaking space between the two words is a finding", () => {
    const findings = find([{ path: "components/x.tsx", text: "Tomverse Insight" }]);
    assert.equal(findings.length, 1);
});

test("every occurrence is reported, not just the first per file", () => {
    const findings = find([
        {
            path: "lib/billingEmails.ts",
            text: ['title: "Tomverse Insight",', "", 'subject: "Tomverse Insight Pro",'].join("\n"),
        },
    ]);
    assert.equal(findings.length, 2);
    assert.deepEqual(
        findings.map((finding) => finding.line),
        [1, 3]
    );
});

test("two matches on one line are both reported", () => {
    // A global pattern with a shared lastIndex silently drops one of these.
    const findings = find([
        { path: "docs/policy/x.md", text: "Tomverse Insight and Tomverse Insight again" },
    ]);
    assert.equal(findings.length, 2);
});

/* ---------------------------------------------------- false positives */

test("the bare word Insight is not the brand", () => {
    // Cloudflare Browser Insights, a Prisma queryInsights() call, and the
    // decision record's own demotion of Insight to an output term all keep the
    // word in ordinary use.
    const findings = find([
        { path: "lib/csp.ts", text: "Cloudflare Browser Insights injects its beacon" },
        { path: "prisma/x.ts", text: "queryInsights()," },
        { path: "components/x.tsx", text: "Review Insight, 검토 결과" },
        { path: "docs/x.md", text: "insight into what the comparison found" },
    ]);
    assert.deepEqual(findings, []);
});

test("the current product name is not a finding", () => {
    const findings = find([
        { path: "locales/en.ts", text: `title: "${CURRENT_PRODUCT_NAME}",` },
    ]);
    assert.deepEqual(findings, []);
});

test("Tomverse on its own, and other Tomverse products, pass", () => {
    const findings = find([
        { path: "components/x.tsx", text: "Tomverse Chat, Tomverse Studio, Tomverse Code" },
        { path: "components/y.tsx", text: "from Tomverse" },
    ]);
    assert.deepEqual(findings, []);
});

test("the two words separated by more than one character are not the brand", () => {
    const findings = find([
        { path: "docs/x.md", text: "Tomverse, and the Insight it produces" },
    ]);
    assert.deepEqual(findings, []);
});

test("lower-case is not the brand, because the brand is a proper noun", () => {
    const findings = find([{ path: "docs/x.md", text: "tomverse insight" }]);
    assert.deepEqual(findings, []);
});

/* -------------------------------------------------------- allowlisting */

test("an audit record keeps the retired name", () => {
    const findings = find([
        {
            path: ".github/audits/final-stg-reaudit-2026-07-28.md",
            text: "Tomverse Insight was audited on 2026-07-28.",
        },
    ]);
    assert.deepEqual(findings, []);
});

test("approved release evidence keeps the retired name", () => {
    const findings = find([
        {
            path: "docs/release-gates/evidence/PACKAGE-01-2026-08-12.md",
            text: "Tomverse Insight, at commit abc1234.",
        },
    ]);
    assert.deepEqual(findings, []);
});

test("the staging verification record keeps the retired name", () => {
    const findings = find([
        {
            path: "docs/ops/email-sending-domains.md",
            text: "| From | `Tomverse Insight <hello@mail.tomverse.app>` | 통과 |",
        },
    ]);
    assert.deepEqual(findings, []);
});

test("allowlisting is by path prefix, so a sibling active file is still checked", () => {
    // docs/ops/ as a whole is live operational copy; only the named records
    // inside it are excused.
    const findings = find([
        { path: "docs/ops/tomverse-chat-auto-router-rollout.md", text: "Tomverse Insight" },
    ]);
    assert.equal(findings.length, 1);
});

test("the rename runbook may quote the name it retires", () => {
    const findings = find([
        {
            path: "docs/ops/tomverse-review-rename.md",
            text: '"formerly Tomverse Insight" 유지 기간',
        },
    ]);
    assert.deepEqual(findings, []);
});

test("every allowlist entry states a reason", () => {
    for (const entry of HISTORICAL_ALLOWLIST) {
        assert.equal(typeof entry.prefix, "string");
        assert.ok(entry.prefix.length > 0, "prefix is not empty");
        assert.ok(
            typeof entry.reason === "string" && entry.reason.length > 20,
            `${entry.prefix} states why it keeps the retired name`
        );
    }
});

test("allowlistEntryFor names which entry excused a path", () => {
    const entry = allowlistEntryFor(".github/audits/model-catalog-2026-08-01.md");
    assert.ok(entry);
    assert.equal(entry.prefix, ".github/audits/");
    assert.equal(allowlistEntryFor("locales/en.ts"), null);
});

/* ------------------------------------------------------------ reporting */

test("the report names the file, the line and the replacement", () => {
    const message = describeFindings(
        find([{ path: "locales/ko.ts", text: 'title: "Tomverse Insight",' }])
    );
    assert.match(message, /locales\/ko\.ts:1/);
    assert.match(message, new RegExp(RETIRED_PRODUCT_NAME));
    assert.match(message, new RegExp(CURRENT_PRODUCT_NAME));
    // A check whose failure does not say how to excuse a genuine record is a
    // check somebody deletes rather than extends.
    assert.match(message, /HISTORICAL_ALLOWLIST/);
});
