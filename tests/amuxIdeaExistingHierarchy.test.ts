import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { amuxFeatureDisplayPrefixChoices } from "@/lib/amux/cardDisplayKeyBackfillCore";
import { amuxPermittedTargetRefSafe, inspectAmuxAnalysisChunk,
  snapshotAmuxPermittedTarget } from "@/lib/amux/ideaAnalysisChunkCore";
import { buildAmuxIdeaAnalysisPrompt } from "@/lib/amux/ideaAnalysisPromptCore";
import { amuxExistingHierarchyTargets, amuxExistingNodeIds,
  amuxStoredPageExistingNodeTargets } from "@/lib/amux/ideaExistingHierarchyCore";
import { amuxV4PlanNamesExistingNode, amuxV4PlanUnitAttachment,
  type AmuxV4PlanScreenUnit } from "@/lib/amux/ideaPlanScreenCore";
import { inspectAmuxIdeaSessionPlan,
  inspectAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionCore";
import { amuxSessionPlanFixture } from "./fixtures/amuxSessionPlan.mjs";

// The AEO case of 2026-11-22: two ideas that split one goal.
const INITIATIVE = "5f0c9d1e-4b6a-4c3d-8e2f-1a2b3c4d5e6f";
const EPIC = "6a1d0e2f-5c7b-4d4e-9f30-2b3c4d5e6f70";
const FEATURE = "7b2e1f30-6d8c-4e5f-a041-3c4d5e6f7081";
const ARCHIVED = "8c3f2041-7e9d-4f60-b152-4d5e6f708192";

const catalog = () => [
  { id: FEATURE, level: "feature" as const, parentId: EPIC,
    title: "Crawler access policy", displayPrefix: "CRAWL", archived: false },
  { id: EPIC, level: "epic" as const, parentId: INITIATIVE,
    title: "Answer engine visibility", displayPrefix: null, archived: false },
  { id: INITIATIVE, level: "initiative" as const, parentId: null,
    title: "AEO", displayPrefix: null, archived: false },
  { id: ARCHIVED, level: "feature" as const, parentId: EPIC,
    title: "Old feature", displayPrefix: "OLD", archived: true },
];
const existing = () => amuxExistingHierarchyTargets(catalog());

const signal = (metrics: Record<string, number>) => ({ metrics, uncertainty: "medium",
  rationale: "The idea states it.", evidenceRefIds: ["operator_idea"] });
const task = (featureRef: string) => ({ kind: "card", localId: "c0:card-0", cardType: "task",
  storyKind: null, title: "Align the pricing page", problem: "Free and paid scope differ.",
  scopeIn: ["Align the copy"], scopeOut: ["No price change"],
  completionCriteria: ["The page matches the plan"], featureRef, parentStoryRef: null,
  dependencyRefs: [], duplicateCandidateRefs: [], taskRole: "implement", executionGrade: "routine",
  executionBrief: "Read the pricing page, then align it.",
  expectedPaths: ["app/(site)/pricing/page.tsx"], sourceRefIds: ["operator_idea"],
  portfolioSignal: signal({ contribution: 2, urgency: 2, dependencyUnlock: 0,
    workerCoverage: 3, effort: 1, deliveryRisk: 1 }) });
/** A plan with only a Task, attached to an existing Feature. */
const attachedPlan = (featureRef = FEATURE) => amuxSessionPlanFixture({ units: [task(featureRef)] });
/** A plan with a new Feature under an existing Epic, and its Task. */
const newFeaturePlan = (parentRef = EPIC, displayPrefix?: string) => amuxSessionPlanFixture({ units: [
  { kind: "node", localId: "c0:node-0", level: "feature", parentRef,
    title: "Public pricing scope", description: "Free and paid scope on public pages.",
    sourceRefIds: ["operator_idea"], ...(displayPrefix ? { displayPrefix } : {}),
    portfolioSignal: signal({ value: 2 }) },
  task("c0:node-0"),
] });

test("existing nodes become permitted targets, parents first, archived ones left out", () => {
  const targets = existing();
  assert.deepEqual(targets.map((target) => [target.level, target.ref]),
    [["initiative", INITIATIVE], ["epic", EPIC], ["feature", FEATURE]]);
  assert.deepEqual(targets[2], { ref: FEATURE, kind: "node", level: "feature",
    title: "Crawler access policy", parentRef: EPIC, displayPrefix: "CRAWL" });
  assert.equal(targets[0]!.parentRef, null);
  assert.equal(targets[1]!.displayPrefix, null);
  assert.deepEqual([...amuxExistingNodeIds(targets)], [INITIATIVE, EPIC, FEATURE]);
  // No count limit: a large hierarchy is listed whole.
  const many = Array.from({ length: 1_500 }, (_, index) => ({ id: randomUUID(),
    level: "initiative" as const, parentId: null, title: `Initiative ${index}`,
    displayPrefix: null, archived: false }));
  assert.equal(amuxExistingHierarchyTargets(many).length, 1_500);
});

test("a node whose stored row a prompt may not carry is left out, not the whole list", () => {
  const targets = amuxExistingHierarchyTargets([
    ...catalog(),
    { id: randomUUID(), level: "epic", parentId: null, title: "Orphan epic",
      displayPrefix: null, archived: false },
    { id: randomUUID(), level: "feature", parentId: EPIC, title: "Key sk-live1234567890abcdef",
      displayPrefix: null, archived: false },
    { id: randomUUID(), level: "epic", parentId: INITIATIVE, title: "Prefixed epic",
      displayPrefix: "EPIC", archived: false },
  ]);
  assert.equal(targets.length, 4);
  assert.equal(targets.find((target) => target.title === "Prefixed epic")?.displayPrefix, null);
  // A title with a line break is shown on one line.
  assert.equal(amuxExistingHierarchyTargets([{ id: INITIATIVE, level: "initiative",
    parentId: null, title: "Two\nlines", displayPrefix: null, archived: false }])[0]!.title,
  "Two lines");
});

test("an existing-node target is read in either shape and must describe a real row", () => {
  const target = existing()[2]!;
  assert.deepEqual(snapshotAmuxPermittedTarget({ ...target }), target);
  assert.deepEqual(snapshotAmuxPermittedTarget({ ref: "c0:node-1", kind: "node", level: "epic" }),
    { ref: "c0:node-1", kind: "node", level: "epic" });
  // The three descriptive keys come together.
  assert.equal(snapshotAmuxPermittedTarget({ ref: FEATURE, kind: "node", level: "feature",
    title: "x" }), null);
  for (const bad of [
    { ...target, ref: "c0:node-0" },
    { ...target, parentRef: null },
    { ...target, displayPrefix: "lower" },
    { ...existing()[1]!, displayPrefix: "EPIC" },
    { ...existing()[0]!, parentRef: EPIC },
    { ...target, title: "" },
    { ...target, title: "a\nb" },
  ]) {
    assert.equal(amuxPermittedTargetRefSafe(bad, 0), false, JSON.stringify(bad));
  }
});

test("the prompt's confirmed data lists every existing node with what reuse needs", () => {
  const built = buildAmuxIdeaAnalysisPrompt({ previewId: "preview_12345678", chunkIndex: 0,
    revisionChunkIndex: 0, continuation: null,
    sourceTexts: [{ refId: "operator_idea", kind: "operator_idea", text: "Align public pricing." }],
    permittedTargetRefs: existing() });
  assert.equal(built.status, "prompt_candidate");
  if (built.status !== "prompt_candidate") return;
  const data = JSON.parse(/BEGIN_CONFIRMED_DATA_JSON\n([^\n]+)\n/.exec(built.prompt)![1]!);
  assert.deepEqual(data.permittedTargetRefs, existing());
  assert.match(built.prompt, /is an existing registered node/);
  assert.match(built.prompt, /using its ref as featureRef/);
  assert.match(built.prompt, /Two ideas that split one goal belong under the same existing node/);
  // A page with no existing hierarchy is the prompt it always was.
  const empty = buildAmuxIdeaAnalysisPrompt({ previewId: "preview_12345678", chunkIndex: 0,
    revisionChunkIndex: 0, continuation: null,
    sourceTexts: [{ refId: "operator_idea", kind: "operator_idea", text: "Align public pricing." }],
    permittedTargetRefs: [] });
  assert.equal(empty.status, "prompt_candidate");
});

test("an answer may attach to an existing Feature only when that node was given", () => {
  const raw = JSON.stringify({ schemaVersion: 5, previewId: "preview_12345678", chunkIndex: 0,
    outcome: "propose", coverageStatus: "complete", continuationKind: null, ownerQuestion: null,
    coveredScope: "Pricing scope.", remainingScope: null, units: [task(FEATURE)] });
  const inspect = (permittedTargetRefs: ReturnType<typeof existing>) => inspectAmuxAnalysisChunk({
    raw, expectedPreviewId: "preview_12345678", expectedChunkIndex: 0,
    expectedRevisionChunkIndex: 0, previousContinuationKind: null,
    permittedSourceRefIds: ["operator_idea"], permittedTargetRefs, requiredSchemaVersion: 5 });
  assert.equal(inspect(existing()).ok, true);
  assert.deepEqual(inspect([]), { ok: false, code: "target_ref_unapproved" });
  // The ids and levels alone (the in-transaction check) admit the same answer.
  assert.equal(inspect(existing().map(({ ref, kind, level }) => ({ ref, kind, level }))).ok, true);
});

test("a session plan attaches to existing nodes, and a ref to any other node is refused", () => {
  const nodes = existing();
  const attached = inspectAmuxIdeaSessionPlan(attachedPlan(), randomUUID(), nodes);
  assert.equal(attached.ok, true);
  assert.equal(attached.ok && attached.plan.unitCount, 1);
  assert.deepEqual(attached.ok && attached.plan.existingNodes, nodes);
  // A new Feature under an existing Epic.
  assert.equal(inspectAmuxIdeaSessionPlan(newFeaturePlan(), randomUUID(), nodes).ok, true);
  // A node that does not exist, or one of the wrong level, is refused.
  const unknown = inspectAmuxIdeaSessionPlan(attachedPlan(randomUUID()), randomUUID(), nodes);
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.code === "plan_rejected" && unknown.detail?.detail,
    "chunk_target_ref_unapproved");
  assert.equal(inspectAmuxIdeaSessionPlan(attachedPlan(EPIC), randomUUID(), nodes).ok, false);
  assert.equal(inspectAmuxIdeaSessionPlan(newFeaturePlan(INITIATIVE), randomUUID(), nodes).ok,
    false);
  // An archived node is not offered, so a plan cannot attach to it.
  assert.equal(inspectAmuxIdeaSessionPlan(attachedPlan(ARCHIVED), randomUUID(), nodes).ok, false);
  // Without the hierarchy the same plan is refused; a plan of new nodes is not.
  assert.equal(inspectAmuxIdeaSessionPlan(attachedPlan(), randomUUID()).ok, false);
  assert.equal(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture(), randomUUID()).ok, true);
  const submission = { version: 1, requestId: randomUUID(), source: { toolName: "Codex",
    modelProvider: "OpenAI", sessionDisplay: "AEO session" },
  input: { version: 1, idea: "Align public pricing.", repositories: ["mposition/Tomverse"],
    pullRequests: [] }, plan: attachedPlan() };
  assert.equal(inspectAmuxIdeaSessionSubmission(submission, nodes).ok, true);
  assert.deepEqual(inspectAmuxIdeaSessionSubmission(submission), { ok: false, code: "plan_rejected" });
});

test("a stored first page re-reads with the existing nodes it named", () => {
  const units = newFeaturePlan().units as Parameters<typeof amuxStoredPageExistingNodeTargets>[0];
  assert.deepEqual(amuxStoredPageExistingNodeTargets(units),
    [{ ref: EPIC, kind: "node", level: "epic" }]);
  assert.deepEqual(amuxStoredPageExistingNodeTargets(
    attachedPlan().units as Parameters<typeof amuxStoredPageExistingNodeTargets>[0]),
  [{ ref: FEATURE, kind: "node", level: "feature" }]);
  // A plan of only new nodes names none, as before.
  assert.deepEqual(amuxStoredPageExistingNodeTargets(
    amuxSessionPlanFixture().units as Parameters<typeof amuxStoredPageExistingNodeTargets>[0]), []);
});

test("the plan screen tells an attachment to an existing node from a new one", () => {
  const unit = (kind: AmuxV4PlanScreenUnit["kind"], refs: Partial<AmuxV4PlanScreenUnit>) => ({
    unitId: randomUUID(), localRef: "c0:card-0", kind, title: "t", taskRole: null, metrics: null,
    uncertainty: null, bodyDigest: "d", featureRef: null, parentRef: null, parentStoryRef: null,
    dependencyRefs: [], ...refs }) as AmuxV4PlanScreenUnit;
  const names = new Map([[FEATURE, { ref: FEATURE, level: "feature" as const,
    title: "Crawler access policy", displayPrefix: "CRAWL" }]]);
  assert.deepEqual(amuxV4PlanUnitAttachment(unit("task", { featureRef: FEATURE }), names),
    { level: "feature", title: "Crawler access policy", displayPrefix: "CRAWL" });
  assert.deepEqual(amuxV4PlanUnitAttachment(unit("feature", { parentRef: EPIC }), names),
    { level: "epic", title: null, displayPrefix: null });
  assert.equal(amuxV4PlanUnitAttachment(unit("task", { featureRef: "c0:node-2" }), names), null);
  assert.equal(amuxV4PlanUnitAttachment(unit("initiative", {}), names), null);
  assert.equal(amuxV4PlanNamesExistingNode([unit("story", { featureRef: FEATURE })]), true);
  assert.equal(amuxV4PlanNamesExistingNode([unit("story", { featureRef: "c0:node-2" })]), false);
});

test("a Feature gets its card number prefix at registration even without a proposal", () => {
  const proposed = amuxFeatureDisplayPrefixChoices({ proposed: "PRICE", title: "Public pricing" });
  assert.deepEqual(proposed.slice(0, 2), ["PRICE", "PRICE2"]);
  assert.ok(proposed.indexOf("PUBLIC") > proposed.indexOf("PRICE99"));
  const untitled = amuxFeatureDisplayPrefixChoices({ proposed: undefined, title: "Public pricing scope" });
  assert.deepEqual(untitled.slice(0, 2), ["PUBLIC", "PUBLIC2"]);
  assert.equal(untitled.includes("FEAT1"), true);
  // No usable title: FEAT<n>, so no card is left unnumbered.
  assert.deepEqual(amuxFeatureDisplayPrefixChoices({ title: null }).slice(0, 2), ["FEAT1", "FEAT2"]);
  assert.deepEqual(amuxFeatureDisplayPrefixChoices({ proposed: "bad", title: "가격" }).slice(0, 1),
    ["FEAT1"]);
});
