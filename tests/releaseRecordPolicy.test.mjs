import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
    RELEASE_CHECKLIST_TEMPLATE,
    headerFields,
    isPlaceholderOwner,
    releaseRecordProblems,
    releaseTemplateProblems,
    waiverRows,
} from "../scripts/release-record-policy.mjs";

/**
 * The release checklist had no enforcement at all, and the gap was not
 * theoretical: the 2026-08-15 run reached a signed state with its build
 * unnamed, two finished items still listed as outstanding risks, and two
 * owner cells reading `(이름)`. Every rule below is one of those.
 */

const TEMPLATE = readFileSync(RELEASE_CHECKLIST_TEMPLATE, "utf8");

const RECORD = `# Release checklist

\`\`\`
Release SHA:        851598eb8957342bc66d742596692961dbaec03f
Staging deployment: 63792fcd554ed93dd65a534cf05c26e05e306a06
Date / timezone:    2026-08-15 / AEST
\`\`\`

## 1. Automated gates

- [x] \`npm ci\`
- [ ] \`npm audit\`

## 8. Unverified items and waivers

| Item | Why not verified | Owner | Command / evidence needed |
| --- | --- | --- | --- |
| §4 접근성 | 미실행 | @mposition | 매트릭스 행 기입 |

### Carried forward from the 2026-08 go-live review

| Item | Why not verified | Owner | Command / evidence needed |
| --- | --- | --- | --- |
| §2 Nightly Visual Regression | cannot dispatch from here | Release manager | run URL |
`;

const withRecord = (edit) => releaseRecordProblems(
    "release-2026-08-15__851598eb.md",
    edit(RECORD)
);

test("the shipped template and record satisfy the policy", () => {
    // Guards the rules against being written to fit a fixture. If a rule here
    // cannot be met by the real documents, it is the rule that is wrong.
    assert.deepEqual(releaseTemplateProblems(TEMPLATE), []);
    assert.deepEqual(withRecord((text) => text), []);
});

test("a run typed into the template is refused three ways", () => {
    // The whole failure, in the order it would actually happen: someone opens
    // the checklist, fills in the header, and starts ticking.
    const filled = TEMPLATE.replace(
        "Release SHA:        ____________________",
        "Release SHA:        851598eb8957342bc66d742596692961dbaec03f"
    ).replace("- [ ] `npm ci`", "- [x] `npm ci`");

    const problems = releaseTemplateProblems(filled).join("\n");
    assert.match(problems, /a ticked box in the template/);
    assert.match(problems, /names the build 851598eb/);
    assert.match(problems, /"Release SHA" filled in/);
});

test("a record must name a complete build SHA", () => {
    // The state the 2026-08-15 record was actually committed in: everything
    // else filled, the one line that says which build it covers left blank.
    assert.match(
        withRecord((text) =>
            text.replace(
                /Release SHA:        [0-9a-f]{40}/,
                "Release SHA:        ____________________"
            )
        ).join("\n"),
        /leaves Release SHA blank/
    );

    assert.match(
        withRecord((text) =>
            text.replace(/Release SHA:        [0-9a-f]{40}/, "Release SHA:        851598eb")
        ).join("\n"),
        /not a full 40-character SHA/
    );
});

test("a blank copy of the template is not a record", () => {
    const problems = releaseRecordProblems(
        "release-2026-08-15__851598eb.md",
        TEMPLATE,
        { templateText: TEMPLATE }
    );
    assert.match(problems.join("\n"), /byte-identical to the template/);

    // And the near-miss: not identical, because someone wrote a date in it,
    // but still nothing recorded.
    assert.match(
        withRecord((text) => text.replace("- [x] `npm ci`", "- [ ] `npm ci`")).join("\n"),
        /no ticked box at all/
    );
});

test("unticked boxes need section 8, and section 8 needs a name", () => {
    // The pair that makes an unticked box legible. Either half alone is the
    // silent skip the checklist's own wording refuses.
    assert.match(
        withRecord((text) => text.slice(0, text.indexOf("## 8."))).join("\n"),
        /leaves 1 box\(es\) unticked and section 8 empty/
    );

    assert.match(
        withRecord((text) => text.replace("| @mposition |", "| (이름) |")).join("\n"),
        /owner is "\(이름\)", which names nobody/
    );
});

test("the carried-forward list does not count as this release's decisions", () => {
    // It is copied from the template and names roles, not people. Counting it
    // would let a record satisfy section 8 without anyone deciding anything.
    const rows = waiverRows(RECORD);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /§4 접근성/);
    assert.ok(!rows.some((row) => row.includes("Nightly Visual Regression")));
});

test("placeholder owners are recognised in either language", () => {
    for (const value of ["(이름)", " 이름 ", "TBD", "todo", "____", "-", "", "<owner>"]) {
        assert.ok(isPlaceholderOwner(value), `${JSON.stringify(value)} names nobody`);
    }
    for (const value of ["@mposition", "Release manager", "finance-ops"]) {
        assert.ok(!isPlaceholderOwner(value), `${JSON.stringify(value)} is a name`);
    }
});

test("header fields are read by name, not by position", () => {
    const fields = headerFields(
        "Date / timezone:    2026-08-15 / AEST\nRelease SHA:        abc\n"
    );
    assert.equal(fields.get("Release SHA"), "abc");
    assert.equal(fields.get("Date / timezone"), "2026-08-15 / AEST");
});

test("a record filename says which run it is", () => {
    assert.match(
        releaseRecordProblems("2026-08-15-release.md", RECORD).join("\n"),
        /not named release-YYYY-MM-DD__<sha>\.md/
    );
    // A short SHA is accepted in the filename on purpose: renaming a committed
    // record splits its history, so the field that must be right is the one
    // inside the file.
    assert.deepEqual(
        releaseRecordProblems("release-2026-08-15__9424a4b.md", RECORD),
        []
    );
});
