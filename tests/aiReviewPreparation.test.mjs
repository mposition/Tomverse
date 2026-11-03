import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAiReviewPreparationCatalog } from "../lib/aiReviewPreparationServer.ts";
import {
  aiReviewCandidateProposal,
  aiReviewSampleProposal,
} from "../lib/aiReviewPreparation.ts";

test("candidate editor reads current decision candidates without changing any input", () => {
  const path = "docs/ops/ai-review-evaluation-set/decision-v2.json";
  const before = readFileSync(path);
  const catalog = readAiReviewPreparationCatalog();
  assert.deepEqual(catalog.problems, []);
  const set = catalog.sets.find((entry) => entry.file === "decision-v2.json");
  assert.equal(set.dataset.cases.length, 5);
  const source = set.dataset.cases[2];
  const proposal = aiReviewCandidateProposal(set, source, {
    question: "edited",
    responses: source.responses,
    notes: "pending necessity review",
  });
  assert.equal(proposal.decision, "pending");
  assert.equal(proposal.sourceDatasetDigest, set.digest);
  assert.equal(proposal.proposedCase.adoptedBy, null);
  assert.equal(source.question === "edited", false);
  assert.deepEqual(readFileSync(path), before);
});

test("sample proposals never carry old adoption or freeze signatures", () => {
  const set = readAiReviewPreparationCatalog().sets[0];
  const item = set.dataset.cases[0];
  set.dataset.frozenBy = "previous-reviewer";
  set.dataset.cases = [
    {
      ...item,
      status: "adopted",
      adoptedBy: "previous-reviewer",
      adoptedAt: "2026-01-01",
    },
  ];
  const draft = aiReviewSampleProposal(set, [item.id], "new-version");
  assert.equal(draft.dataset.frozenBy, null);
  assert.equal(draft.dataset.frozenDigest, null);
  assert.equal(draft.dataset.cases[0].status, "candidate");
  assert.equal(draft.dataset.cases[0].adoptedBy, null);
  assert.throws(() => aiReviewSampleProposal(set, [], "new"));
  assert.throws(() => aiReviewSampleProposal(set, [item.id, item.id], "new"));
  assert.throws(() => aiReviewSampleProposal(set, ["unknown"], "new"));
  assert.throws(() =>
    aiReviewSampleProposal(set, [item.id], set.dataset.version),
  );
});

test("malformed preparation input is reported, never presented as a valid candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-preparation-"));
  try {
    writeFileSync(
      join(dir, "bad.json"),
      '{"purpose":"decision","cases":[null]}',
    );
    const catalog = readAiReviewPreparationCatalog(dir);
    assert.equal(catalog.sets.length, 0);
    assert.ok(catalog.problems.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
