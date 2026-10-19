import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  acceptChatUnifiedOptimizerCandidateGenerationOutput,
  CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH,
  isChatUnifiedOptimizerCandidateGenerationResult,
  prepareChatUnifiedOptimizerCandidateGeneration,
} from "../lib/chatUnifiedOptimizerCandidateGeneration.ts";
import { CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE } from
  "../lib/chatUnifiedRouterRefinerPrompt.ts";

// Synthetic remote observations exercise the real Git blob verifier. They are
// neither a published-commit claim nor a live collector/model transport.
const text = readFileSync(new URL("./fixtures/chat-unified-optimizer/public-development-v1.json",
  import.meta.url), "utf8");
const bytes = Buffer.from(text);
const commitSha = "1".repeat(40);
const trees = [2, 3, 4, 5].map(n => String(n).repeat(40));
const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sourcePin = { repositoryId: 123, commitSha, blobSha,
  sha256: createHash("sha256").update(bytes).digest("hex") };
const proposal = { taskGuidance: CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE,
  publicExampleRefs: ["public:synthetic-format"] };
const failure = /optimizer_candidate_generation_unavailable/;

function setup() {
  const calls = [];
  const identity = { id: 123, fullName: "mposition/Tomverse", private: false,
    authenticated: false };
  const segments = CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH.split("/");
  const fileAdapter = {
    async readCommit(sha) {
      calls.push(["commit", sha]);
      return { repositoryId: 123, sha: commitSha, treeSha: trees[0] };
    },
    async readTree(sha) {
      calls.push(["tree", sha]);
      const index = trees.indexOf(sha);
      const last = index === segments.length - 1;
      return { repositoryId: 123, sha, truncated: false, entries: [{
        path: segments[index], type: last ? "blob" : "tree",
        mode: last ? "100644" : "040000", sha: last ? blobSha : trees[index + 1],
        size: last ? bytes.length : null,
      }] };
    },
    async readBlob(sha) {
      calls.push(["blob", sha]);
      return { repositoryId: 123, sha: blobSha, size: bytes.length, bytes };
    },
  };
  const collector = { async readRepository() { calls.push(["repository"]); return identity; },
    fileAdapter };
  return { calls, identity, collector, input: { requestId: randomUUID(),
    authorTaskId: randomUUID(), sourcePin, collector } };
}

test("candidate input requires exact public commit/tree/blob/bytes and stays non-authoritative", async () => {
  const fixture = setup();
  const request = await prepareChatUnifiedOptimizerCandidateGeneration(fixture.input);
  assert.equal(fixture.calls.filter(c => c[0] === "repository").length, 2);
  assert.deepEqual(fixture.calls.filter(c => c[0] === "commit"), [["commit", commitSha]]);
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(payload.publicExamples.length, 2);
  assert.equal(payload.source.path, CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH);
  assert.equal(request.dispatchAuthorized, false);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.messages[1]));
  const result = acceptChatUnifiedOptimizerCandidateGenerationOutput(request, JSON.stringify(proposal));
  assert.equal(result.bundle.candidate.publicExamples[0].sourceText,
    "Return exactly the word hello as plain text.");
  assert.equal(result.receipt.sourceBlobSha, blobSha);
  assert.equal(result.receipt.resultSha256,
    createHash("sha256").update(JSON.stringify(proposal)).digest("hex"));
  for (const key of ["authorshipVerified", "durableReceiptRecorded", "dispatchAuthorized",
    "runtimeAuthorized"]) assert.equal(result.receipt[key], false);
  assert.ok(Object.isFrozen(result.receipt));
  assert.equal(isChatUnifiedOptimizerCandidateGenerationResult(result), true);
  assert.equal(isChatUnifiedOptimizerCandidateGenerationResult(JSON.parse(JSON.stringify(result))), false);
});

test("private, authenticated, wrong repository and changed visibility never become public sources", async () => {
  for (const change of [{ private: true }, { authenticated: true },
    { fullName: "mposition/Private" }, { id: 456 }]) {
    const fixture = setup();
    Object.assign(fixture.identity, change);
    await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration(fixture.input), failure);
    assert.equal(fixture.calls.some(c => c[0] === "blob"), false);
  }
  const fixture = setup();
  let reads = 0;
  fixture.collector.readRepository = async () => ({ ...fixture.identity, private: ++reads > 1 });
  await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration(fixture.input), failure);
});

test("pin mismatch, branch names, unknown paths and forged blob contents fail before proposal use", async () => {
  for (const change of [{ commitSha: "develop" }, { sha256: "b".repeat(64) },
    { blobSha: "b".repeat(40) }, { path: "operator/cases.json" }]) {
    const fixture = setup();
    await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration({ ...fixture.input,
      sourcePin: { ...sourcePin, ...change } }), failure);
  }
  const fixture = setup();
  fixture.collector.fileAdapter.readBlob = async () => ({ repositoryId: 123, sha: blobSha,
    size: bytes.length, bytes: Buffer.alloc(bytes.length, 65) });
  await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration(fixture.input), failure);
});

test("candidate can select approved refs but cannot replace examples or widen controls", async () => {
  const request = await prepareChatUnifiedOptimizerCandidateGeneration(setup().input);
  for (const change of [{ publicExampleRefs: ["public:invented"] },
    { publicExampleRefs: ["public:synthetic-format", "public:synthetic-format"] },
    { publicExamples: [] }, { model: "another-model" }, { price: 0 },
    { gate: "accept" }, { hiddenCases: [] }, { answer: "changed" }]) {
    assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(request,
      JSON.stringify({ ...proposal, ...change })), failure);
  }
  const result = acceptChatUnifiedOptimizerCandidateGenerationOutput(request, JSON.stringify(proposal));
  assert.equal(result.bundle.candidate.publicExamples.length, 1);
});

test("only the branded request accepts the same raw proposal bytes", async () => {
  const request = await prepareChatUnifiedOptimizerCandidateGeneration(setup().input);
  assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(
    JSON.parse(JSON.stringify(request)), JSON.stringify(proposal)), failure);
  assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(request,
    '{"taskGuidance":"x","taskGuidance":"y","publicExampleRefs":[]}'), failure);
  const result = acceptChatUnifiedOptimizerCandidateGenerationOutput(request, JSON.stringify(proposal));
  assert.equal(acceptChatUnifiedOptimizerCandidateGenerationOutput(request,
    JSON.stringify(proposal)), result);
  assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(request,
    JSON.stringify(proposal, null, 2)), failure);
  assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(request,
    JSON.stringify({ ...proposal, taskGuidance: "another proposal" })), failure);
  assert.throws(() => acceptChatUnifiedOptimizerCandidateGenerationOutput(request, "x".repeat(65_537)), failure);
});

test("unknown collector outcome has no fallback source or second read attempt", async () => {
  const fixture = setup();
  fixture.collector.fileAdapter.readCommit = async () => { throw new Error("synthetic transport loss"); };
  await assert.rejects(prepareChatUnifiedOptimizerCandidateGeneration(fixture.input), failure);
  assert.deepEqual(fixture.calls, [["repository"]]);
});
