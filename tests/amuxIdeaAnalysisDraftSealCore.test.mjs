import assert from "node:assert/strict";
import test from "node:test";

import { amuxAnalysisFreeformSubjectId, sealAmuxAnalysisDraft } from "../lib/amux/ideaAnalysisDraftSealCore.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "../lib/amux/ideaCrypto.ts";

const keys = {
  masterKeyId: "test-master",
  masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3),
  digestKeyId: "test-digest",
  digestKey: Buffer.alloc(32, 7),
};
const sourceRef = "idea:confirmed";
const featureRef = "feature_existing_01";
const story = {
  kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
  title: "Review one idea", problem: "The operator needs a bounded proposal.",
  scopeIn: ["Show the proposal"], scopeOut: ["Do not execute it"],
  completionCriteria: ["The operator can review one Story"],
  featureRef, parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
  taskRole: null, executionGrade: null, executionBrief: null,
  sourceRefIds: [sourceRef],
};
const task = {
  ...story, localId: "c0:card-1", cardType: "task", storyKind: null,
  title: "Implement one approval view", parentStoryRef: story.localId,
  taskRole: "implement", executionGrade: "advanced",
  executionBrief: "Build one bounded view and run its test.",
};
const chunk = (units = [story, task]) => ({
  schemaVersion: 2, previewId: "preview-01", chunkIndex: 0,
  outcome: "propose", coverageStatus: "complete", continuationKind: null,
  ownerQuestion: null, coveredScope: "The operator idea was analyzed.",
  remainingScope: null, units,
});
const seal = (value, overrides = {}) => sealAmuxAnalysisDraft({
  ideaId: "idea-01", keys, raw: JSON.stringify(value),
  expectedPreviewId: "preview-01", expectedChunkIndex: 0,
  expectedRevisionChunkIndex: 0, previousContinuationKind: null,
  permittedSourceRefIds: [sourceRef],
  permittedTargetRefs: [{ ref: featureRef, kind: "node", level: "feature" }],
  ...overrides,
});

test("each draft unit has its own encrypted body and keyed digest", () => {
  const result = seal(chunk());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.units.length, 2);
  assert.deepEqual(result.draft.units.map(({ localRef, unitIndex }) =>
    ({ localRef, unitIndex })), [
    { localRef: "c0:card-0", unitIndex: 0 },
    { localRef: "c0:card-1", unitIndex: 1 },
  ]);
  const [first, second] = result.draft.units;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.body.digest, second.body.digest);
  const firstPlain = openAmuxContent(first.body, "analysis_draft", first.id, keys);
  const secondPlain = openAmuxContent(second.body, "analysis_draft", second.id, keys);
  assert.equal(JSON.parse(firstPlain.toString("utf8")).title, story.title);
  assert.equal(JSON.parse(secondPlain.toString("utf8")).title, task.title);
  assert.equal(verifyAmuxContentDigest(firstPlain, "analysis_draft", first.id,
    first.body.digest, first.body.digestKeyId, keys), true);
  assert.throws(() => openAmuxContent(first.body, "analysis_draft", second.id, keys));
  assert.equal(JSON.stringify(result).includes(story.title), false,
    "the sealing result must not retain a monolithic or plaintext proposal");
});

test("coverage and owner question are sealed separately from proposal units", () => {
  const value = { ...chunk([story]), outcome: "needs_information",
    coverageStatus: "needs_owner_input", continuationKind: "input",
    ownerQuestion: "Which existing Epic should own this work?",
    remainingScope: "The remaining project scope needs the operator's answer." };
  const result = seal(value);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.units.length, 1);
  const freeform = openAmuxContent(result.draft.freeform, "analysis_freeform",
    amuxAnalysisFreeformSubjectId("idea-01", "preview-01"), keys);
  const decoded = JSON.parse(freeform.toString("utf8"));
  assert.equal(decoded.ownerQuestion, value.ownerQuestion);
  assert.equal("units" in decoded, false);
  assert.throws(() => openAmuxContent(result.draft.freeform,
    "analysis_freeform", amuxAnalysisFreeformSubjectId("idea-02", "preview-01"), keys));
  assert.throws(() => openAmuxContent(result.draft.freeform,
    "analysis_freeform", amuxAnalysisFreeformSubjectId("idea-01", "preview-02"), keys));
});

test("unapproved source and invalid idea identity are refused before sealing", () => {
  assert.deepEqual(seal(chunk([{ ...story, sourceRefIds: ["other-source"] }])),
    { ok: false, code: "source_ref_unapproved" });
  assert.deepEqual(seal(chunk(), { ideaId: "../idea" }),
    { ok: false, code: "idea_id_invalid" });
});

test("pre-created unit identities are exact, unique, and bound to sealed drafts", () => {
  const ids = ["2c7ba27d-d351-46cf-a840-ec54c3d4834b",
    "9a16ce76-637e-437a-8d54-5a0600951b51"];
  const result = seal(chunk(), { unitIds: ids });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.draft.units.map((unit) => unit.id), ids);
  for (const invalid of [[ids[0]], [ids[0], ids[0]], [ids[0], "../unit"]]) {
    assert.deepEqual(seal(chunk(), { unitIds: invalid }),
      { ok: false, code: "metadata_incomplete" });
  }
});
