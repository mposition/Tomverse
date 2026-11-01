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

const units = JSON.parse(firstPage()).units;
const task = (overrides = {}) => ({ ...units[3], localId: "c0:card-1", cardType: "task", storyKind: null,
  taskRole: "implement", executionGrade: "routine", executionBrief: "Change it.",
  portfolioSignal: { ...signal, metrics: { contribution: 3, urgency: 2, dependencyUnlock: 1,
    workerCoverage: 4, effort: 2, deliveryRisk: 1 } }, expectedPaths: ["lib/x.ts"], ...overrides });
const detailOf = (raw) => amuxSessionReviewFirstPageDetail(raw, claimId);

test("a refused first page names the plan writer's own failed check, never answer text", () => {
  assert.deepEqual(detailOf(firstPage()), { detail: "draft_refused" },
    "a page the inspection accepts was refused later, when its draft was stored");
  assert.deepEqual(detailOf(firstPage({ units: [...units, task()] })), { detail: "draft_refused" });
  assert.deepEqual(detailOf("```json\n{}\n```"),
    { detail: "chunk_schema_rejected", at: { rule: "json_fenced" } });
  assert.deepEqual(detailOf("not json"), { detail: "chunk_schema_rejected", at: { rule: "json_unparsable" } });
  assert.deepEqual(detailOf(firstPage({ previewId: "other" })),
    { detail: "chunk_schema_rejected", at: { rule: "header_mismatch", field: "previewId" } },
    "the claim is the preview id");
  assert.deepEqual(detailOf(firstPage({ extra: true })),
    { detail: "chunk_schema_rejected", at: { rule: "key_extra", field: "chunk" } });
  assert.deepEqual(detailOf(firstPage({ coveredScope: "" })), { detail: "chunk_metadata_incomplete" });
  assert.deepEqual(detailOf("x".repeat(65_537)), { detail: "chunk_too_large" });
  for (const raw of [firstPage(), "not json", firstPage({ units: [] })]) {
    assert.ok(AMUX_SESSION_REVIEW_DETAILS.includes(detailOf(raw).detail));
  }
});

test("a schema refusal names the rule, the schema field and the unit position", () => {
  const at = (raw) => detailOf(raw).at;
  assert.deepEqual(at(firstPage({ units: [...units, task({ taskRole: "plan" })] })),
    { rule: "value_not_allowed", field: "taskRole", unit: 4, kind: "card" });
  const pathless = task();
  delete pathless.expectedPaths;
  assert.deepEqual(at(firstPage({ units: [...units, pathless] })),
    { rule: "task_expected_paths_missing", field: "expectedPaths", unit: 4, kind: "card" });
  assert.deepEqual(at(firstPage({ units: [...units, task({ taskRole: "review" })] })),
    { rule: "task_review_role", field: "taskRole", unit: 4, kind: "card" });
  assert.deepEqual(at(firstPage({ units: [...units.slice(0, 3), { ...units[3], dependencyRefs: ["c0:card-1"] },
    task()] })), { rule: "story_dependency", field: "dependencyRefs", unit: 3, kind: "card" });
  assert.deepEqual(at(firstPage({ units: [{ ...units[0], portfolioSignal: { ...signal, metrics: { impact: 3 } } },
    ...units.slice(1)] })), { rule: "key_missing", field: "value", unit: 0, kind: "node" });
  assert.deepEqual(at(firstPage({ units: [...units, task({ dependencyRefs: ["c0:card-0"] })] })),
    { rule: "dependency_ref_kind", field: "dependencyRefs", unit: 4, kind: "card" });
  assert.deepEqual(at(firstPage({ outcome: "reject" })), { rule: "outcome_combination", field: "outcome" });
});

test("a not-a-plan reply may carry only a closed detail code", () => {
  assert.deepEqual(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail: "chunk_too_large" } }),
    { reason: "not_a_plan", detail: "chunk_too_large" });
  const at = { rule: "value_not_allowed", field: "taskRole", unit: 4, kind: "card" };
  assert.deepEqual(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail: "chunk_schema_rejected",
    at } }), { reason: "not_a_plan", detail: "chunk_schema_rejected", at });
  for (const bad of [{ ...at, rule: "model text" }, { ...at, field: "made_up" }, { ...at, unit: -1 },
    { rule: "key_extra", kind: "card" }, { ...at, extra: 1 }, "key_extra"]) {
    assert.equal(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail: "chunk_schema_rejected",
      at: bad } }), null, JSON.stringify(bad));
  }
  assert.equal(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail: "chunk_too_large", at } }),
    null, "only a schema refusal carries a place");
  for (const detail of ["model text", "", null, "chunk_", 3]) {
    assert.equal(readAmuxSessionReviewReply({ review: { reason: "not_a_plan", detail } }), null, String(detail));
  }
});
