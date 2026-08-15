import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    checklistItems,
    renderItemTable,
    renderRecord,
    sectionLetter,
} from "../scripts/staging-verification-record-core.mjs";

/**
 * Generating a run record from the checklist.
 *
 * The record used to be a table inside the checklist, which is how a signed
 * `통과` came to sit above 54 empty boxes. Splitting them fixed that and left
 * a smaller version: the blank record said "copy A–G" for eight days after
 * section H arrived. A hand-copied item list drifts the same way one row at a
 * time, and a missing row reads exactly like a section nobody ran — so the
 * list is read from the checklist instead.
 *
 * These are the properties that has to hold.
 */

const CHECKLIST = "docs/ops/external-import-staging-checklist.md";
const TEMPLATE = "docs/ops/staging-verification-records/_record-template.md";

const SAMPLE = [
    "# Title",
    "",
    "## 사전 조건",
    "",
    "- [ ] staging에 배포되어 있다.",
    "",
    "## A. Fail-closed",
    "",
    "- [ ] `GET /api/x`가 403을 반환한다.",
    "- [ ] 두 번째 항목인데 줄이 넘어가서",
    "      이렇게 이어진다.",
    "",
    "## C. 한도",
    "",
    "### C2. Seal",
    "",
    "- [ ] seal을 다시 부르면 200이다.",
    "",
    "  > 인용문은 항목이 아니다.",
    "",
].join("\n");

/* ------------------------------------------------------- reading items */

test("every checklist item becomes exactly one item", () => {
    const items = checklistItems(SAMPLE);
    assert.equal(items.length, 4);
});

test("a wrapped item stays one item", () => {
    // Four lines of one requirement is still one thing to judge. Four rows
    // would be four judgements nobody made.
    const wrapped = checklistItems(SAMPLE).find((item) =>
        item.text.startsWith("두 번째")
    );
    assert.equal(wrapped.text, "두 번째 항목인데 줄이 넘어가서 이렇게 이어진다.");
});

test("a block quote is not an item", () => {
    assert.equal(
        checklistItems(SAMPLE).some((item) => item.text.includes("인용문")),
        false
    );
});

test("items carry their section and sub-section", () => {
    const sealed = checklistItems(SAMPLE).find((item) =>
        item.text.startsWith("seal")
    );
    assert.equal(sealed.section, "C. 한도");
    assert.equal(sealed.subsection, "C2. Seal");
});

test("the section letter is read from the heading", () => {
    assert.equal(sectionLetter("A. Fail-closed"), "A");
    assert.equal(sectionLetter("사전 조건"), null);
});

/* ------------------------------------------------------- the item table */

test("the table has one row per item and no result filled in", () => {
    const table = renderItemTable(checklistItems(SAMPLE));
    const itemRows = table.split("\n").filter((row) => row.startsWith("| |"));
    assert.equal(itemRows.length, 4);
    // Empty, not `미기록`. `미기록` is what a row *ends* as when it was not
    // run; writing it now would record an outcome before the run.
    for (const row of itemRows) {
        assert.match(row, /\|\s*\|\s*$/);
        assert.equal(row.includes("미기록"), false);
    }
});

test("a pipe inside an item cannot break the table", () => {
    const table = renderItemTable([
        { section: "A. X", subsection: null, text: "a | b" },
    ]);
    assert.match(table, /a \\\| b/);
});

test("each group is announced once", () => {
    const table = renderItemTable(checklistItems(SAMPLE));
    const groups = table.split("\n").filter((row) => row.startsWith("| **"));
    assert.deepEqual(groups.length, 3);
});

/* ------------------------------------------------- the rendered record */

test("the record carries the SHA in full and the revision it ran", () => {
    const sha = "a".repeat(40);
    const record = renderRecord({
        template: readFileSync(TEMPLATE, "utf8"),
        items: checklistItems(SAMPLE),
        date: "2026-08-14",
        deploySha: sha,
        revision: "2026-08-14b",
    });
    assert.match(record, new RegExp(`deploySha: ${sha}`));
    assert.match(record, new RegExp(`\\| 배포 SHA \\(전체 40자리\\) \\| \`${sha}\` \\|`));
    assert.match(record, /templateRevision: 2026-08-14b/);
    assert.match(record, /\| template revision \| 2026-08-14b \|/);
});

test("the record leaves every human decision blank", () => {
    const record = renderRecord({
        template: readFileSync(TEMPLATE, "utf8"),
        items: checklistItems(SAMPLE),
        date: "2026-08-14",
        deploySha: "b".repeat(40),
        revision: "2026-08-14b",
    });
    for (const field of ["executor", "approver", "result", "digest", "startedAtUtc"]) {
        assert.match(record, new RegExp(`^${field}:\\s*$`, "m"), field);
    }
    assert.match(record, /^frozen: false$/m);
});

/* ------------------------------------------- against the real checklist */

test("the real checklist yields an item for every section it has", () => {
    const checklist = readFileSync(CHECKLIST, "utf8");
    const letters = [...checklist.matchAll(/^##\s+([A-Z])\.\s/gm)].map((m) => m[1]);
    const covered = new Set(
        checklistItems(checklist)
            .map((item) => sectionLetter(item.section))
            .filter(Boolean)
    );
    assert.ok(letters.length > 0);
    for (const letter of letters) {
        assert.ok(covered.has(letter), `section ${letter} produced no item`);
    }
});

test("the record separates the SHA it verified from the SHA the items came from", () => {
    // Routinely different, and that is the design: the checklist's history
    // stays on one branch while the verified build is an activation candidate
    // that may have reached production another way. A reader who finds items
    // in the record that are absent from the deployed tree has nothing else to
    // tell that intended split from a mistake.
    const record = renderRecord({
        template: readFileSync(TEMPLATE, "utf8"),
        items: checklistItems(SAMPLE),
        date: "2026-08-15",
        deploySha: "c".repeat(40),
        revision: "2026-08-15c",
        checklistSourceSha: "d".repeat(40),
    });
    assert.match(record, new RegExp(`^checklistSourceSha: ${"d".repeat(40)}$`, "m"));
    assert.match(
        record,
        new RegExp(`\\| \\*\\*checklist source SHA\\*\\* \\| \`${"d".repeat(40)}\` \\|`)
    );
    // And the two are not confused for one another.
    assert.match(record, new RegExp(`^deploySha: ${"c".repeat(40)}$`, "m"));
});

test("an unknown checklist source is left blank rather than guessed", () => {
    // The generator passes nothing when it is not in a checkout. A blank says
    // "not known"; a SHA invented here would say something false about which
    // items were run.
    const record = renderRecord({
        template: readFileSync(TEMPLATE, "utf8"),
        items: checklistItems(SAMPLE),
        date: "2026-08-15",
        deploySha: "c".repeat(40),
        revision: "2026-08-15c",
    });
    assert.match(record, /^checklistSourceSha:\s*$/m);
});
