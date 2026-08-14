import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { recordDigest } from "../scripts/check-staging-verification-records.mjs";

/**
 * The split between the staging checklist and its run records.
 *
 * `npm run check:staging-verification-records` enforces it in CI. These are
 * the properties that split exists for, asserted against the real files
 * because the failure it prevents was about real files: a signed approval
 * table sitting in the checklist while every box above it was empty, going
 * stale as the release-A surface changed underneath it.
 */

const CHECKLIST = "docs/ops/external-import-staging-checklist.md";
const RECORDS = "docs/ops/staging-verification-records";
const LEGACY = `${RECORDS}/2026-08-04__8c43430b9febd905351e63de4af8b5bbc157f31a.md`;

const read = (path) => readFileSync(path, "utf8");

test("the checklist carries no ticked box", () => {
    // Its state is "these are the items". A tick here would be a result with
    // no run attached to it.
    const ticked = read(CHECKLIST)
        .split("\n")
        .filter((line) => /^\s*-\s*\[[^ \]]\]/.test(line));
    assert.deepEqual(ticked, []);
});

test("the checklist carries no approval table", () => {
    const source = read(CHECKLIST);
    assert.equal(/\|\s*검증 대상 커밋 SHA\s*\|/.test(source), false);
    assert.equal(/\|\s*승인자 서명\s*\|/.test(source), false);
});

test("the checklist declares a template revision", () => {
    // A record says which revision it ran, and that is only meaningful if the
    // template says which revision it is. A suffix is allowed after the date:
    // items can change twice in one day, and a bare date cannot tell those two
    // versions apart -- which is the whole job of the revision.
    assert.match(read(CHECKLIST), /template revision.*?`\d{4}-\d{2}-\d{2}[a-z]?`/s);
});

test("the blank record carries the checklist's current revision", () => {
    // This drift happened: a Gemini section H was added and the revision
    // bumped to `2026-08-14b`, while the blank record still declared
    // `2026-08-14`. A run started from it would have recorded a revision the
    // checklist no longer had, and nobody could tell an execution from before
    // the section was added from one after it.
    const declared = /template revision.*?`(\d{4}-\d{2}-\d{2}[a-z]?)`/s.exec(
        read(CHECKLIST)
    )?.[1];
    assert.ok(declared);
    const blank = read(`${RECORDS}/_record-template.md`);
    assert.match(blank, new RegExp(`templateRevision: ${declared}`));
    // And in the table the executor fills in, not only the front matter a
    // machine reads.
    assert.match(blank, new RegExp(`\\| template revision \\| ${declared} \\|`));
});

test("the blank record spans every section the checklist has", () => {
    // `A–G` while the checklist runs to H is an instruction to skip a section.
    const sections = [...read(CHECKLIST).matchAll(/^##\s+([A-Z])\.\s/gm)].map(
        (match) => match[1]
    );
    assert.ok(sections.length > 0);
    const span = `${sections[0]}–${sections[sections.length - 1]}`;
    assert.match(
        read(`${RECORDS}/_record-template.md`),
        new RegExp(`${span}\\s*구획`)
    );
});

test("every record is named for a day and a full deploy SHA", () => {
    const records = readdirSync(RECORDS).filter(
        (name) => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md"
    );
    assert.ok(records.length > 0);
    for (const name of records) {
        assert.match(name, /^\d{4}-\d{2}-\d{2}__[0-9a-f]{40}\.md$/);
    }
});

test("the legacy record keeps the original values and claims nothing more", () => {
    const source = read(LEGACY);
    // What the table actually said, verbatim.
    assert.match(source, /`8c43430`/);
    assert.match(source, /`@mposition`/);
    assert.match(source, /`통과`/);
    assert.match(source, /`TH`/);
    // And what it did not say.
    assert.match(source, /result: legacy_summary/);
    assert.match(source, /전 항목 `미기록`/);
});

test("the legacy record does not invent an ISO date", () => {
    // `04/08/2026` is ambiguous between two conventions, and the record says
    // so rather than picking one. The git timestamps beside it are context,
    // not a reading of the value.
    const source = read(LEGACY);
    assert.match(source, /`04\/08\/2026`/);
    assert.match(source, /미확인 — 사람 확인 필요/);
});

test("the legacy record does not tick anything", () => {
    // The whole point: an empty box from 2026-08-04 stays empty.
    const ticked = read(LEGACY)
        .split("\n")
        .filter((line) => /^\s*-\s*\[[^ \]]\]/.test(line));
    assert.deepEqual(ticked, []);
});

test("a frozen record's digest matches its body", () => {
    const source = read(LEGACY);
    const recorded = /^digest:\s*(\S+)$/m.exec(source)?.[1];
    assert.equal(recorded, recordDigest(source));
});

test("the digest covers the body, so editing it moves the digest", () => {
    const source = read(LEGACY);
    assert.notEqual(recordDigest(source), recordDigest(`${source}\nedited.\n`));
});

test("the digest ignores the front matter, so recording it is not circular", () => {
    // The digest lives in the front matter. If it covered itself, writing it
    // down would change it.
    const source = read(LEGACY);
    const rewritten = source.replace(/^digest:.*$/m, "digest: something-else");
    assert.equal(recordDigest(source), recordDigest(rewritten));
});
