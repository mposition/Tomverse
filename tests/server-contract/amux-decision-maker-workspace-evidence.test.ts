// The Decision Maker workspace's evidence (owner decision 2026-11-15,
// lib/amux/decisionMakerWorkspaceService.ts): each card kind's whole evidence
// files, the commit a T2 draft was made on, and -- the boundary -- a file the
// card points at that cannot be read is counted as left out, so the bridge
// sends nothing rather than a DM judging without it.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PATCH = `diff --git a/a.ts b/a.ts\n${"+x\n".repeat(4_000)}`;
let resultText: string | null = "The run's whole report.";
let criteria: string[] | null = ["The copy names the plan."];

mock.module(mod("lib/amux/v22TaskResultStore.ts"), { namedExports: {
  openAmuxV22TaskResultRow: async () => resultText,
  v22TaskResultIdeaId: () => "idea-1",
} });
mock.module(mod("lib/amux/v22ResultReviewService.ts"), { namedExports: {
  openCompletionCriteria: async () => criteria,
} });

const service = import(mod("lib/amux/decisionMakerWorkspaceService.ts"));

const sealed = {
  taskId: "t", sourceSnapshot: null, bodyCiphertext: new Uint8Array([1]), bodyKeyId: "k", bodyKeyVersion: 1,
  bodyDigest: "d", bodyDigestKeyId: "dk", attemptId: "a", resultIdeaId: "idea-1", ciphertext: new Uint8Array([1]),
  keyId: "k", keyVersion: 1, digest: "d", digestKeyId: "dk", sourceSha256: "s", bodyPurgedAt: null,
};

test("a T2 draft's workspace is its whole patch on the commit it was made on", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const evidence = (await openDecisionMakerWorkspaceEvidence({ kind: "t2_draft", patchBody: PATCH, baseSha: SHA }))!;
  assert.equal(evidence.targetSha, SHA);
  assert.deepEqual(evidence.files, [{ name: "PATCH.diff", text: PATCH }]);
  assert.deepEqual(evidence.excluded, {});
});

test("a settlement's and a result review's workspace hold the criteria and the whole report", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const review = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", ...sealed }))!;
  assert.deepEqual(review.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md"]);
  assert.equal(review.files[1].text, "The run's whole report.");
  assert.deepEqual(review.excluded, {});
  const pr = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr", pullPatch: PATCH, ...sealed }))!;
  assert.deepEqual(pr.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md", "PATCH.diff"]);
  // A stopped Task that never ran has no result row: nothing is missing.
  const never = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped", pullPatch: null,
    ...sealed, resultIdeaId: null }))!;
  assert.deepEqual(never.excluded, {});
});

test("evidence the card points at that cannot be read is left out, by count, so nothing is sent", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  assert.deepEqual((await openDecisionMakerWorkspaceEvidence({ kind: "t2_draft", patchBody: null, baseSha: null }))!.excluded,
    { unreadable: 1 });
  resultText = null;
  try {
    assert.deepEqual((await openDecisionMakerWorkspaceEvidence({ kind: "result_review", ...sealed }))!.excluded, { unreadable: 1 });
    criteria = null;
    assert.deepEqual((await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr", pullPatch: null,
      ...sealed }))!.excluded, { unreadable: 3 });
  } finally {
    resultText = "The run's whole report.";
    criteria = ["The copy names the plan."];
  }
});

test("the kill switch: no workspace at all, so the card goes alone", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  process.env.TOMVERSE_AMUX_DM_WORKSPACE = "disabled";
  try {
    assert.equal(await openDecisionMakerWorkspaceEvidence({ kind: "t2_draft", patchBody: PATCH, baseSha: SHA }), null);
  } finally {
    delete process.env.TOMVERSE_AMUX_DM_WORKSPACE;
  }
});
