import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { stagingVerificationFeature } from "../scripts/staging-verification-features.mjs";

/**
 * Section C of the assistant profile staging checklist: "a superseded pin
 * still answers with the old revision's instructions" (#880).
 *
 * Read off the answer's tone it could not be judged -- a run recorded it as
 * unobservable because neither revision's instruction was followed and the
 * two revisions carried nothing to tell them apart. The item now names a
 * marker per revision, so the first line of the answer decides it.
 */

const { checklist, records } = stagingVerificationFeature("assistant-profile");
const read = (path) => readFileSync(path, "utf8");

const sectionC = () => {
    const source = read(checklist);
    const start = source.search(/^## C\.\s/m);
    assert.ok(start >= 0, "section C exists");
    const rest = source.slice(start + 1);
    const end = rest.search(/^## [A-Z]\.\s/m);
    return end < 0 ? rest : rest.slice(0, end);
};

test("section C judges the old-revision answer by a per-revision marker", () => {
    const section = sectionC();
    const item = section
        .split(/\n(?=- \[ \])/)
        .find((entry) => entry.includes("옛 revision의 instructions"));
    assert.ok(item, "the old-revision item is still in section C");
    // Two distinct markers, one per revision, so the answer says which ran.
    const markers = new Set(item.match(/`\[REV-[^\]`]+\]`/g) ?? []);
    assert.ok(markers.size >= 2, `distinct revision markers in: ${item}`);
    // And each outcome has a verdict: kept, moved to latest, profile dropped.
    assert.ok((item.match(/pass/g) ?? []).length >= 1);
    assert.ok((item.match(/fail/g) ?? []).length >= 2);
});

test("the blank record follows the checklist's revision", () => {
    const declared = /template revision.*?`(\d{4}-\d{2}-\d{2}[a-z]?)`/s.exec(
        read(checklist)
    )?.[1];
    assert.ok(declared);
    const blank = read(`${records}/_record-template.md`);
    assert.match(blank, new RegExp(`templateRevision: ${declared}\\n`));
    assert.match(blank, new RegExp(`\\| template revision \\| ${declared} \\|`));
});
