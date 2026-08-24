/**
 * The retired product name, and the records that are allowed to keep it.
 *
 * "Tomverse Insight" became "Tomverse Review" (product boundary decision
 * record v1.2, decision 1). A rename only holds if the old name stops
 * arriving, and the thing that lets it arrive again is not malice -- it is a
 * new locale key copied from an old one, a template pasted from an audit, a
 * doc written from memory.
 *
 * ## Two failure modes, and the second is the one that kills the check
 *
 * Too narrow, and the old name lands in a locale nobody reads in that
 * language. Too broad, and the check fails an unrelated change with a naming
 * error -- which is how a gate gets switched off. `tests/pushScope.test.mjs`
 * set the precedent this file follows: the false positives are pinned as
 * deliberately as the true ones.
 *
 * ## What is deliberately not matched
 *
 * `Insight` on its own. It is an ordinary English word and a third-party
 * product name -- Cloudflare Browser Insights, a Prisma `queryInsights()`
 * call, "the four capabilities that make ... mean something" -- and a check
 * that failed on it would be reporting the language rather than the brand.
 * The decision record is explicit that Insight is not discarded but demoted to
 * an output term ("Review Insight", "검토 결과"), so the word must stay usable.
 * Only the two-word brand is the retired name.
 *
 * ## Why the allowlist is paths, not strings
 *
 * An audit written in July recorded what the product was called in July.
 * Rewriting it would make the record claim a name that did not exist when the
 * finding was raised, and `check:release-records` and
 * `check:staging-verification-records` would be right to fail it. The
 * allowlist is therefore a list of places where the old name is the correct
 * content, and every entry says why.
 */

/** The retired brand. Case-sensitive: this is a proper noun, not a word. */
export const RETIRED_PRODUCT_NAME = "Tomverse Insight";

/** What replaced it. */
export const CURRENT_PRODUCT_NAME = "Tomverse Review";

/**
 * `Tomverse` and `Insight` joined by any single separator a writer might use.
 *
 * The space is the ordinary case. The hyphen is not hypothetical: de.ts
 * carried `Tomverse-Insight-Familie`, a German compound that a
 * space-only search walks straight past -- which is exactly the occurrence a
 * bulk replace would have left behind. The non-breaking space is here for the
 * same reason, since it survives a copy out of a rendered page.
 */
export const RETIRED_PRODUCT_NAME_PATTERN = /Tomverse[  ‑-]Insight/g;

/**
 * Where the retired name is the record rather than a regression.
 *
 * Each entry is a path prefix (a directory, or an exact file) and the reason
 * it keeps the old name. A prefix rather than a glob because the reason
 * applies to everything underneath: an audit directory does not acquire
 * live product copy.
 */
export const HISTORICAL_ALLOWLIST = [
    {
        prefix: ".github/audits/",
        reason:
            "Audit reports name the product as it was called when the finding was raised. Rewriting them would date the finding to a name that did not exist yet.",
    },
    {
        prefix: "docs/release-gates/evidence/",
        reason:
            "Approved release evidence is immutable: check:release-records verifies commit SHAs and CI run URLs against what was signed off.",
    },
    {
        prefix: "docs/ops/email-sending-domains.md",
        reason:
            "Sections 3.5.1 and 3.5.4 are staging verification records -- headers a recipient actually judged, not settings we can restate. check:staging-verification-records reads them. The pending production display-name change is tracked in docs/ops/tomverse-review-rename.md instead.",
    },
    {
        prefix: "docs/ops/product-boundary-v1-2-staging-checklist.md",
        reason:
            "The staging checklist for the rename. It has to quote the retired name three times to be usable: the Search Console query to look up, what the pending \"formerly\" copy would read, and the string a verifier confirms is absent from the welcome email.",
    },
    {
        prefix: "docs/ops/tomverse-review-rename.md",
        reason:
            "The rename runbook itself. It has to quote the retired name to say what was replaced, what the pending \"formerly Tomverse Insight\" copy would read, and what the one-time user notice says.",
    },
    {
        prefix: "scripts/check-retired-product-name-core.mjs",
        reason:
            "This file. A check for a forbidden string has to name the string, and its allowlist has to name the historical filenames that contain it.",
    },
    {
        prefix: "scripts/check-retired-product-name.mjs",
        reason: "The runner, for the same reason as the core it calls.",
    },
    {
        prefix: "tests/retiredProductName.test.mjs",
        reason:
            "The false-positive and true-positive fixtures. A test that could not write the retired name could not prove the check catches it.",
    },
    {
        prefix: "scripts/check-policy-section-references.mjs",
        reason:
            "Refers to the UX audit reports by filename. The filenames are the historical record's own identity and renaming them would break every citation that points at them.",
    },
    {
        prefix: "FINAL_REMEDIATION_REPORT_KO.md",
        reason: "Completed remediation report, dated to the name in use at the time.",
    },
    {
        prefix: "Tomverse-Insight-UX-Audit-Final-Report.md",
        reason: "Completed UX audit report. Its own filename is part of the record.",
    },
    {
        prefix: "Tomverse-Insight-UX-Audit-Final-Work-Order.md",
        reason: "Completed UX audit work order.",
    },
    {
        prefix: "Tomverse-Insight-UX-Audit-Final-Work-Order-Amended.md",
        reason: "Completed UX audit work order, amended.",
    },
];

export const allowlistEntryFor = (path) =>
    HISTORICAL_ALLOWLIST.find((entry) => path === entry.prefix || path.startsWith(entry.prefix)) ??
    null;

/**
 * Every occurrence of the retired name outside the allowlist.
 *
 * `sources` is `{ path, text }`, already read by the caller, so this module
 * stays pure and the test can hand it strings.
 */
export const findRetiredProductName = ({ sources }) => {
    const findings = [];
    for (const { path, text } of sources) {
        if (allowlistEntryFor(path)) continue;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            // A fresh lastIndex per line: the pattern is global, and a shared
            // one would skip the first match on every second line.
            RETIRED_PRODUCT_NAME_PATTERN.lastIndex = 0;
            for (const match of line.matchAll(RETIRED_PRODUCT_NAME_PATTERN)) {
                findings.push({
                    path,
                    line: index + 1,
                    matched: match[0],
                    excerpt: line.trim().slice(0, 160),
                });
            }
        }
    }
    return findings;
};

export const describeFindings = (findings) =>
    [
        `${findings.length} occurrence(s) of the retired product name "${RETIRED_PRODUCT_NAME}" ` +
            `on an active surface. Use "${CURRENT_PRODUCT_NAME}".`,
        "",
        ...findings.map(
            (finding) => `  ${finding.path}:${finding.line}  ${finding.matched}  ${finding.excerpt}`
        ),
        "",
        "If this file is a historical record rather than live copy, add it to",
        "HISTORICAL_ALLOWLIST in scripts/check-retired-product-name-core.mjs with a reason.",
    ].join("\n");
