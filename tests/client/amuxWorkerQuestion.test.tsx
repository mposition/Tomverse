import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxTaskQuestionSection, AmuxWorkerQuestionBox, readAmuxTaskQuestion,
  sendAmuxWorkerAnswer, type AmuxWorkerQuestion } from "@/components/admin/AmuxWorkerQuestion";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";

const TASK_ID = "78004fd4-63c6-47cf-9900-a9e28497f548";
const question = (state = "open"): AmuxWorkerQuestion => ({
  id: "question-1", sequence: 1, state,
  question: "Which registry entry should the generated file use?",
  unblocks: "Registering the generated file tool",
  options: [{ id: "a", label: "Keep gpt-6-luna" }, { id: "b", label: "Use the verified entry" }],
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" } });

test("an open question shows its text, options, what it unblocks and the answer form", () => {
  const m = adminAmuxCardsMessages.en;
  const html = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()} />);
  assert.match(html, /data-testid="amux-worker-question"/);
  assert.ok(html.includes(m.questionTitle(1)));
  assert.ok(html.includes(m.questionState("open")));
  assert.ok(html.includes("Which registry entry should the generated file use?"));
  assert.ok(html.includes(`${m.questionUnblocks}: Registering the generated file tool`));
  assert.ok(html.includes("Keep gpt-6-luna") && html.includes("Use the verified entry"));
  assert.match(html, /<textarea[^>]*maxLength="8000"/);
  assert.ok(html.includes(m.answerSubmit));
});

test("an answered question keeps its text but offers no second answer", () => {
  const m = adminAmuxCardsMessages.en;
  const html = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question("answered")} />);
  assert.ok(html.includes(m.questionState("answered")));
  assert.ok(!html.includes("<textarea"));
});

test("sending an answer posts the existing route body and reports the outcome", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ok = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(200, { ok: true }); };
  assert.equal(await sendAmuxWorkerAnswer({ taskId: TASK_ID, questionId: "question-1", answer: "b" }, ok), "sent");
  assert.equal(calls[0].url, "/api/admin/amux/v22-owner-question");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)),
    { taskId: TASK_ID, questionId: "question-1", answer: "b" });
  assert.deepEqual(await sendAmuxWorkerAnswer({ taskId: TASK_ID, questionId: "q", answer: "b" },
    async () => json(409, { error: "QUESTION_NOT_OPEN" })), { failed: "QUESTION_NOT_OPEN" });
  assert.deepEqual(await sendAmuxWorkerAnswer({ taskId: TASK_ID, questionId: "q", answer: "b" },
    async () => json(404, null)), { failed: "404" });
  assert.deepEqual(await sendAmuxWorkerAnswer({ taskId: TASK_ID, questionId: "q", answer: "b" },
    async () => { throw new Error("offline"); }), { failed: "network" });
});

test("reading a Task's question tells a question apart from none, missing, purged and unavailable", async () => {
  let url = "";
  const available = (body: unknown) => async (input: string) => { url = input; return json(200, body); };
  assert.deepEqual(await readAmuxTaskQuestion(TASK_ID, available({
    result: { state: "available", text: "done" }, question: question() })),
  { kind: "question", question: question() });
  assert.equal(url, `/api/admin/amux/v22-task-result?taskId=${TASK_ID}`);
  assert.deepEqual(await readAmuxTaskQuestion(TASK_ID, available({
    result: { state: "available", text: "done" }, question: null })), { kind: "none" });
  assert.deepEqual(await readAmuxTaskQuestion(TASK_ID, available({
    result: { state: "purged" }, question: null })), { kind: "purged" });
  assert.deepEqual(await readAmuxTaskQuestion(TASK_ID, async () => json(404, { error: "Not found." })),
    { kind: "missing" });
  assert.deepEqual(await readAmuxTaskQuestion(TASK_ID, async () => json(503, {})), { kind: "unavailable" });
});

test("the detail section reads nothing for a non-owner and says the question is owner-only", () => {
  for (const locale of ["en", "ko"] as const) {
    let reads = 0;
    const html = renderToStaticMarkup(<AmuxTaskQuestionSection taskId={TASK_ID} canAnswer={false}
      read={async () => { reads += 1; return { kind: "none" }; }} />);
    assert.equal(reads, 0);
    if (locale === "en") assert.ok(html.includes(adminAmuxCardsMessages.en.questionOwnerOnly));
    assert.ok(adminAmuxCardsMessages[locale].questionOwnerOnly.length > 0);
    assert.ok(adminAmuxExecutionMessages[locale].questionPending.length > 0);
  }
  assert.equal(adminAmuxExecutionMessages.ko.questionPending, "답변 대기 질문");
});

test("the card detail owns the one question component; the list and the board lane only open the card", () => {
  const panel = readFileSync("components/admin/AmuxCardListPanel.tsx", "utf8");
  const lane = readFileSync("components/admin/AmuxBoardAttentionLane.tsx", "utf8");
  const workspace = readFileSync("components/admin/AmuxExecutionWorkspace.tsx", "utf8");
  // The list view no longer answers questions itself: a row opens the card, where the answer form is.
  assert.doesNotMatch(panel, /AmuxWorkerQuestionBox|v22-owner-question|v22-task-result/);
  assert.match(workspace, /\{selected\.ownerQuestion && <AmuxTaskQuestionSection/);
  // A card with an open question still has its call to act on the board, which opens the card on its overview.
  assert.match(lane, /card\.ownerQuestion === "open" && <button/);
  assert.match(lane, /onOpen\(card\.id, true, event\.currentTarget\)/);
  assert.doesNotMatch(workspace, /v22-owner-question/);
});
