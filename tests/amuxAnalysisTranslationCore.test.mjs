import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_ANALYSIS_TRANSLATION_MAX_SOURCE_CHARS,
  AMUX_ANALYSIS_TRANSLATION_SYSTEM,
  amuxAnalysisTranslationEnabled,
  amuxAnalysisTranslationItems,
  amuxAnalysisTranslationViewKey,
  amuxAnalysisViewReadable,
  checkAmuxTranslationSource,
  parseAmuxTranslationOutput,
} from "../lib/amux/ideaAnalysisTranslationCore.ts";

// Owner request 2026-10-30: the analysis result stays English (prompt byte
// caps, duplicate checks, English worker output) and the screen can show a
// Korean reading of it. These pin what is sent and what is accepted back.

const unit = (id, proposal, bodyDigest = "a".repeat(64)) => ({ id, localRef: `ref-${id}`, bodyDigest,
  bodyDigestKeyId: "k1", decisionState: "proposed", proposal });
const view = {
  state: "needs_owner_input", ideaId: "i1", previewId: "p1", completedAt: "2026-10-30T00:00:00Z",
  outcome: "needs_information", coveredScope: "Covers the admin list.", remainingScope: "The mobile view.",
  ownerQuestion: "Which page first?", registrationRefusal: null,
  units: [
    unit("n1", { kind: "node", localId: "n1", level: "feature", parentRef: null, title: "Card view",
      description: "Show cards.", sourceRefIds: [],
      portfolioSignal: { metrics: {}, uncertainty: "low", rationale: "Owner asked.", evidenceRefIds: [] } }),
    unit("c1", { kind: "card", localId: "c1", cardType: "task", storyKind: null, title: "Add `toggle`",
      problem: "No Korean.", scopeIn: ["lib/a.ts", "UI"], scopeOut: [], completionCriteria: ["Tests pass"],
      featureRef: "n1", parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
      taskRole: "impl", executionGrade: "routine", executionBrief: null, sourceRefIds: [] }),
    unit("e1", { kind: "evidence", localId: "e1", evidenceType: "source_finding", summary: "Found it.",
      cardRef: "c1", sourceRefIds: [] }),
    unit("x1", null),
  ],
};

test("the switch opens only on the exact value", () => {
  for (const value of [undefined, "", "true", "on", "Enabled", "enabled "]) {
    assert.equal(amuxAnalysisTranslationEnabled(value), false, String(value));
  }
  assert.equal(amuxAnalysisTranslationEnabled("enabled"), true);
});

test("every free-text field the panel shows is translated, and no ref, level or code is", () => {
  const items = amuxAnalysisTranslationItems(view);
  assert.deepEqual(items, [
    { id: "question", text: "Which page first?" },
    { id: "remaining", text: "The mobile view." },
    { id: "covered", text: "Covers the admin list." },
    { id: "u:n1:title", text: "Card view" },
    { id: "u:n1:description", text: "Show cards." },
    { id: "u:n1:rationale", text: "Owner asked." },
    { id: "u:c1:title", text: "Add `toggle`" },
    { id: "u:c1:problem", text: "No Korean." },
    { id: "u:c1:scopeIn:0", text: "lib/a.ts" },
    { id: "u:c1:scopeIn:1", text: "UI" },
    { id: "u:c1:criteria:0", text: "Tests pass" },
    { id: "u:e1:summary", text: "Found it." },
  ]);
  const ready = { ...view, state: "ready", outcome: "propose" };
  assert.equal(amuxAnalysisTranslationItems(ready).some((item) =>
    item.id === "remaining" || item.id === "question"), false);
});

test("only a readable result has a view key, and a changed unit body is another view", () => {
  assert.equal(amuxAnalysisViewReadable(null), false);
  assert.equal(amuxAnalysisViewReadable({ state: "pending" }), false);
  assert.equal(amuxAnalysisViewReadable(view), true);
  const changed = { ...view, units: [unit("n1", view.units[0].proposal, "b".repeat(64)), ...view.units.slice(1)] };
  assert.notEqual(amuxAnalysisTranslationViewKey(view), amuxAnalysisTranslationViewKey(changed));
});

test("an empty or over-long page is refused before any call", () => {
  assert.deepEqual(checkAmuxTranslationSource([]), { ok: false, code: "empty" });
  const long = [{ id: "a", text: "x".repeat(AMUX_ANALYSIS_TRANSLATION_MAX_SOURCE_CHARS + 1) }];
  assert.deepEqual(checkAmuxTranslationSource(long), { ok: false, code: "too_large" });
  const many = Array.from({ length: 401 }, (_, index) => ({ id: `i${index}`, text: "x" }));
  assert.deepEqual(checkAmuxTranslationSource(many), { ok: false, code: "too_large" });
  assert.equal(checkAmuxTranslationSource([{ id: "a", text: "x" }]).ok, true);
});

test("the prompt keeps code, paths and numbers, and treats the text as data", () => {
  for (const phrase of ["code identifiers", "file paths", "commands", "numbers", "untrusted data"]) {
    assert.ok(AMUX_ANALYSIS_TRANSLATION_SYSTEM.includes(phrase), phrase);
  }
});

test("an answer is kept only when it translates exactly the asked ids once each", () => {
  const items = [{ id: "a", text: "One" }, { id: "b", text: "Two" }];
  assert.deepEqual(parseAmuxTranslationOutput({ items: [{ id: "b", ko: "둘" }, { id: "a", ko: "하나" }] }, items),
    { a: "하나", b: "둘" });
  for (const output of [
    null, [], { items: null },
    { items: [{ id: "a", ko: "하나" }] },
    { items: [{ id: "a", ko: "하나" }, { id: "a", ko: "하나" }] },
    { items: [{ id: "a", ko: "하나" }, { id: "c", ko: "셋" }] },
    { items: [{ id: "a", ko: "하나" }, { id: "b", ko: " " }] },
    { items: [{ id: "a", ko: "하나" }, { id: "b", ko: 2 }] },
    { items: [{ id: "a", ko: "하나" }, { id: "b", ko: "x".repeat(213) }] },
  ]) assert.equal(parseAmuxTranslationOutput(output, items), null, JSON.stringify(output));
});
