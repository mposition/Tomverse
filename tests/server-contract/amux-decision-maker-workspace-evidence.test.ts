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
// The rejected reviews as the store opens them (the sealed bodies are the DB
// suite's): rows in, the readable entries and the unread count out.
let reviewed: { entries: unknown[]; unread: number } = { entries: [], unread: 0 };
mock.module(mod("lib/amux/v52ReviewFindingsStore.ts"), { namedExports: {
  readAmuxV52RejectedReviews: async () => [],
  openAmuxV52RejectedReviewEntries: async (rows: unknown[]) => rows.length === 0 ? { entries: [], unread: 0 } : reviewed,
} });

const service = import(mod("lib/amux/decisionMakerWorkspaceService.ts"));
const settlementCore = import(mod("lib/amux/dmOwnerSettlementCore.ts"));
const findingsCore = import(mod("lib/amux/v52ReviewFindingsCore.ts"));

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

test("a v22 question's workspace holds what the worker found, whole, as CONTEXT.md", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const { AMUX_V22_OWNER_QUESTION_MARKER } = await import(mod("lib/amux/v22OwnerQuestionCore.ts"));
  const found = "The retry path loses the error. ".repeat(20_000).trim();
  const result = { attemptId: sealed.attemptId, resultIdeaId: sealed.resultIdeaId, ciphertext: sealed.ciphertext,
    keyId: sealed.keyId, keyVersion: sealed.keyVersion, digest: sealed.digest, digestKeyId: sealed.digestKeyId,
    sourceSha256: sealed.sourceSha256, bodyPurgedAt: sealed.bodyPurgedAt };
  resultText = `Work so far.\n${AMUX_V22_OWNER_QUESTION_MARKER} ${JSON.stringify({ question: "Which path?",
    unblocks: "the fix", options: [{ id: "a", label: "A" }], context: found })}`;
  try {
    const asked = (await openDecisionMakerWorkspaceEvidence({ kind: "v22_question", ...result }))!;
    assert.equal(asked.targetSha, null, "develop's public head");
    assert.deepEqual(asked.files, [{ name: "CONTEXT.md", text: found }], "far past the card's 256 KiB, whole");
    assert.deepEqual(asked.excluded, {});
    // A question with no context has no file, and nothing is missing.
    resultText = `${AMUX_V22_OWNER_QUESTION_MARKER} ${JSON.stringify({ question: "Which?", unblocks: "u", options: [] })}`;
    const bare = (await openDecisionMakerWorkspaceEvidence({ kind: "v22_question", ...result }))!;
    assert.deepEqual([bare.files, bare.excluded], [[], {}]);
    // Its run's result cannot be opened: the card's evidence is missing, so nothing is sent.
    resultText = null;
    assert.deepEqual((await openDecisionMakerWorkspaceEvidence({ kind: "v22_question", ...result }))!.excluded, { unreadable: 1 });
  } finally {
    resultText = "The run's whole report.";
  }
});

test("a settlement's and a result review's workspace hold the criteria and the whole report", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const review = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", ...sealed }))!;
  assert.deepEqual(review.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md"]);
  assert.equal(review.files[1].text, "The run's whole report.");
  assert.deepEqual(review.excluded, {});
  const pr = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr", pullPatch: PATCH,
    reviews: [], ...sealed }))!;
  assert.deepEqual(pr.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md", "PATCH.diff"]);
  // A stopped Task that never ran has no result row: nothing is missing.
  const never = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped", pullPatch: null,
    reviews: [], ...sealed, resultIdeaId: null }))!;
  assert.deepEqual(never.excluded, {});
});

test("a settlement's FINDINGS.md is the run's report, then every rejected review's findings, whole: the card's own text", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const { amuxDmOwnerSettlementCard, amuxDmOwnerSettlementFindingsText } = await settlementCore;
  const { normalizeAmuxV52FindingsDoc } = await findingsCore;
  const run = (attemptNumber: number, count: number) => ({ attemptNumber, doc: normalizeAmuxV52FindingsDoc({ version: 1,
    reviewers: [{ vendor: "openai", verdict: "reject", findings: Array.from({ length: count }, (_, index) => ({
      severity: "major", file: `lib/r${attemptNumber}.ts`, line: index + 1, summary: `Finding ${attemptNumber}.${index}` })) }] })! });
  // Five readable rejections and one that is not: far past the old
  // 4,000-character card context and its three-rejection read.
  reviewed = { entries: [5, 4, 3, 2, 1].map((attempt) => run(attempt, 300)), unread: 1 };
  const rows = Array.from({ length: 6 }, () => ({})) as never;
  try {
    const stopped = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped", pullPatch: null,
      reviews: rows, ...sealed }))!;
    assert.deepEqual(stopped.excluded, {});
    const findings = stopped.files.find((file: { name: string }) => file.name === "FINDINGS.md")!.text;
    const expected = amuxDmOwnerSettlementFindingsText({ report: "The run's whole report.", reviews: reviewed as never })!;
    assert.equal(findings, expected);
    assert.ok(findings.startsWith("The run's whole report.\n\n## Independent review findings\n"));
    for (const attempt of [5, 4, 3, 2, 1]) assert.ok(findings.includes(`Finding ${attempt}.299`), `attempt ${attempt} is whole`);
    assert.match(findings, /\(1 more rejection of this Task left no findings that could be read/);
    assert.doesNotMatch(findings, /not shown here/);
    // The card filed from the same rows points at that file (the workspace is always on, 2026-11-16).
    const card = amuxDmOwnerSettlementCard({ settlementId: "s", kind: "stopped", taskLabel: "T-1", title: null, role: null,
      grade: null, taskStatus: "blocked", reason: null, criteria: ["c"], findings: "The run's whole report.", rejections: 6,
      reviews: reviewed as never, siblings: [], siblingTotal: 0, pull: null })!;
    assert.match(card.context, /evidence\/FINDINGS\.md/);
    // A Task that never ran but was rejected: the findings alone, and nothing is missing.
    const never = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped", pullPatch: null,
      reviews: rows, ...sealed, resultIdeaId: null }))!;
    assert.deepEqual(never.excluded, {});
    assert.ok(never.files.find((file: { name: string }) => file.name === "FINDINGS.md")!.text
      .startsWith("## Independent review findings\n"));
    // A report that exists but cannot be opened is still missing, whatever the reviews say.
    resultText = null;
    assert.deepEqual((await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped", pullPatch: null,
      reviews: rows, ...sealed }))!.excluded, { unreadable: 1 });
  } finally {
    reviewed = { entries: [], unread: 0 };
    resultText = "The run's whole report.";
  }
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
      reviews: [], ...sealed }))!.excluded, { unreadable: 3 });
  } finally {
    resultText = "The run's whole report.";
    criteria = ["The copy names the plan."];
  }
});

test("there is no kill switch: the old variable does not turn the workspace off (owner direction 2026-11-16)", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  process.env.TOMVERSE_AMUX_DM_WORKSPACE = "disabled";
  try {
    const evidence = await openDecisionMakerWorkspaceEvidence({ kind: "t2_draft", patchBody: PATCH, baseSha: SHA });
    assert.notEqual(evidence, null);
    assert.deepEqual(evidence!.files.map((file: { name: string }) => file.name), ["PATCH.diff"]);
  } finally {
    delete process.env.TOMVERSE_AMUX_DM_WORKSPACE;
  }
});
