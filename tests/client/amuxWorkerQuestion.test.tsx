import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { runDmJudgment } from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
import { AmuxTaskQuestionSection, AmuxWorkerQuestionBox, amuxWorkerQuestionDmConfirmBody,
  amuxWorkerQuestionDmFrom, readAmuxTaskQuestion, sendAmuxWorkerAnswer,
  type AmuxWorkerQuestion } from "@/components/admin/AmuxWorkerQuestion";
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
  { kind: "question", question: question(), decisionMaker: null });
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

const SHOWN = {
  answerDigest: null, rationaleDigest: "3".repeat(64), optionId: "b", irreversible: false,
  snapshotState: "none" as const, snapshotTargetSha: null, snapshotManifestDigest: null,
};
const REQUEST_ID = "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b";
const proposal = (irreversible = false) => ({
  state: "proposal" as const, requestId: REQUEST_ID, answer: null, optionId: "b",
  rationale: "The verified entry is the one the router already reads.", irreversible,
  snapshot: { state: "none" as const, targetSha: null, paths: ["lib/amux/fileRetry.ts"] },
  shown: { ...SHOWN, irreversible },
});
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a Decision Maker proposal shows its answer, why, one confirm button and the direct answer as the other way", () => {
  for (const locale of ["en", "ko"] as const) {
    const m = adminAmuxCardsMessages[locale];
    assert.ok(m.dmConfirm && m.dmProposal && m.dmRationale && m.dmDirect && m.dmOpenDetail && m.dmConfirmed);
  }
  const m = adminAmuxCardsMessages.en;
  const html = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()}
    decisionMaker={proposal()} />);
  assert.match(html, /data-testid="amux-worker-question-dm" data-dm-state="proposal"/);
  assert.ok(html.includes(m.dmProposal));
  // A select proposal names its option with the question's own label.
  assert.ok(html.includes("b: Use the verified entry"));
  assert.ok(html.includes("The verified entry is the one the router already reads."));
  assert.match(html, /data-testid="amux-worker-question-dm-confirm"[^>]*>Confirm as proposed</);
  assert.ok(html.includes(`href="/admin/amux-execution?dmRequest=${REQUEST_ID}"`));
  assert.doesNotMatch(html, /amux-worker-question-dm-irreversible/);
  // Answering directly stays, as the alternative.
  assert.ok(html.includes(m.dmDirect));
  assert.match(html, /<textarea/);
  const marked = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()}
    decisionMaker={proposal(true)} />);
  assert.match(marked, /data-testid="amux-worker-question-dm-irreversible"/);
});

test("before the confirm button the card shows the snapshot the Decision Maker read, or says card only", () => {
  for (const locale of ["en", "ko"] as const) {
    const m = adminAmuxCardsMessages[locale];
    assert.ok(m.dmSnapshot && m.dmCardOnly && m.dmSnapshotPaths && m.dmSnapshotAt("develop", SHA).includes(SHA));
  }
  const m = adminAmuxCardsMessages.en;
  const cardOnly = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()}
    decisionMaker={proposal()} />);
  assert.ok(cardOnly.includes(m.dmCardOnly));
  assert.doesNotMatch(cardOnly, /amux-worker-question-dm-snapshot-paths/);
  assert.ok(cardOnly.indexOf("amux-worker-question-dm-snapshot") < cardOnly.indexOf("amux-worker-question-dm-confirm"));
  const atHead = { ...proposal(), snapshot: { state: "worker_head" as const, targetSha: SHA,
    paths: ["lib/amux/fileRetry.ts", "lib/amux/retryModel.ts"] } };
  const html = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()}
    decisionMaker={atHead} />);
  assert.ok(html.includes(m.dmSnapshotAt("worker_head", SHA)));
  assert.ok(html.includes(
    `data-testid="amux-worker-question-dm-snapshot-paths"><li>lib/amux/fileRetry.ts</li><li>lib/amux/retryModel.ts</li>`));
  assert.ok(html.indexOf("amux-worker-question-dm-snapshot-paths") < html.indexOf("amux-worker-question-dm-confirm"));
});

test("without a proposal the card says in one line why, offers no confirm, and keeps the answer form", () => {
  const ko = adminAmuxCardsMessages.ko;
  const cases = [
    [{ state: "not_sent", reason: "waiting_relay" }, "DM에 아직 전달되지 않았어요"],
    [{ state: "not_sent", reason: "routing_off" }, "TOMVERSE_AMUX_DM_ROUTING"],
    [{ state: "cannot_answer", requestId: REQUEST_ID, reason: "제품 방향 결정이 필요합니다." }, "DM이 답할 수 없다고 했어요: 제품 방향 결정이 필요합니다."],
    [{ state: "with_operator", requestId: REQUEST_ID, reasons: ["irreversible_term"] }, ko.dmReasons.irreversible_term],
  ] as const;
  for (const [dm, words] of cases) {
    const line = ko.dmState(dm as never, (code) => ko.dmReasons[code] ?? code);
    assert.ok(line.includes(words), line);
    const html = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question()}
      decisionMaker={dm as never} />);
    assert.match(html, new RegExp(`data-dm-state="${dm.state}"`));
    assert.doesNotMatch(html, /amux-worker-question-dm-confirm/);
    assert.match(html, /<textarea/);
  }
  // An answered question shows no Decision Maker part: nothing is left to confirm.
  const answered = renderToStaticMarkup(<AmuxWorkerQuestionBox taskId={TASK_ID} question={question("answered")}
    decisionMaker={proposal()} />);
  assert.doesNotMatch(answered, /amux-worker-question-dm/);
});

test("confirm as proposed is the judgment route's confirmation on the values shown, sent once", async () => {
  const body = amuxWorkerQuestionDmConfirmBody(proposal());
  assert.deepEqual(body, { requestId: REQUEST_ID, kind: "confirm", shown: SHOWN, accuracy: { accuracy: "not_judged" } });
  const posted: unknown[] = [];
  const states: string[] = [];
  await runDmJudgment(body, {
    post: async (sent) => { posted.push(sent); return json(200, { recorded: true, kind: "confirm" }); },
    failureOf: async () => ({ message: "x" }) as never,
  }, (changes) => { if (changes.state) states.push(changes.state.phase); });
  assert.equal(posted.length, 1);
  assert.deepEqual(states, ["sending", "recorded"]);
});

test("reading a question carries its Decision Maker state; a proposal missing what a confirmation names is unreadable", async () => {
  const available = (body: unknown) => async () => json(200, body);
  const read = await readAmuxTaskQuestion(TASK_ID, available({
    result: { state: "available", text: "done" }, question: question(), decisionMaker: proposal() }));
  assert.deepEqual(read, { kind: "question", question: question(), decisionMaker: proposal() });
  assert.deepEqual(amuxWorkerQuestionDmFrom({ decisionMaker: { state: "proposal", requestId: REQUEST_ID } }),
    { state: "unavailable" });
  const withoutSnapshot: Record<string, unknown> = { ...proposal() };
  delete withoutSnapshot.snapshot;
  assert.deepEqual(amuxWorkerQuestionDmFrom({ decisionMaker: withoutSnapshot }), { state: "unavailable" });
  assert.equal(amuxWorkerQuestionDmFrom({ decisionMaker: { state: "auto_applied" } }), null);
  assert.equal(amuxWorkerQuestionDmFrom({ decisionMaker: null }), null);
  assert.deepEqual(amuxWorkerQuestionDmFrom({ decisionMaker: { state: "filed" } }), { state: "filed" });
});
