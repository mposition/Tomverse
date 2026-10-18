import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AmuxCardIdentity, AmuxSourceKeySuffix, amuxCardLabel, amuxDistinctSourceKey } from
  "@/components/admin/AmuxCardIdentity";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";

const TASK_ID = "c48886b9-1111-4222-8333-444455556666";
const ORIGIN_REF = "16B56903-aaaa-4bbb-8ccc-ddddeeeeffff";

for (const locale of ["en", "ko"] as const) {
  const m = adminAmuxExecutionMessages[locale];

  test(`${locale}: detail header leads with the Task ID and shows a differing source key as a labelled secondary line`, () => {
    const html = renderToStaticMarkup(<AmuxCardIdentity id={TASK_ID} sourceKey={ORIGIN_REF} revision={7}
      m={m} />);
    const taskLine = html.match(/<p data-testid="amux-detail-task-id">.*?<\/p>/)?.[0] ?? "";
    assert.ok(taskLine.includes(TASK_ID), "primary line carries the Task ID");
    assert.ok(taskLine.includes("· r7"), "revision stays next to the Task ID");
    assert.ok(taskLine.includes(m.taskId));
    assert.ok(!taskLine.includes(ORIGIN_REF), "primary line never carries the source key");
    const sourceLine = html.match(/<p class="text-xs opacity-70" data-testid="amux-detail-source-key">.*?<\/p>/)?.[0] ?? "";
    assert.ok(sourceLine.includes(ORIGIN_REF), "source key is kept on a secondary line");
    assert.ok(sourceLine.includes(m.sourceKey));
    assert.ok(html.indexOf(TASK_ID) < html.indexOf(ORIGIN_REF));
  });

  test(`${locale}: no secondary line when the source key is absent or equals the Task ID`, () => {
    for (const sourceKey of [null, TASK_ID, ""]) {
      const html = renderToStaticMarkup(<AmuxCardIdentity id={TASK_ID} sourceKey={sourceKey} revision={1}
        m={m} />);
      assert.ok(html.includes(TASK_ID));
      assert.ok(!html.includes("amux-detail-source-key"));
    }
  });
}

test("both locales define the new labels", () => {
  assert.equal(adminAmuxExecutionMessages.en.taskId, "Task ID");
  assert.equal(adminAmuxExecutionMessages.en.sourceKey, "Source key");
  assert.equal(adminAmuxExecutionMessages.ko.taskId, "Task ID");
  assert.equal(adminAmuxExecutionMessages.ko.sourceKey, "원본 키");
});

test("source key text goes through the same visibility escaping as the Task ID", () => {
  const html = renderToStaticMarkup(<AmuxCardIdentity id={TASK_ID} sourceKey={"key‮x"} revision={2}
    m={adminAmuxExecutionMessages.en} />);
  assert.ok(!html.includes("‮"));
  assert.match(html, /\\u\{202E\}/);
});

test("dependency list suffix shows the source key only when it differs", () => {
  assert.equal(amuxDistinctSourceKey(TASK_ID, ORIGIN_REF), ORIGIN_REF);
  assert.equal(amuxDistinctSourceKey(TASK_ID, TASK_ID), null);
  assert.equal(amuxDistinctSourceKey(TASK_ID, null), null);
  const shown = renderToStaticMarkup(<AmuxSourceKeySuffix id={TASK_ID} sourceKey={ORIGIN_REF} m={adminAmuxExecutionMessages.en} />);
  assert.ok(shown.includes(ORIGIN_REF) && shown.includes("Source key"));
  assert.equal(renderToStaticMarkup(<AmuxSourceKeySuffix id={TASK_ID} sourceKey={TASK_ID} m={adminAmuxExecutionMessages.en} />), "");
});

// docs/policy/amux-card-display-key.md §2-5: the number leads, the Task ID is next to it.
const CARD_NUMBER = "AMUX-GITHUB-001";

for (const locale of ["en", "ko"] as const) {
  const m = adminAmuxExecutionMessages[locale];

  test(`${locale}: a numbered card's header leads with the number, then the Task ID and revision`, () => {
    const html = renderToStaticMarkup(<AmuxCardIdentity id={TASK_ID} displayKey={CARD_NUMBER}
      sourceKey={ORIGIN_REF} revision={3} m={m} />);
    const numberLine = html.match(/<p class="font-semibold" data-testid="amux-detail-card-number">.*?<\/p>/)?.[0] ?? "";
    assert.ok(numberLine.includes(CARD_NUMBER));
    assert.ok(!numberLine.includes(TASK_ID), "the number line carries only the number");
    const taskLine = html.match(/<p data-testid="amux-detail-task-id">.*?<\/p>/)?.[0] ?? "";
    assert.ok(taskLine.includes(`${m.taskId}: ${TASK_ID}`) && taskLine.includes("· r3"));
    assert.ok(html.indexOf(CARD_NUMBER) < html.indexOf(TASK_ID) && html.indexOf(TASK_ID) < html.indexOf(ORIGIN_REF));
  });
}

test("an unnumbered card keeps the Task ID header and draws no number line", () => {
  const html = renderToStaticMarkup(<AmuxCardIdentity id={TASK_ID} displayKey={null} sourceKey={null}
    revision={1} m={adminAmuxExecutionMessages.en} />);
  assert.ok(!html.includes("amux-detail-card-number"));
  assert.ok(html.includes(`Task ID: ${TASK_ID}`));
});

test("lists name a card by its number, else its Task ID, and a numbered entry shows the Task ID beside it", () => {
  assert.equal(amuxCardLabel({ id: TASK_ID, displayKey: CARD_NUMBER }), CARD_NUMBER);
  assert.equal(amuxCardLabel({ id: TASK_ID, displayKey: null }), TASK_ID);
  assert.equal(amuxCardLabel({ id: TASK_ID }), TASK_ID);
  const numbered = renderToStaticMarkup(<AmuxSourceKeySuffix id={TASK_ID} displayKey={CARD_NUMBER}
    sourceKey={ORIGIN_REF} m={adminAmuxExecutionMessages.en} />);
  assert.ok(numbered.includes(`Task ID: ${TASK_ID}`));
  assert.ok(!numbered.includes(ORIGIN_REF), "the number replaces the source key as the extra identity");
});
