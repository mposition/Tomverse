import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHAT_UNIFIED_OPTIMIZER_CONTROLS } from
  "@/lib/chatUnifiedOptimizerCandidate";
import {
  CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH,
} from "@/lib/chatUnifiedOptimizerCandidateGeneration";
import {
  acceptChatUnifiedOptimizerCandidateGenerationOutputForStore,
  ChatUnifiedOptimizerCandidateGenerationLedgerError,
  prepareChatUnifiedOptimizerCandidateGenerationForStore,
  recordChatUnifiedOptimizerCandidateGeneration,
} from
  "@/lib/chatUnifiedOptimizerCandidateGenerationStore";
import {
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerRegistrationDigest,
  chatUnifiedOptimizerTerminalDigest,
} from "@/lib/chatUnifiedOptimizerLedgerCore";
import { CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE } from
  "@/lib/chatUnifiedRouterRefinerPrompt";

const sourceText = readFileSync(new URL(
  "../fixtures/chat-unified-optimizer/public-development-v1.json",
  import.meta.url), "utf8");
const sourceBytes = Buffer.from(sourceText);
const commitSha = "7".repeat(40);
const trees = [8, 9, 10, 11].map(value => value.toString(16).repeat(40));
const blobSha = createHash("sha1")
  .update(`blob ${sourceBytes.length}\0`).update(sourceBytes).digest("hex");
const sourcePin = { repositoryId: 321, commitSha, blobSha,
  sha256: createHash("sha256").update(sourceBytes).digest("hex") };

async function generation() {
  const segments = CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH.split("/");
  const collector = {
    async readRepository() {
      return { id: 321, fullName: "mposition/Tomverse", private: false,
        authenticated: false };
    },
    fileAdapter: {
      async readCommit() {
        return { repositoryId: 321, sha: commitSha, treeSha: trees[0] };
      },
      async readTree(sha) {
        const index = trees.indexOf(sha);
        const last = index === segments.length - 1;
        return { repositoryId: 321, sha, truncated: false, entries: [{
          path: segments[index], type: last ? "blob" : "tree",
          mode: last ? "100644" : "040000",
          sha: last ? blobSha : trees[index + 1],
          size: last ? sourceBytes.length : null,
        }] };
      },
      async readBlob() {
        return { repositoryId: 321, sha: blobSha,
          size: sourceBytes.length, bytes: sourceBytes };
      },
    },
  };
  const request = await prepareChatUnifiedOptimizerCandidateGenerationForStore({
    requestId: randomUUID(), authorTaskId: randomUUID(), sourcePin, collector,
  });
  return acceptChatUnifiedOptimizerCandidateGenerationOutputForStore(request,
    JSON.stringify({ taskGuidance: CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE,
      publicExampleRefs: ["public:synthetic-format"] }));
}

function fixture(result, overrides = {}) {
  const requestIds = { registration: randomUUID(), claim: randomUUID(),
    terminal: randomUUID() };
  const deadlineAt = new Date(Date.now() + 60_000);
  const jobIds = Object.fromEntries(["candidate_author", "case_author",
    "case_reviewer", "judge_primary", "judge_secondary", "coordinator"]
    .map(role => [role, randomUUID()]));
  const cycleId = randomUUID();
  const runId = randomUUID();
  const candidateId = randomUUID();
  const calls = [];
  const registrationDigest = chatUnifiedOptimizerRegistrationDigest({
    requestId: requestIds.registration,
    candidateDigest: result.bundle.candidateDigest,
    bundleDigest: result.bundle.bundleDigest,
    controlsDigest: result.bundle.candidate.controlsDigest,
    schemaVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.schemaVersion,
    promptVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.promptVersion,
    stageCandidateDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.stageCandidateDigest,
    adapterConfigDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.adapterConfigDigest,
    pricePinDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.pricePinDigest,
    sourceCommitSha: result.receipt.sourceCommitSha, deadlineAt,
    sourceRepositoryId: result.receipt.sourceRepositoryId,
    sourceBlobSha: result.receipt.sourceBlobSha,
    sourceSha256: result.receipt.sourceSha256,
  });
  const claimToken = randomUUID();
  const claimDigest = chatUnifiedOptimizerClaimDigest({
    requestId: requestIds.claim, jobId: jobIds.candidate_author,
  });
  const base = {
    async register(input) {
      calls.push(["register", input]);
      return { outcome: "created", cycleId, runId, candidateId, jobIds,
        registrationDigest, deadlineAt };
    },
    async readRegistration(input) {
      calls.push(["readRegistration", input]);
      return { outcome: "committed", cycleId, runId, candidateId,
        state: "active", deadlineAt };
    },
    async claim(input) {
      calls.push(["claim", input]);
      return { outcome: "claimed", jobId: jobIds.candidate_author,
        role: "candidate_author", claimToken, claimDigest, deadlineAt,
        claimedAt: new Date() };
    },
    async readClaim(input) {
      calls.push(["readClaim", input]);
      return { outcome: "committed", jobId: jobIds.candidate_author,
        role: "candidate_author", state: "claimed", claimToken, deadlineAt,
        claimedAt: new Date() };
    },
    async readClaimCheckpoint(input) {
      calls.push(["readClaimCheckpoint", input]);
      return null;
    },
    async terminal(input) {
      calls.push(["terminal", input]);
      return { outcome: "recorded", jobId: jobIds.candidate_author,
        terminalOutcome: "succeeded",
        terminalDigest: chatUnifiedOptimizerTerminalDigest(input),
        terminalAt: new Date(), runState: "active", cycleState: "active" };
    },
    async readTerminal(input) {
      calls.push(["readTerminal", input]);
      return { outcome: "committed", jobId: jobIds.candidate_author,
        terminalOutcome: "succeeded", terminalAt: new Date(),
        evidenceRef: "optimizer:synthetic",
        evidencePayloadDigest: "a".repeat(64) };
    },
  };
  return { requestIds, deadlineAt, calls, registrationDigest, claimDigest,
    ledger: { ...base, ...overrides }, jobIds, claimToken, cycleId, runId };
}

test("branded generation records only fixed proposal validation evidence", async () => {
  const result = await generation();
  const f = fixture(result);
  const stored = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.equal(stored.outcome, "recorded");
  assert.equal(stored.completion, "write");
  assert.deepEqual(f.calls.map(call => call[0]),
    ["register", "readClaimCheckpoint", "claim", "terminal"]);
  const terminal = f.calls[3][1];
  assert.match(terminal.evidenceRef,
    /^optimizer:proposal-result:[0-9a-f]{64}$/);
  assert.match(terminal.evidencePayloadDigest, /^[0-9a-f]{64}$/);
  assert.equal(terminal.outcome, "succeeded");
  assert.equal(stored.proposalValidationReceipt.authorshipVerified, false);
  assert.equal(f.calls[0][1].sourceRepositoryId,
    result.receipt.sourceRepositoryId);
  assert.equal(f.calls[0][1].sourceBlobSha, result.receipt.sourceBlobSha);
  assert.equal(f.calls[0][1].sourceSha256, result.receipt.sourceSha256);
  assert.equal(stored.proposalValidationReceipt.authorExecutionObserved, false);
  assert.equal(stored.proposalValidationReceipt.externalDispatchAuthorized, false);
  assert.equal(stored.proposalValidationReceipt.proposalValidationEvidenceRecorded,
    true);
  assert.equal(result.receipt.durableReceiptRecorded, false);
  assert.equal(JSON.stringify(terminal).includes("Return exactly"), false);
});

test("a cloned generation result cannot register or claim anything", async () => {
  const result = await generation();
  const f = fixture(result);
  await assert.rejects(recordChatUnifiedOptimizerCandidateGeneration({
    generation: structuredClone(result), requestIds: f.requestIds,
    deadlineAt: f.deadlineAt,
  }, f.ledger), /optimizer_candidate_generation_store_unavailable/);
  assert.deepEqual(f.calls, []);
});

test("unknown registration reads once and stops before claim", async () => {
  const result = await generation();
  const f = fixture(result, { async register(input) {
    f.calls.push(["register", input]);
    throw new Error("synthetic_unknown");
  } });
  const stopped = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.deepEqual(f.calls.map(call => call[0]),
    ["register", "readRegistration"]);
  assert.equal(stopped.outcome, "stopped_for_readback");
  assert.equal(stopped.stage, "registration");
  assert.equal(stopped.readbackOutcome, "committed");
});

test("unknown claim reads once and never writes terminal evidence", async () => {
  const result = await generation();
  const f = fixture(result, { async claim(input) {
    f.calls.push(["claim", input]);
    throw new Error("synthetic_unknown");
  } });
  const stopped = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.deepEqual(f.calls.map(call => call[0]),
    ["register", "readClaimCheckpoint", "claim", "readClaim"]);
  assert.equal(stopped.outcome, "stopped_for_readback");
  assert.equal(stopped.stage, "claim");
  assert.equal(stopped.readbackOutcome, "committed");
});

test("an exact committed terminal readback completes without a second write", async () => {
  const result = await generation();
  const f = fixture(result, { async terminal(input) {
    f.calls.push(["terminal", input]);
    throw new Error("synthetic_unknown");
  } });
  const stored = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.deepEqual(f.calls.map(call => call[0]),
    ["register", "readClaimCheckpoint", "claim", "terminal", "readTerminal"]);
  assert.equal(stored.outcome, "recorded");
  assert.equal(stored.completion, "readback");
});

test("a durable claim checkpoint replays terminal without a second claim", async () => {
  const result = await generation();
  const f = fixture(result);
  f.ledger.readClaimCheckpoint = async input => {
    f.calls.push(["readClaimCheckpoint", input]);
    return { cycleId: f.cycleId, runId: f.runId,
      jobId: f.jobIds.candidate_author, role: "candidate_author",
      state: "succeeded", claimToken: f.claimToken,
      deadlineAt: f.deadlineAt, claimedAt: new Date() };
  };
  const stored = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.equal(stored.outcome, "recorded");
  assert.equal(stored.completion, "write");
  assert.deepEqual(f.calls.map(call => call[0]),
    ["register", "readClaimCheckpoint", "terminal"]);
});

test("unknown readback remains stopped and known ledger refusals are not relabelled", async () => {
  const result = await generation();
  const f = fixture(result, {
    async terminal(input) {
      f.calls.push(["terminal", input]);
      throw new Error("synthetic_unknown");
    },
    async readTerminal(input) {
      f.calls.push(["readTerminal", input]);
      throw new Error("synthetic_read_unknown");
    },
  });
  const stopped = await recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: f.requestIds, deadlineAt: f.deadlineAt,
  }, f.ledger);
  assert.equal(stopped.outcome, "stopped_for_readback");
  assert.equal(stopped.stage, "terminal");
  assert.equal(stopped.readbackOutcome, "readback_unavailable");

  const known = fixture(result, { async register(input) {
    known.calls.push(["register", input]);
    throw new ChatUnifiedOptimizerCandidateGenerationLedgerError(
      "active_cycle_exists");
  } });
  await assert.rejects(recordChatUnifiedOptimizerCandidateGeneration({
    generation: result, requestIds: known.requestIds,
    deadlineAt: known.deadlineAt,
  }, known.ledger), (error) =>
    error instanceof ChatUnifiedOptimizerCandidateGenerationLedgerError &&
    error.code === "active_cycle_exists");
  assert.deepEqual(known.calls.map(call => call[0]), ["register"]);
});
