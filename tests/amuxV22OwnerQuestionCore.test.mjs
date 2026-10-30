import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V22_OWNER_QUESTION_LIMIT,
  AMUX_V22_OWNER_QUESTION_MARKER,
  AMUX_V22_OWNER_QUESTION_RULES,
  AMUX_V22_RESUME_PROMPT_MAX_BYTES,
  amuxV22OwnerQuestionSettlement,
  amuxV22OwnerQuestionSettlementPlan,
  amuxV22OwnerQuestionSha256,
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
  assert.match(section, /Keep it generic\.\n/);
  assert.match(section, /git apply --3way/);
  assert.ok(section.includes(input.previousPatch));

  const crowded = buildAmuxV22ResumeSection({ ...input, answerSource: "operator",
    promptBytesWithoutSection: AMUX_V22_RESUME_PROMPT_MAX_BYTES - 200 });
  assert.match(crowded, /answered \(operator\)/);
  assert.ok(!crowded.includes(input.previousPatch));
  assert.match(crowded, /too long to include/);

  const noPatch = buildAmuxV22ResumeSection({ ...input, previousPatch: null });
  assert.ok(!/git apply|too long/.test(noPatch));
});

test("a settlement parks a questioning run blocked, escalating only over the limit", () => {
  assert.equal(amuxV22OwnerQuestionSettlementPlan(null), null);
  assert.deepEqual(amuxV22OwnerQuestionSettlementPlan({ state: "open" }),
    { toStatus: "blocked", reason: "owner_question", openEscalation: false });
  assert.deepEqual(amuxV22OwnerQuestionSettlementPlan({ state: "cancelled" }),
    { toStatus: "blocked", reason: "owner_question_limit", openEscalation: true });
});
