import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { CHAT_UNIFIED_OPTIMIZER_PURPOSE,
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerTerminalDigest } from
  "../../lib/chatUnifiedOptimizerLedgerCore.ts";

const root = resolve(import.meta.dirname, "..", "..");
const mod = path => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let calls = 0;
let recordOutcome = "recorded";
let cycle = null;
let readbackQuery = null;
let eligible = true;
let target = true;
let sourcePinAvailable = true;
const pin = { repositoryId: 123, commitSha: "1".repeat(40),
  blobSha: "2".repeat(40), sha256: "3".repeat(64) };

mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => authorized,
} });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body, status = 200) => Response.json(body,
    { status, headers: { "Cache-Control": "no-store" } }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async request => request.json(),
} });
mock.module(mod("lib/chatUnifiedOptimizerAmuxCandidateStore.ts"), {
  namedExports: {
    classifyChatUnifiedOptimizerAmuxCandidateAttempt: async () =>
      ({ eligible, target }),
    chatUnifiedOptimizerAmuxCandidateRequestId: () =>
      "11111111-1111-4111-8111-111111111111",
    recordChatUnifiedOptimizerAmuxCandidate: async () => {
      calls++;
      return recordOutcome === "recorded" ? { outcome: "recorded",
        cycleId: "22222222-2222-4222-8222-222222222222",
        completion: "write", proposalValidationReceipt: {
          resultSha256: "c".repeat(64),
          candidateDigest: "a".repeat(64), bundleDigest: "b".repeat(64),
        } } : { outcome: "stopped_for_readback", stage: "terminal",
          readbackOutcome: "readback_unavailable" };
    },
  },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  chatUnifiedOptimizerCycle: { findUnique: async query => {
    readbackQuery = query;
    return cycle && { ...cycle, runs: cycle.runs.filter(
      run => run.ordinal === query.select.runs.where.ordinal) };
  } },
} } });
mock.module(mod("lib/chatUnifiedOptimizerAmuxSourcePin.ts"), {
  namedExports: { readChatUnifiedOptimizerAmuxSourcePin: () => {
    if (!sourcePinAvailable) throw new Error("pin_unavailable");
    return pin;
  } },
});

const route = import(mod(
  "app/api/internal/chat-optimization/amux-candidate/route.ts"));
const eligibilityRoute = import(mod(
  "app/api/internal/chat-optimization/amux-candidate/eligibility/route.ts"));
const post = () => new Request(
  "https://tomverse.test/api/internal/chat-optimization/amux-candidate",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId: "33333333-3333-4333-8333-333333333333",
      sourcePin: pin }) });

test("AMUX candidate write stays closed without internal auth and explicit switch", async () => {
  const handler = await route;
  const previous = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
  try {
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = "enabled";
    assert.equal((await handler.POST(post())).status, 401);
    authorized = true;
    delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    const closed = await handler.POST(post());
    assert.equal(closed.status, 409);
    assert.equal((await closed.json()).reason, "amux_candidate_write_disabled");
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined)
      delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = previous;
  }
});

test("enabled route returns only candidate identity, and unknown write stops", async () => {
  const handler = await route;
  const previous = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
  try {
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = "enabled";
    authorized = true;
    const response = await handler.POST(post());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.authorshipVerified, false);
    assert.equal(body.candidateDigest, "a".repeat(64));
    assert.equal(body.resultSha256, "c".repeat(64));
    assert.equal(JSON.stringify(body).includes("resultText"), false);
    recordOutcome = "stopped";
    const stopped = await handler.POST(post());
    assert.equal(stopped.status, 503);
    assert.equal((await stopped.json()).status, "stopped_for_readback");
  } finally {
    if (previous === undefined)
      delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = previous;
  }
});

test("candidate write refuses a worker-selected source pin before recording", async () => {
  const handler = await route;
  const previous = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
  const before = calls;
  try {
    authorized = true;
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = "enabled";
    const request = new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: "33333333-3333-4333-8333-333333333333",
          sourcePin: { ...pin, sha256: "0".repeat(64) } }) });
    const response = await handler.POST(request);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "source_pin_mismatch");
    assert.equal(calls, before);
    sourcePinAvailable = false;
    assert.equal((await handler.POST(post())).status, 503);
    assert.equal(calls, before);
  } finally {
    sourcePinAvailable = true;
    if (previous === undefined)
      delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = previous;
  }
});

test("readback exposes only content-free candidate and author-job state", async () => {
  const handler = await route;
  const jobId = "44444444-4444-4444-8444-444444444444";
  const runId = "55555555-5555-4555-8555-555555555555";
  const claimRequestId = "11111111-1111-4111-8111-111111111111";
  const terminalRequestId = claimRequestId;
  const claimToken = "66666666-6666-4666-8666-666666666666";
  const evidenceRef = `optimizer:proposal-result:${"c".repeat(64)}`;
  const payloadDigest = "d".repeat(64);
  const terminalAuditLogId = "audit-1";
  cycle = { id: "22222222-2222-4222-8222-222222222222",
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    candidate: { id: "77777777-7777-4777-8777-777777777777",
      candidateDigest: "a".repeat(64),
      bundleDigest: "b".repeat(64), sourceCommitSha: pin.commitSha,
      sourceRepositoryId: BigInt(pin.repositoryId),
      sourceBlobSha: pin.blobSha, sourceSha256: pin.sha256 },
    runs: [{ id: runId, ordinal: 1, jobs: [{ id: jobId,
      role: "candidate_author", state: "succeeded",
      terminalOutcome: "succeeded", claimRequestId,
      claimRequestDigest: chatUnifiedOptimizerClaimDigest({
        requestId: claimRequestId, jobId }), claimToken,
      terminalRequestId,
      terminalRequestDigest: chatUnifiedOptimizerTerminalDigest({
        requestId: terminalRequestId, jobId, claimToken,
        outcome: "succeeded", evidenceRef,
        evidencePayloadDigest: payloadDigest }), terminalAuditLogId,
      evidence: { jobId, runId, cycleId:
        "22222222-2222-4222-8222-222222222222",
        candidateId: "77777777-7777-4777-8777-777777777777",
        outcome: "succeeded", evidenceRef, payloadDigest,
        terminalAuditLogId,
      } }] }] };
  const response = await handler.GET(new Request(
    "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
    "?attemptId=33333333-3333-4333-8333-333333333333"));
  assert.equal(response.status, 200);
  assert.equal(readbackQuery.select.runs.select.jobs.where.role,
    "candidate_author");
  assert.equal(readbackQuery.select.runs.where.ordinal, 1);
  const body = await response.json();
  assert.equal(body.status, "recorded");
  assert.equal(body.resultSha256, "c".repeat(64));
  assert.equal(body.authorshipVerified, false);
  assert.equal(JSON.stringify(body).includes("taskGuidance"), false);
  const originalRun = cycle.runs[0];
  cycle.runs = [originalRun, { ...originalRun, ordinal: 2, id: "later-run" }];
  const afterLaterRun = await handler.GET(new Request(
    "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
    "?attemptId=33333333-3333-4333-8333-333333333333"));
  assert.equal(afterLaterRun.status, 200);
  assert.equal((await afterLaterRun.json()).status, "recorded");
  cycle.runs = [originalRun];
  for (const runs of [
    [{ ...originalRun, ordinal: 2 }],
    [{ ...originalRun, jobs: [{ ...originalRun.jobs[0], role: "judge" }] }],
    [{ ...originalRun, jobs: [...originalRun.jobs,
      { ...originalRun.jobs[0], id: "extra-job" }] }],
  ]) {
    cycle.runs = runs;
    const stale = await handler.GET(new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
      "?attemptId=33333333-3333-4333-8333-333333333333"));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).status, "incomplete");
  }
  cycle.runs = [originalRun];
  const candidate = cycle.candidate;
  for (const changed of [
    { sourceRepositoryId: 124n },
    { sourceCommitSha: "4".repeat(40) },
    { sourceBlobSha: "5".repeat(40) },
    { sourceSha256: "6".repeat(64) },
    { sourceRepositoryId: null },
  ]) {
    cycle.candidate = { ...candidate, ...changed };
    const stale = await handler.GET(new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
      "?attemptId=33333333-3333-4333-8333-333333333333"));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).status, "incomplete");
  }
  cycle.candidate = candidate;
  const job = cycle.runs[0].jobs[0];
  const evidence = job.evidence;
  for (const changed of [
    { jobId: "88888888-8888-4888-8888-888888888888" },
    { runId: "88888888-8888-4888-8888-888888888888" },
    { cycleId: "88888888-8888-4888-8888-888888888888" },
    { candidateId: "88888888-8888-4888-8888-888888888888" },
    { terminalAuditLogId: "audit-other" },
  ]) {
    job.evidence = { ...evidence, ...changed };
    const stale = await handler.GET(new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
      "?attemptId=33333333-3333-4333-8333-333333333333"));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).status, "incomplete");
  }
  job.evidence = evidence;
  for (const changed of [
    { claimRequestDigest: "0".repeat(64) },
    { terminalRequestDigest: "0".repeat(64) },
    { terminalAuditLogId: null },
  ]) {
    Object.assign(job, changed);
    const stale = await handler.GET(new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
      "?attemptId=33333333-3333-4333-8333-333333333333"));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).status, "incomplete");
    Object.assign(job, {
      claimRequestDigest: chatUnifiedOptimizerClaimDigest({
        requestId: claimRequestId, jobId }),
      terminalRequestDigest: chatUnifiedOptimizerTerminalDigest({
        requestId: terminalRequestId, jobId, claimToken,
        outcome: "succeeded", evidenceRef,
        evidencePayloadDigest: payloadDigest }), terminalAuditLogId,
    });
  }
  sourcePinAvailable = false;
  try {
    const unavailable = await handler.GET(new Request(
      "https://tomverse.test/api/internal/chat-optimization/amux-candidate" +
      "?attemptId=33333333-3333-4333-8333-333333333333"));
    assert.equal(unavailable.status, 503);
  } finally { sourcePinAvailable = true; }
});

test("eligibility is metadata-only and closes on off switch or non-CHAT work", async () => {
  const handler = await eligibilityRoute;
  const request = () => new Request(
    "https://tomverse.test/api/internal/chat-optimization/amux-candidate/eligibility" +
    "?attemptId=33333333-3333-4333-8333-333333333333");
  const previous = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
  try {
    authorized = true;
    delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    assert.deepEqual(await (await handler.GET(request())).json(),
      { eligible: false, target: true,
        reason: "amux_candidate_write_disabled" });
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = "enabled";
    const live = await (await handler.GET(request())).json();
    assert.deepEqual(live.sourcePin, pin);
    eligible = false;
    const other = await (await handler.GET(request())).json();
    assert.deepEqual(other, { eligible: false, target: true,
      reason: "amux_candidate_attempt_ineligible" });
    target = false;
    sourcePinAvailable = false;
    assert.deepEqual(await (await handler.GET(request())).json(),
      { eligible: false });
  } finally {
    eligible = true;
    target = true;
    sourcePinAvailable = true;
    if (previous === undefined)
      delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE;
    else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE = previous;
  }
});
