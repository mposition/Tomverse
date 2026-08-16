import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
    RELEASE_CHECKLIST_TEMPLATE,
    headerFields,
    isPlaceholderOwner,
    releaseDeviationProblems,
    releaseHandoffProblems,
    RELEASE_HANDOFF_NAME,
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

test("a deviation is a second kind of document, checked for different things", () => {
    // A record says a checklist was run against a build. A deviation says
    // production is serving a build no checklist covers. Demanding ticked
    // boxes of the second would be asking it to claim the thing it exists to
    // deny -- but it is matched, not ignored, because a pattern that skipped
    // anything unlike a record would also skip a record somebody misnamed.
    const good = `# Release deviation

| SHA production serves | \`b0cf10e761053fd5f00c3cd6064edc41925e1898\` |
| Rollback SHA | 851598eb8957342bc66d742596692961dbaec03f |
`;
    assert.deepEqual(
        releaseDeviationProblems("release-deviation-2026-08-15__b0cf10e.md", good),
        []
    );

    // The two things it cannot omit: which build is live, and what to go back
    // to. A deviation that names neither describes a gap without locating it.
    assert.match(
        releaseDeviationProblems("release-deviation-2026-08-15__b0cf10e.md", "# Nothing here\nRollback: none named yet\n").join("\n"),
        /names no full 40-character SHA/
    );
    assert.match(
        releaseDeviationProblems(
            "release-deviation-2026-08-15__b0cf10e.md",
            "# x\nb0cf10e761053fd5f00c3cd6064edc41925e1898\n"
        ).join("\n"),
        /names no rollback target/
    );
});

test("the shipped deviation record satisfies its own rules", () => {
    const name = "release-deviation-2026-08-15__b0cf10e.md";
    assert.deepEqual(
        releaseDeviationProblems(
            name,
            readFileSync(`.github/audits/${name}`, "utf8")
        ),
        []
    );
    // And it is still refused as a *record*, which is what makes the split
    // meaningful rather than a way of exempting a file from checking.
    assert.ok(releaseRecordProblems(name, "x").length > 0);
});

test("a handoff is a third kind, recognised by a name that has no SHA slot", () => {
    // `release-` is a reserved namespace in .github/audits/, so a document
    // about release work that is neither a run nor a deviation was being told
    // to rename itself to something that hid its subject. It is recognised
    // instead -- and only by a shape a record can never take, since a record's
    // name is date-then-SHA and this one ends at the date.
    assert.equal(
        RELEASE_HANDOFF_NAME.test("release-verification-handoff-2026-08-15.md"),
        true
    );
    assert.equal(
        RELEASE_HANDOFF_NAME.test("release-2026-08-15__9424a4bd.md"),
        false
    );
    assert.equal(
        RELEASE_HANDOFF_NAME.test("release-deviation-2026-08-15__b0cf10e.md"),
        false
    );
    // A misnamed record must still be caught by the record rule rather than
    // slipping through as a handoff.
    assert.equal(RELEASE_HANDOFF_NAME.test("release-handoff.md"), false);
});

test("a handoff must name the build the state it describes was measured against", () => {
    const sha = "5528317e19fb8f061f18a9fde98f68c9fecd6013";
    assert.deepEqual(
        releaseHandoffProblems(
            "release-verification-handoff-2026-08-15.md",
            `# Handoff\n\nproduction ${sha}\n`
        ),
        []
    );
    assert.match(
        releaseHandoffProblems(
            "release-verification-handoff-2026-08-15.md",
            "# Handoff\n\nEverything is fine.\n"
        ).join("\n"),
        /names no full 40-character SHA/
    );
    // A short SHA is not a build identifier: it is the prefix of one.
    assert.match(
        releaseHandoffProblems(
            "release-verification-handoff-2026-08-15.md",
            "# Handoff\n\nproduction 5528317\n"
        ).join("\n"),
        /names no full 40-character SHA/
    );
});
