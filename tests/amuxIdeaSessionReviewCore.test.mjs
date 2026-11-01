import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_SESSION_REVIEW_DETAILS, classifyAmuxSessionReviewAnswer, readAmuxSessionReviewReply,
} from "../lib/amux/ideaSessionReviewCore.ts";
import { amuxSessionReviewFirstPageDetail } from "../lib/amux/ideaSessionReviewDetailCore.ts";
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

const claimId = "22222222-2222-4222-8222-222222222222";
const signal = { metrics: { impact: 3 }, uncertainty: "low", rationale: "A bounded page.",
  evidenceRefIds: ["operator_idea"] };
const node = (localId, level, parentRef, extra = {}) => ({ kind: "node", localId, level, parentRef,
  title: `${level} title`, description: `One ${level}.`, sourceRefIds: ["operator_idea"],
  portfolioSignal: { ...signal, metrics: { value: 3 } }, ...extra });
const firstPage = (overrides = {}) => JSON.stringify({ schemaVersion: 5, previewId: claimId,
  chunkIndex: 0, outcome: "propose", coverageStatus: "complete", continuationKind: null,
  ownerQuestion: null, coveredScope: "The idea was analysed.", remainingScope: null,
  units: [node("c0:node-0", "initiative", null), node("c0:node-1", "epic", "c0:node-0"),
    node("c0:node-2", "feature", "c0:node-1", { displayPrefix: "CONT" }),
    { kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
      title: "Story", problem: "One requirement.", scopeIn: ["Do it"], scopeOut: ["Not that"],
      completionCriteria: ["It is done"], featureRef: "c0:node-2", parentStoryRef: null,
      dependencyRefs: [], duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
      executionBrief: null, sourceRefIds: ["operator_idea"], portfolioSignal: signal }],
  ...overrides });

test("a refused first page names the plan writer's own failed check, never answer text", () => {
  assert.equal(amuxSessionReviewFirstPageDetail(firstPage(), claimId), "draft_refused",
    "a page the inspection accepts was refused later, when its draft was stored");
  assert.equal(amuxSessionReviewFirstPageDetail("```json\n{}\n```", claimId), "chunk_schema_rejected");
  assert.equal(amuxSessionReviewFirstPageDetail(firstPage({ previewId: "other" }), claimId),
    "chunk_schema_rejected", "the claim is the preview id");
  assert.equal(amuxSessionReviewFirstPageDetail(firstPage({ extra: true }), claimId), "chunk_schema_rejected");
  assert.equal(amuxSessionReviewFirstPageDetail(firstPage({ coveredScope: "" }), claimId),
    "chunk_metadata_incomplete");
  assert.equal(amuxSessionReviewFirstPageDetail("x".repeat(65_537), claimId), "chunk_too_large");
  for (const raw of [firstPage(), "not json", firstPage({ units: [] })]) {
    assert.ok(AMUX_SESSION_REVIEW_DETAILS.includes(amuxSessionReviewFirstPageDetail(raw, claimId)));
  }
});

test("a not-a-plan reply may carry only a closed detail code", () => {
  assert.deepEqual(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail: "chunk_too_large" } }),
    { reason: "not_a_plan", detail: "chunk_too_large" });
  for (const detail of ["model text", "", null, "chunk_", 3]) {
    assert.equal(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail } }), null, String(detail));
  }
});
