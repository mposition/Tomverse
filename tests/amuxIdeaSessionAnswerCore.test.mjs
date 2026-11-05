import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxAnalysisContinuation } from "../lib/amux/ideaAnalysisContinuationCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION, amuxAnalysisPromptWithNote, buildAmuxIdeaAnalysisPrompt }
  from "../lib/amux/ideaAnalysisPromptCore.ts";
import { AMUX_SESSION_PAGE_NOTE, amuxSessionAnswerUnitCount } from "../lib/amux/ideaSessionAnswerCore.ts";
import { amuxV19SessionPromptForClaim } from "../lib/amux/ideaSessionAnalysisPromptCore.ts";
import { classifyAmuxSessionReviewAnswer } from "../lib/amux/ideaSessionReviewCore.ts";
import { amuxSessionPageRefusalDetail, amuxSessionReviewFirstPageDetail } from
  "../lib/amux/ideaSessionReviewDetailCore.ts";

const source = "operator_idea";
const feature = { ref: "feature_existing_01", kind: "node", level: "feature" };
const signal = (metrics) => ({ metrics, uncertainty: "low", rationale: "A bounded page.",
  evidenceRefIds: [source] });
const card = (chunkIndex) => ({
  kind: "card", localId: `c${chunkIndex}:card-1`, cardType: "story", storyKind: "general",
  title: "One reviewable story", problem: "A page needs a card.", scopeIn: ["Review it"],
  scopeOut: ["Do not execute"], completionCriteria: ["It is reviewable"],
  featureRef: feature.ref, parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
  taskRole: null, executionGrade: null, executionBrief: null, sourceRefIds: [source],
  portfolioSignal: signal({ impact: 3 }),
});
const node = (chunkIndex) => ({
  kind: "node", localId: `c${chunkIndex}:node-1`, level: "initiative", parentRef: null,
  title: "One initiative", description: "A node without a card.", sourceRefIds: [source],
  portfolioSignal: signal({ value: 3 }),
});
const answer = (chunkIndex, overrides = {}) => ({
  schemaVersion: 5, previewId: "preview-1", chunkIndex, outcome: "propose",
  coverageStatus: "complete", continuationKind: null, ownerQuestion: null,
  coveredScope: "The idea was analyzed.", remainingScope: null, units: [card(chunkIndex)],
  ...overrides,
});
const inspect = (raw, chunkIndex = 0, history = [], sessionPage = true) => inspectAmuxAnalysisContinuation({
  raw, expectedPreviewId: "preview-1", expectedChunkIndex: chunkIndex,
  expectedRevisionChunkIndex: chunkIndex, permittedSourceRefIds: [source],
  permittedTargetRefs: [feature], sourceUnitCount: 1, coveredStartOrdinal: 0,
  coveredEndOrdinal: 0, history, templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
  ...(sessionPage ? { sessionPage: true } : {}),
});
const page = (chunkIndex, overrides, history = []) =>
  inspect(JSON.stringify(answer(chunkIndex, overrides)), chunkIndex, history);

const continuesAsOutput = (result, remainingScope) => {
  assert.equal(result.ok, true);
  assert.equal(result.parsed.chunk.continuationKind, "output");
  assert.equal(result.parsed.chunk.coverageStatus, "more");
  assert.equal(result.parsed.chunk.remainingScope, remainingScope);
  assert.deepEqual(result.cursor.nextCursor, { sourceOrdinal: 0, outputPartIndex: 1 });
};

const UNNAMED = "The previous page declared more work without naming it.";

test("a named or declared remainder becomes the next page, whatever bookkeeping the model wrote", () => {
  for (const [name, overrides, remainder] of [
    ["more + input", { coverageStatus: "more", continuationKind: "input", remainingScope: "Rest." }, "Rest."],
    ["more + output", { coverageStatus: "more", continuationKind: "output", remainingScope: "Rest." }, "Rest."],
    ["complete + a named remainder", { remainingScope: "Rest." }, "Rest."],
    ["complete + input", { continuationKind: "input", remainingScope: "Rest." }, "Rest."],
    ["more with nothing named", { coverageStatus: "more" }, UNNAMED],
    ["more with a blank remainder", { coverageStatus: "more", continuationKind: "output", remainingScope: "  " }, UNNAMED],
    ["padded remainder", { coverageStatus: "more", continuationKind: "input", remainingScope: " Rest. " }, "Rest."],
    ["a question-less needs_information", { outcome: "needs_information", coverageStatus: "needs_owner_input", remainingScope: "Rest." }, "Rest."],
  ]) {
    assert.ok(name);
    continuesAsOutput(page(0, overrides), remainder);
  }
});

test("the same answers stay refused outside a session page", () => {
  const raw = JSON.stringify(answer(0, { coverageStatus: "more", continuationKind: "input", remainingScope: "Rest." }));
  assert.equal(inspect(raw, 0, [], false).reason, "remaining_mismatch");
});

test("an answer with nothing left finishes, even if it left the fields dirty", () => {
  for (const overrides of [
    {},
    { continuationKind: "output" },
    { ownerQuestion: "Should it also cover mobile?" },
    { ownerQuestion: "   " },
    { remainingScope: "" },
  ]) {
    const result = page(0, overrides);
    assert.equal(result.ok, true);
    assert.equal(result.parsed.chunk.coverageStatus, "complete");
    assert.equal(result.parsed.chunk.continuationKind, null);
    assert.equal(result.parsed.chunk.ownerQuestion, null);
    assert.equal(result.cursor.nextCursor, null);
  }
});

test("identity the app already knows is not the model's to get wrong", () => {
  const raw = answer(0);
  delete raw.ownerQuestion;
  delete raw.remainingScope;
  delete raw.continuationKind;
  const result = inspect(JSON.stringify({ ...raw, schemaVersion: 4, previewId: "typo", chunkIndex: 7,
    note: "an extra top-level key" }));
  assert.equal(result.ok, true);
  assert.equal(result.parsed.chunk.previewId, "preview-1");
  assert.equal(result.parsed.chunk.schemaVersion, 5);
});

test("a fenced answer is normalized and keeps one storage key per unit", () => {
  const fenced = `\`\`\`json\n${JSON.stringify(answer(0, { coverageStatus: "more", continuationKind: "input",
    remainingScope: "Rest." }))}\n\`\`\``;
  continuesAsOutput(inspect(fenced), "Rest.");
  assert.equal(amuxSessionAnswerUnitCount(fenced), 1);
  assert.equal(amuxSessionAnswerUnitCount(JSON.stringify(answer(0))), 1);
  assert.equal(amuxSessionAnswerUnitCount("not json"), 0);
  assert.equal(amuxSessionAnswerUnitCount(JSON.stringify({ units: Array(41).fill({}) })), 0);
});

test("a real question still ends the analysis and shows on the review screen", () => {
  for (const overrides of [
    { outcome: "needs_information", coverageStatus: "needs_owner_input", ownerQuestion: "Which plan?", units: [] },
    { outcome: "needs_information", ownerQuestion: "Which plan?", units: [] },
    { coverageStatus: "more", ownerQuestion: "Which plan?", units: [] },
    { outcome: "needs_information", coverageStatus: "needs_owner_input", continuationKind: "output",
      remainingScope: "Rest.", ownerQuestion: "Which plan?" },
  ]) {
    const raw = JSON.stringify(answer(0, overrides));
    const result = inspect(raw);
    assert.equal(result.stage, "owner_input");
    assert.deepEqual(classifyAmuxSessionReviewAnswer(raw), { reason: "owner_question", question: "Which plan?" });
  }
});

test("a rejection stays a rejection, and one that lists units stays refused", () => {
  const rejected = page(0, { outcome: "reject", coverageStatus: "more", remainingScope: "Rest.", units: [] });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.parsed.chunk.outcome, "reject");
  assert.equal(rejected.parsed.chunk.remainingScope, null);
  assert.equal(page(0, { outcome: "reject" }).stage, "chunk");
});

test("the continuation page may close the plan with nothing further", () => {
  const first = page(0, { coverageStatus: "more", continuationKind: "input", remainingScope: "Rest." });
  const history = [first.cursor.candidate];
  for (const overrides of [
    { units: [] },
    { outcome: "reject", units: [] },
    { units: [node(1)] },
  ]) {
    const closed = page(1, overrides, history);
    assert.equal(closed.ok, true);
    assert.equal(closed.parsed.chunk.outcome, "propose");
    assert.equal(closed.parsed.chunk.coverageStatus, "complete");
    assert.equal(closed.cursor.nextCursor, null);
  }
  const next = page(1, { coverageStatus: "more", continuationKind: "input", remainingScope: "More." }, history);
  assert.deepEqual(next.cursor.nextCursor, { sourceOrdinal: 0, outputPartIndex: 2 });
  // The question keeps what it leaves unfinished, as a later page must.
  const asked = page(1, { outcome: "needs_information", ownerQuestion: "Which plan?", units: [] }, history);
  assert.equal(asked.stage, "owner_input");
  assert.equal(asked.parsed.chunk.remainingScope, UNNAMED);
});

test("no page advances without progress, and an empty first page is no plan", () => {
  assert.equal(page(0, { units: [] }).stage, "chunk");
  const nodesOnly = page(0, { coverageStatus: "more", remainingScope: "Rest.", units: [node(0)] });
  assert.equal(nodesOnly.stage, "chunk");
  const first = page(0, { coverageStatus: "more", remainingScope: "Rest." });
  assert.equal(page(1, { coverageStatus: "more", remainingScope: "Rest.", units: [] },
    [first.cursor.candidate]).stage, "chunk");
});

test("the empty closing page exists only for a session page", () => {
  const first = page(0, { coverageStatus: "more", remainingScope: "Rest." });
  const raw = JSON.stringify(answer(1, { units: [] }));
  assert.equal(inspect(raw, 1, [first.cursor.candidate], false).stage, "chunk");
});

test("unit content is still judged by the parser", () => {
  const broken = page(0, { units: [{ ...card(0), sourceRefIds: ["not_offered"] }] });
  assert.equal(broken.ok, false);
  assert.equal(broken.stage, "chunk");
  assert.equal(inspect("no json at all").stage, "chunk");
  assert.equal(page(0, { outcome: "proposal" }).stage, "chunk");
});

test("an answer refused before the app derived the fields keeps its reason on the review screen", () => {
  const parentNode = (index, level, parentRef) => ({ ...node(0), localId: `c0:node-${index}`, level, parentRef,
    ...(level === "feature" ? { displayPrefix: "WORDFILE" } : {}) });
  const units = [parentNode(0, "initiative", null), parentNode(1, "epic", "c0:node-0"),
    parentNode(2, "feature", "c0:node-1"), { ...card(0), featureRef: "c0:node-2" }];
  const raw = JSON.stringify(answer(0, { previewId: "claim-1", coverageStatus: "more",
    continuationKind: "input", remainingScope: "Rest.", units }));
  assert.deepEqual(amuxSessionReviewFirstPageDetail(raw, "claim-1"), { detail: "cursor_remaining_mismatch" });
  const passing = JSON.stringify(answer(0, { previewId: "claim-1", units }));
  assert.deepEqual(amuxSessionReviewFirstPageDetail(passing, "claim-1"), { detail: "draft_refused" });
});

test("a refusal recorded today names the check the derived answer failed", () => {
  const page = { previewId: "preview-1", chunkIndex: 0, permittedTargetRefs: [feature], history: [] };
  const nodesOnly = JSON.stringify(answer(0, { coverageStatus: "more", continuationKind: "input",
    remainingScope: "Rest.", units: [node(0)] }));
  assert.deepEqual(amuxSessionPageRefusalDetail(nodesOnly, page), { detail: "chunk_schema_rejected",
    at: { rule: "outcome_combination", field: "outcome" } });
  const mislabelled = JSON.stringify(answer(0, { coverageStatus: "more", continuationKind: "input",
    remainingScope: "Rest." }));
  assert.deepEqual(amuxSessionPageRefusalDetail(mislabelled, page), { detail: "draft_refused" },
    "it passes inspection, so only storing it could have refused it");
});

test("the session note sits before the confirmed data, which stays the prompt's last block", () => {
  const built = buildAmuxIdeaAnalysisPrompt({ previewId: "preview-1", chunkIndex: 0, revisionChunkIndex: 0,
    continuation: null, sourceTexts: [{ refId: source, kind: source, text: "One idea. $& $1" }],
    permittedTargetRefs: [] });
  assert.equal(built.status, "prompt_candidate");
  const prompt = amuxAnalysisPromptWithNote(built.prompt, AMUX_SESSION_PAGE_NOTE);
  assert.ok(prompt.indexOf(AMUX_SESSION_PAGE_NOTE) > 0);
  assert.ok(prompt.indexOf(AMUX_SESSION_PAGE_NOTE) < prompt.indexOf("BEGIN_CONFIRMED_DATA_JSON"));
  assert.ok(prompt.endsWith(built.prompt.slice(built.prompt.indexOf("BEGIN_CONFIRMED_DATA_JSON"))));
  assert.ok(amuxV19SessionPromptForClaim({ claimId: "preview-1", pagePrompt: prompt, referenceCount: 1 }));
});
