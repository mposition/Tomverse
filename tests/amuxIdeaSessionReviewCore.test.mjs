import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAmuxSessionReviewAnswer, readAmuxSessionReviewReply,
} from "../lib/amux/ideaSessionReviewCore.ts";
import { amuxV19SessionPromptForClaim } from "../lib/amux/ideaSessionAnalysisPromptCore.ts";

const answer = (fields) => JSON.stringify({ schemaVersion: 2, previewId: "p", chunkIndex: 0,
  outcome: "needs_information", coverageStatus: "needs_owner_input", continuationKind: null,
  ownerQuestion: "Should the badge live in the idea list or the detail page?",
  coveredScope: null, remainingScope: null, units: [], ...fields });

test("an owner question in the kept answer is shown as the model wrote it", () => {
  assert.deepEqual(classifyAmuxSessionReviewAnswer(answer({})), { reason: "owner_question",
    question: "Should the badge live in the idea list or the detail page?" });
  assert.deepEqual(classifyAmuxSessionReviewAnswer(answer({ ownerQuestion: "  Which page?\n" })),
    { reason: "owner_question", question: "Which page?" }, "trimmed");
});

test("anything else is the closed not-a-plan word, never model text", () => {
  for (const raw of ["not json", "[]", "null", answer({ coverageStatus: "complete" }),
    answer({ ownerQuestion: null }), answer({ ownerQuestion: "   " }),
    answer({ ownerQuestion: "x".repeat(2_001) }), answer({ ownerQuestion: "ask ‮ me" })]) {
    assert.deepEqual(classifyAmuxSessionReviewAnswer(raw), { reason: "not_a_plan" }, raw.slice(0, 40));
  }
});

test("the Admin screen trusts only an exact review reply", () => {
  assert.deepEqual(readAmuxSessionReviewReply({ review: { reason: "not_a_plan" } }), { reason: "not_a_plan" });
  assert.deepEqual(readAmuxSessionReviewReply({ review: { reason: "owner_question", question: "Which?" } }),
    { reason: "owner_question", question: "Which?" });
  for (const body of [null, {}, { review: null }, { review: { reason: "not_a_plan", extra: 1 } },
    { review: { reason: "owner_question" } }, { review: { reason: "owner_question", question: "" } },
    { review: { reason: "owner_question", question: "x".repeat(2_001) } },
    { review: { reason: "invalid_result" } }]) {
    assert.equal(readAmuxSessionReviewReply(body), null, JSON.stringify(body)?.slice(0, 60));
  }
});

test("the unattended prompt tells the model to assume and propose instead of asking", () => {
  const claimId = "11111111-1111-4111-8111-111111111111";
  const pagePrompt = `Plan this.\nBEGIN_CONFIRMED_DATA_JSON\n${JSON.stringify({ previewId: claimId })}\nEND_CONFIRMED_DATA_JSON\n`;
  for (const provider of ["anthropic", "github-copilot", "cursor", "openai"]) {
    const prompt = amuxV19SessionPromptForClaim({ claimId, pagePrompt, referenceCount: 1, provider });
    assert.ok(prompt?.startsWith(pagePrompt), provider);
    assert.match(prompt, /a question ends it with no plan at all/);
    assert.match(prompt, /Do not ask the owner to confirm names, file locations, wording, scope or priority/);
    assert.match(prompt, /state that assumption in the affected unit, and propose/);
  }
});
