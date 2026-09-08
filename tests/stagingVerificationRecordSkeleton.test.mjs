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

// --- line endings, and titles that are not the staging one -----------------

test("a template checked out with CRLF renders the same record as one with LF", () => {
    // Windows checks these files out with CRLF, and every replacement in the
    // renderer anchors on "\n". The generator reported "25 item(s)" and wrote
    // a record with a single empty row -- which reads as a checklist that has
    // one item, not as a generator that matched nothing.
    const checklist = readFileSync(
        "docs/ops/mobile-auth-key-rotation-checklist.md",
        "utf8"
    );
    const template = readFileSync(
        "docs/ops/mobile-auth-key-rotation-verification-records/_record-template.md",
        "utf8"
    );
    const crlf = (text) => text.replace(/\n/g, "\r\n");
    const render = (checklistText, templateText) =>
        renderRecord({
            template: templateText,
            items: checklistItems(checklistText),
            date: "2026-09-03",
            deploySha: "a".repeat(40),
            revision: "2026-09-03a",
            checklistSourceSha: "b".repeat(40),
        });

    const fromLf = render(checklist, template);
    const fromCrlf = render(crlf(checklist), crlf(template));
    assert.equal(fromCrlf, fromLf);

    const rows = fromLf.split("\n").filter((line) => /^\| \| /.test(line));
    assert.equal(rows.length, checklistItems(checklist).length);
    assert.ok(rows.length > 1, "one row would mean the table anchor did not match");
});

test("a record's own title placeholders are filled, not shipped", () => {
    // The heading pattern is the staging one word for word, so a template with
    // a different title kept "<날짜> / <deploy SHA>" in the file somebody was
    // supposed to fill in.
    const rendered = renderRecord({
        template: [
            "---",
            "templateRevision:",
            "checklistSourceSha:",
            "deploySha:",
            "---",
            "",
            "# 모바일 인증 키 회전 실행 — <날짜> / <deploy SHA>",
            "",
            "| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |",
            "|---|---|---|---|---|",
            "| A | | | | |",
            "",
        ].join("\n"),
        items: [{ section: "A. 하나", subsection: null, text: "항목" }],
        date: "2026-09-03",
        deploySha: "c".repeat(40),
        revision: "2026-09-03a",
        checklistSourceSha: "d".repeat(40),
    });

    assert.match(rendered, /^# 모바일 인증 키 회전 실행 — 2026-09-03 \/ ccccccc$/m);
    assert.equal(/<날짜>|<deploy SHA>/.test(rendered), false);
});
