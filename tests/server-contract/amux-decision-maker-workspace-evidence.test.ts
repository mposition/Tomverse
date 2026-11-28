// The Decision Maker workspace's evidence (owner decision 2026-11-15,
// lib/amux/decisionMakerWorkspaceService.ts): each card kind's whole evidence
// files, the commit a T2 draft was made on, and -- the boundary -- a file the
// card points at that cannot be read is counted as left out, so the bridge
// sends nothing rather than a DM judging without it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PATCH = `diff --git a/a.ts b/a.ts\n${"+x\n".repeat(4_000)}`;
let resultText: string | null = "The run's whole report.";
let criteria: string[] | null = ["The copy names the plan."];

let runPatchText: string | null = PATCH;
mock.module(mod("lib/amux/v22TaskResultStore.ts"), { namedExports: {
  openAmuxV22TaskResultRow: async () => resultText,
  openAmuxV22TaskPatchRow: async () => runPatchText,
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

// A dependency card's title as the content store opens it; null when it cannot.
let dependencyTitle: string | null = "Audit /pricing copy";
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxCardTitle: async () => dependencyTitle,
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

// 2026-11-22 (AMUX-PUBLIC-004): a card run's settlement carried the rejections
// but not the change they were about, so the DM could not check them.
test("a card run's settlement and result review carry the run's change on the commit it was made on", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const BASE = "89abcdef0123456789abcdef0123456789abcdef";
  const runPatch = { ideaId: "idea-1", keyId: "k", keyVersion: 1, digest: "d", digestKeyId: "dk",
    bodyPurgedAt: null, patchSha256: "p", baseSha: BASE };
  const stopped = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped",
    pullPatch: null, runPatch, reviews: [], ...sealed }))!;
  assert.deepEqual(stopped.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md", "PATCH.diff"]);
  assert.equal(stopped.files[2].text, PATCH, "whole");
  assert.equal(stopped.targetSha, BASE, "repo/ is the commit the change was made on, so repo-patched/ applies");
  assert.deepEqual(stopped.excluded, {});
  const review = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", runPatch, ...sealed }))!;
  assert.deepEqual(review.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md", "PATCH.diff"]);
  assert.equal(review.targetSha, BASE);
  // A review PR's settlement keeps its pull request's patch and nothing else.
  const pr = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr", pullPatch: "pull",
    runPatch, reviews: [], ...sealed }))!;
  assert.deepEqual(pr.files.filter((file: { name: string }) => file.name === "PATCH.diff").map((file: { text: string }) => file.text), ["pull"]);
  assert.equal(pr.targetSha, null);
  // A run that left no change, or one that can no longer be opened: no file, develop's head, and the request still goes.
  const none = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "stopped",
    pullPatch: null, runPatch: null, reviews: [], ...sealed }))!;
  assert.deepEqual([none.files.map((file: { name: string }) => file.name), none.targetSha, none.excluded],
    [["CRITERIA.md", "FINDINGS.md"], null, {}]);
  runPatchText = null;
  try {
    const purged = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", runPatch, ...sealed }))!;
    assert.deepEqual([purged.files.map((file: { name: string }) => file.name), purged.targetSha, purged.excluded],
      [["CRITERIA.md", "FINDINGS.md"], null, {}]);
  } finally {
    runPatchText = PATCH;
  }
});

// 2026-11-28 (AMUX-PUBLIC-004): its criteria named AMUX-PUBLIC-002's list, and
// the DM handed the review PR to a person because that list was not there.
test("a settlement's and a result review's workspace hold the cards the Task depends on, with their results, as CONTEXT.md", async () => {
  const { openDecisionMakerWorkspaceEvidence } = await service;
  const dependency = (label: string, status: string, attemptId: string | null) => ({
    id: `id-${label}`, label, status, cardTitle: "AMUX Task", sourceSystem: "admin-idea-v4", sourceSnapshot: null,
    v4TitleCiphertext: null, v4TitleKeyId: null, v4TitleKeyVersion: null, v4TitleDigest: null, v4TitleDigestKeyId: null,
    attemptId, resultIdeaId: attemptId ? "idea-1" : null, keyId: "k", keyVersion: 1, digest: "d", digestKeyId: "dk",
    sourceSha256: "s", bodyPurgedAt: null,
  });
  const list = "| key | fix |\n|---|---|\n" + "| pricing.copy.x | say y |\n".repeat(5_000);
  resultText = list;
  try {
    const pr = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr",
      pullPatch: PATCH, reviews: [], ...sealed,
      dependencies: [dependency("AMUX-PUBLIC-002", "done", "a2"), dependency("AMUX-PUBLIC-009", "backlog", null)] }))!;
    assert.deepEqual(pr.files.map((file: { name: string }) => file.name),
      ["CRITERIA.md", "FINDINGS.md", "PATCH.diff", "CONTEXT.md"]);
    const context = pr.files.find((file: { name: string }) => file.name === "CONTEXT.md")!.text;
    assert.ok(context.startsWith("# The cards this Task depends on\n"), "it says what it is");
    assert.ok(context.includes(`## AMUX-PUBLIC-002 (done): Audit /pricing copy\n\n${list}`), "the newest result, whole");
    assert.ok(context.includes("## AMUX-PUBLIC-009 (backlog): Audit /pricing copy\n\n(This card has no run result that could be read.)"));
    assert.deepEqual(pr.excluded, {});
    // A result review gets the same file; a title that cannot be opened leaves the label alone.
    dependencyTitle = null;
    const review = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", ...sealed,
      dependencies: [dependency("AMUX-PUBLIC-002", "done", "a2")] }))!;
    assert.match(review.files.at(-1)!.text, /^## AMUX-PUBLIC-002 \(done\)\n/m);
    // A dependency's result that cannot be opened is shown as such and stops nothing.
    resultText = null;
    const unread = (await openDecisionMakerWorkspaceEvidence({ kind: "settlement", settlementKind: "t2_pr",
      pullPatch: PATCH, reviews: [], ...sealed, resultIdeaId: null, dependencies: [dependency("AMUX-PUBLIC-002", "done", "a2")] }))!;
    assert.match(unread.files.at(-1)!.text, /no run result that could be read/);
    assert.deepEqual(unread.excluded, {}, "the card does not point at it, so nothing is missing");
  } finally {
    resultText = "The run's whole report.";
    dependencyTitle = "Audit /pricing copy";
  }
  // No dependencies, no file: the files the card names, as before.
  const none = (await openDecisionMakerWorkspaceEvidence({ kind: "result_review", ...sealed, dependencies: [] }))!;
  assert.deepEqual(none.files.map((file: { name: string }) => file.name), ["CRITERIA.md", "FINDINGS.md"]);
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

// ---------------------------------------------------------------------------
// The evidence in chunks (docs/policy/amux-v22-result-transfer.md 10.2)
// ---------------------------------------------------------------------------

const sha256Of = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("the older route keeps its 64 MiB; the parts route has no bound: a patch past it is described whole", async () => {
  const { openDecisionMakerWorkspaceEvidence, describeDecisionMakerWorkspaceEvidence } = await service;
  const line = "+a line of a patch far past the old evidence cap\n";
  const huge = `diff --git a/a b/a\n${line.repeat(Math.ceil((64 * 1024 * 1024 + 1024 * 1024) / line.length))}`;
  const source = { kind: "t2_draft" as const, patchBody: huge, baseSha: SHA };
  const inline = (await openDecisionMakerWorkspaceEvidence(source, { inline: true }))!;
  const whole = (await openDecisionMakerWorkspaceEvidence(source))!;
  // The older route leaves the file out (a relay built around 64 MiB sends nothing); the parts route does not.
  assert.deepEqual([inline.files, inline.excluded], [[], { too_large: 1 }]);
  assert.deepEqual(whole.files.map((file: { name: string }) => file.name), ["PATCH.diff"]);
  assert.equal(whole.files[0].text.length, huge.length);
  const described = (await describeDecisionMakerWorkspaceEvidence(source))!;
  assert.deepEqual(described.parts, [{
    name: "PATCH.diff",
    bytes: Buffer.byteLength(huge),
    sha256: sha256Of(huge),
    blob: createHash("sha1").update(`blob ${Buffer.byteLength(huge)}\0`).update(huge, "utf8").digest("hex"),
  }]);
  assert.equal(described.targetSha, SHA);
  assert.deepEqual(described.excluded, {});
  // Evidence the card points at that cannot be read is still counted, so nothing is sent.
  assert.deepEqual((await describeDecisionMakerWorkspaceEvidence({ kind: "t2_draft", patchBody: null, baseSha: null }))!.excluded,
    { unreadable: 1 });
});

test("a chunk is the file's own bytes at the transfer's range, and the file is checked whole before any of it is served", async () => {
  const { readDecisionMakerWorkspaceChunk } = await service;
  const { AMUX_V22_TRANSFER_CHUNK_BYTES } = await import(mod("lib/amux/v22TransferCore.ts"));
  const line = "+a line of the patch\n";
  const patch = `diff --git a/a b/a\n${line.repeat(Math.ceil((AMUX_V22_TRANSFER_CHUNK_BYTES * 2 + 1000) / line.length))}`;
  const total = Buffer.byteLength(patch);
  const sha256 = sha256Of(patch);
  let loads = 0;
  const load = async () => { loads += 1; return { kind: "t2_draft" as const, patchBody: patch, baseSha: SHA }; };
  const ask = (index: number, extra: Record<string, unknown> = {}) =>
    readDecisionMakerWorkspaceChunk({ requestId: "r-1", name: "PATCH.diff", sha256, index, ...extra } as never, load);
  const chunks = [];
  for (let index = 0; index < 3; index += 1) {
    const chunk = await ask(index);
    assert.equal(chunk.ok, true);
    chunks.push(chunk);
  }
  const ok = chunks as Array<{ ok: true; totalBytes: number; chunkCount: number; bytes: Buffer }>;
  assert.deepEqual(ok.map((chunk) => [chunk.totalBytes, chunk.chunkCount]), [[total, 3], [total, 3], [total, 3]]);
  assert.deepEqual(ok.map((chunk) => chunk.bytes.length), [AMUX_V22_TRANSFER_CHUNK_BYTES, AMUX_V22_TRANSFER_CHUNK_BYTES, total - 2 * AMUX_V22_TRANSFER_CHUNK_BYTES]);
  assert.equal(sha256Of(Buffer.concat(ok.map((chunk) => chunk.bytes)).toString("utf8")), sha256, "the chunks are the file, whole");
  // The source was opened and the file checked once; the chunks after the first are served from what passed.
  assert.equal(loads, 1);
  // Past the last chunk, another file's name, a file that has changed, a source with no such file: none is served.
  assert.deepEqual(await ask(3), { ok: false, reason: "index_out_of_range" });
  assert.deepEqual(await ask(-1), { ok: false, reason: "index_out_of_range" });
  assert.deepEqual(await readDecisionMakerWorkspaceChunk({ requestId: "r-1", name: "x.sh", sha256, index: 0 }, load),
    { ok: false, reason: "evidence_absent" });
  assert.deepEqual(await readDecisionMakerWorkspaceChunk({ requestId: "r-2", name: "FINDINGS.md", sha256, index: 0 }, load),
    { ok: false, reason: "evidence_absent" });
  assert.deepEqual(await readDecisionMakerWorkspaceChunk({ requestId: "r-3", name: "PATCH.diff", sha256: "f".repeat(64), index: 0 }, load),
    { ok: false, reason: "evidence_changed" });
  assert.deepEqual(await readDecisionMakerWorkspaceChunk({ requestId: "r-4", name: "PATCH.diff", sha256, index: 0 }, async () => null),
    { ok: false, reason: "request_unknown" });
});

test("a chunk is never served from a file the whole-file checks refuse: a secret late in a large patch", async () => {
  const { readDecisionMakerWorkspaceChunk } = await service;
  const token = ["gh", "p_", "Q".repeat(36)].join("");
  const line = "+a line of the patch\n";
  const patch = `diff --git a/a b/a\n${line.repeat(400_000)}+${token}\n`;
  const result = await readDecisionMakerWorkspaceChunk(
    { requestId: "r-secret", name: "PATCH.diff", sha256: sha256Of(patch), index: 0 },
    async () => ({ kind: "t2_draft" as const, patchBody: patch, baseSha: SHA }),
  );
  assert.deepEqual(result, { ok: false, reason: "evidence_absent" });
});

test("the bytes one process checked are held for two minutes for one file, and not past them", async () => {
  const { readDecisionMakerWorkspaceChunk } = await service;
  const patch = `diff --git a/a b/a\n${"+held line\n".repeat(1000)}`;
  const sha256 = sha256Of(patch);
  let loads = 0;
  const load = async () => { loads += 1; return { kind: "t2_draft" as const, patchBody: patch, baseSha: SHA }; };
  let now = 1_000_000;
  const clock = () => now;
  const ask = (requestId: string) => readDecisionMakerWorkspaceChunk({ requestId, name: "PATCH.diff", sha256, index: 0 }, load, clock);
  assert.equal((await ask("held")).ok, true);
  assert.equal((await ask("held")).ok, true);
  assert.equal(loads, 1, "a hit opens nothing");
  // Another request replaces the one entry; the first must be opened again.
  assert.equal((await ask("other")).ok, true);
  assert.equal((await ask("held")).ok, true);
  assert.equal(loads, 3);
  now += 2 * 60 * 1000 + 1;
  assert.equal((await ask("held")).ok, true);
  assert.equal(loads, 4, "an expired entry is opened and checked again");
});

test("the held bytes are dropped when the two minutes end, with no later request to notice", async (t) => {
  const { readDecisionMakerWorkspaceChunk } = await service;
  const patch = `diff --git a/a b/a\n${"+held line\n".repeat(1000)}`;
  const sha256 = sha256Of(patch);
  let loads = 0;
  const load = async () => { loads += 1; return { kind: "t2_draft" as const, patchBody: patch, baseSha: SHA }; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The default clock is the real one, so only the timer can have emptied the hold.
  const ask = () => readDecisionMakerWorkspaceChunk({ requestId: "timer", name: "PATCH.diff", sha256, index: 0 }, load);
  assert.equal((await ask()).ok, true);
  assert.equal((await ask()).ok, true);
  assert.equal(loads, 1, "held");
  t.mock.timers.tick(2 * 60 * 1000 - 1);
  assert.equal((await ask()).ok, true);
  assert.equal(loads, 1, "still held just before the end");
  t.mock.timers.tick(2);
  assert.equal((await ask()).ok, true);
  assert.equal(loads, 2, "dropped by the timer, then opened and checked again");
});
