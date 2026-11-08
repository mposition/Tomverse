import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V22_OWNER_QUESTION_LIMIT,
  AMUX_V22_OWNER_QUESTION_MARKER,
  AMUX_V22_OWNER_QUESTION_RULES,
  AMUX_V22_RESUME_PROMPT_MAX_BYTES,
  amuxV22ResumeMinimumBytes,
  amuxV22OwnerQuestionSettlement,
  amuxV22OwnerQuestionSettlementPlan,
  amuxV22OwnerQuestionSha256,
  amuxV22QuestionDmCard,
  buildAmuxV22ResumeSection,
  normalizeAmuxV22OwnerAnswer,
  parseAmuxV22OwnerQuestion,
} from "../lib/amux/v22OwnerQuestionCore.ts";

const line = (value) => `${AMUX_V22_OWNER_QUESTION_MARKER} ${JSON.stringify(value)}`;
const asked = { question: "Should the starter lock copy name the plan?",
  unblocks: "the copy change", options: [{ id: "a", label: "Name it" },
    { id: "b", label: "Keep it generic" }] };

test("only a well-formed last line is an owner question", () => {
  assert.deepEqual(parseAmuxV22OwnerQuestion(
    `Changed two files.\n\n${line(asked)}\n\n`), asked);
  assert.deepEqual(parseAmuxV22OwnerQuestion(line({ ...asked, options: undefined })),
    { ...asked, options: [] });
  // Quoted earlier in the result, it is not the run's question.
  assert.equal(parseAmuxV22OwnerQuestion(`${line(asked)}\nDone.`), null);
  for (const bad of [
    `${AMUX_V22_OWNER_QUESTION_MARKER} not json`,
    line([asked]),
    line({ ...asked, question: " " }),
    line({ ...asked, unblocks: undefined }),
    line({ ...asked, question: "x".repeat(2_001) }),
    line({ ...asked, question: "bell\u0007" }),
    line({ ...asked, options: [{ id: "A", label: "upper" }] }),
    line({ ...asked, options: [{ id: "a", label: "x" }, { id: "a", label: "y" }] }),
    line({ ...asked, options: Array.from({ length: 7 }, (_, i) =>
      ({ id: `o${i}`, label: "x" })) }),
    line({ ...asked, options: "a" }),
  ]) assert.equal(parseAmuxV22OwnerQuestion(bad), null, bad);
});

test("the bounds are on the raw text, the same the bridge reads", () => {
  // apps/tomverse-orchestrator v22_result_asks_owner mirrors these cases.
  assert.equal(parseAmuxV22OwnerQuestion(line({ ...asked, question: `${" ".repeat(2_000)}Q` })), null);
  assert.equal(parseAmuxV22OwnerQuestion(line({ ...asked, question: "Q\u0007" })), null);
  assert.ok(parseAmuxV22OwnerQuestion(line({ question: "가".repeat(2_000), unblocks: "u\u0085" })));
});

test("the digest binds the question, what it unblocks and the options", () => {
  const digest = amuxV22OwnerQuestionSha256(asked);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(amuxV22OwnerQuestionSha256(structuredClone(asked)), digest);
  assert.notEqual(amuxV22OwnerQuestionSha256({ ...asked, unblocks: "other" }), digest);
  assert.notEqual(amuxV22OwnerQuestionSha256({ ...asked, options: [] }), digest);
});

test("a Task may ask three questions; the fourth needs a person", () => {
  assert.equal(AMUX_V22_OWNER_QUESTION_LIMIT, 3);
  for (const sequence of [1, 2, 3]) assert.deepEqual(
    amuxV22OwnerQuestionSettlement(sequence),
    { questionState: "open", reason: "owner_question" });
  assert.deepEqual(amuxV22OwnerQuestionSettlement(4),
    { questionState: "cancelled", reason: "owner_question_limit" });
});

test("an answer is trimmed, bounded and free of control characters", () => {
  assert.equal(normalizeAmuxV22OwnerAnswer("  Name it.\r\nThanks  "), "Name it.\nThanks");
  for (const bad of ["", "   ", 7, null, "x".repeat(8_001), "a\u0000b"])
    assert.equal(normalizeAmuxV22OwnerAnswer(bad), null);
});

test("the worker reads how to ask, and that the Task is not finished", () => {
  assert.match(AMUX_V22_OWNER_QUESTION_RULES, /do not guess/);
  assert.ok(AMUX_V22_OWNER_QUESTION_RULES.includes(AMUX_V22_OWNER_QUESTION_MARKER));
  assert.match(AMUX_V22_OWNER_QUESTION_RULES, /not finished until its goal is met/);
});

test("the resume section carries the question, the answer and the change that fits", () => {
  const input = { question: asked, answer: "Keep it generic.",
    answerSource: "dm_confirmed", previousPatch: "diff --git a/x b/x\n+1\n",
    promptBytesWithoutSection: 1_000 };
  const section = buildAmuxV22ResumeSection(input);
  assert.match(section, /Your previous run asked: Should the starter lock/);
  assert.match(section, /- b: Keep it generic/);
  assert.match(section, /Decision Maker proposal confirmed by the operator/);
  assert.match(section, /git apply --3way/);
  assert.ok(section.includes(input.previousPatch));
  const noPatch = buildAmuxV22ResumeSection({ ...input, previousPatch: null });
  assert.ok(!/git apply|too long/.test(noPatch));
  // A run whose result can no longer be read still resumes with the answer.
  const unread = buildAmuxV22ResumeSection({ ...input, question: null });
  assert.match(unread, /not repeated here/);
  assert.match(unread, /Keep it generic./);
});

test("the answer always goes whole: the change, options, unblocks and question go first", () => {
  const long = { question: `${"가".repeat(1_998)}?`, unblocks: "나".repeat(1_000),
    options: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: "다".repeat(300) })) };
  const answer = "라".repeat(4_000);
  const patch = `diff --git a/x b/x${"\n+x".repeat(2_000)}\n`;
  const at = (base) => buildAmuxV22ResumeSection({ question: long, answer,
    answerSource: "operator", previousPatch: patch, promptBytesWithoutSection: base });
  let previous = Infinity;
  for (const base of [500, 4_000, 8_000, 12_000, 16_000]) {
    const section = at(base);
    assert.ok(section.includes(answer), String(base));
    assert.ok(base + Buffer.byteLength(section, "utf8") + 2 <= AMUX_V22_RESUME_PROMPT_MAX_BYTES, String(base));
    assert.ok(Buffer.byteLength(section, "utf8") <= previous);
    previous = Buffer.byteLength(section, "utf8");
  }
  assert.ok(!at(500).includes(patch), "the long change goes first");
  assert.match(at(16_000), /not repeated here/);
  // Not even the answer fits: no section, so the delivery is refused.
  assert.equal(at(AMUX_V22_RESUME_PROMPT_MAX_BYTES - 1_000), null);
  assert.ok(amuxV22ResumeMinimumBytes(answer, "operator") > Buffer.byteLength(answer, "utf8"));
});

test("a settlement parks a questioning run blocked, escalating only over the limit", () => {
  assert.equal(amuxV22OwnerQuestionSettlementPlan(null), null);
  assert.deepEqual(amuxV22OwnerQuestionSettlementPlan({ state: "open" }),
    { toStatus: "blocked", reason: "owner_question", openEscalation: false });
  assert.deepEqual(amuxV22OwnerQuestionSettlementPlan({ state: "cancelled" }),
    { toStatus: "blocked", reason: "owner_question_limit", openEscalation: true });
});


test("a question may carry what the worker found and the files to read; a bad one is left out, never the question", () => {
  const withContext = parseAmuxV22OwnerQuestion(line({ ...asked,
    context: "lib/amux/fileRetry.ts retries twice and shows nothing.",
    paths: ["lib/amux/fileRetry.ts", "lib/amux/fileRetry.ts", "../etc/passwd", "/abs/path", 7, "components/chat/FileCard.tsx"] }));
  assert.equal(withContext.context, "lib/amux/fileRetry.ts retries twice and shows nothing.");
  // Once each, repository-relative only.
  assert.deepEqual(withContext.paths, ["lib/amux/fileRetry.ts", "components/chat/FileCard.tsx"]);
  const tooLong = parseAmuxV22OwnerQuestion(line({ ...asked, context: "x".repeat(2_001), paths: "not a list" }));
  assert.equal(tooLong.question, asked.question);
  assert.equal("context" in tooLong, false);
  assert.equal("paths" in tooLong, false);
  // A question without them parses exactly as before, so its digest is unchanged.
  assert.deepEqual(Object.keys(parseAmuxV22OwnerQuestion(line(asked))).sort(), ["options", "question", "unblocks"]);
  assert.equal(amuxV22OwnerQuestionSha256(withContext), amuxV22OwnerQuestionSha256(parseAmuxV22OwnerQuestion(line(asked))));
});

test("the Decision Maker's card names the asking card and carries the worker's context and paths", () => {
  const question = parseAmuxV22OwnerQuestion(line({ ...asked, context: "Two retry paths exist.",
    paths: ["lib/amux/fileRetry.ts"] }));
  const card = amuxV22QuestionDmCard({ questionId: "q-1", worker: "codex-impl", providerClass: "codex",
    taskId: "cdd90973-16bd-4729-8940-1219cc639be5", sequence: 1, displayKey: "AMUX-AUTOFILE-003",
    cardTitle: "File retry trailer signal", question });
  assert.equal(card.title, "AMUX-AUTOFILE-003 File retry trailer signal");
  assert.equal(card.context, 'Card: AMUX-AUTOFILE-003 "File retry trailer signal", question 1 from worker codex-impl.\n\nTwo retry paths exist.');
  assert.deepEqual(card.context_paths, ["lib/amux/fileRetry.ts"]);
  assert.deepEqual(card.options, asked.options);
  assert.equal(card.provider, "codex");
  // No key or title: the Task id, as before, and still the card line.
  const bare = amuxV22QuestionDmCard({ questionId: "q-1", worker: "codex-impl", providerClass: "codex",
    taskId: "t-1", sequence: 2, displayKey: null, cardTitle: null, question: parseAmuxV22OwnerQuestion(line(asked)) });
  assert.equal(bare.title, "v22 Task t-1 question 2");
  assert.equal(bare.context, "Card: v22 Task t-1, question 2 from worker codex-impl.");
  assert.deepEqual(bare.context_paths, []);
  // Local AMUX's bounds: a 200-unit title, a 4000-unit context.
  const long = amuxV22QuestionDmCard({ questionId: "q-1", worker: "w", providerClass: "codex", taskId: "t",
    sequence: 1, displayKey: "K-1", cardTitle: "가".repeat(400),
    question: { ...question, context: "y".repeat(2_000) } });
  assert.ok(long.title.length <= 200 && long.title.endsWith("…"));
  assert.ok(long.context.length <= 4_000);
});

test("the rules ask for options, context and paths, and say the Decision Maker escalates without grounds", () => {
  assert.match(AMUX_V22_OWNER_QUESTION_RULES, /"context":"<what you found/);
  assert.match(AMUX_V22_OWNER_QUESTION_RULES, /"paths":\["<repository-relative file/);
  assert.match(AMUX_V22_OWNER_QUESTION_RULES, /escalates a question it has no grounds for/);
});
