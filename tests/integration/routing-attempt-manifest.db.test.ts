import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  DispatchBoundaryError,
  abandonDraft,
  closeAttempt,
  createDraftManifest,
  dispatchedAttemptManifestCoverage,
  finalizeManifest,
  markDispatched,
  openAttempt,
  successfulFallbackCandidateManifestCoverage,
} from "@/lib/routingAttemptStore";

// The dispatch boundary (docs/policy/tomverse-chat-routing.md §5, ROUTE-06).
//
// Every assertion here is against the *database*, not against the store. The
// store owns the order -- draft, finalize, dispatch -- and the constraints own
// the rules, so each test tries to write the forbidden state directly and
// requires Postgres to refuse it. A rule only the application enforces is a
// rule the next caller can skip.

const reset = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "RoutingRun" RESTART IDENTITY CASCADE`);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const newRun = async () => {
  const run = await prisma.routingRun.create({
    data: {
      mode: "shadow",
      traceId: `trace-${randomUUID()}`,
      subjectKey: `subject-${randomUUID()}`,
      plan: "Pro",
      taskProfileVersion: "task-profile-v1",
      candidateFilterVersion: "router-candidates-v1",
      selectionVersion: "router-selection-v1",
      estimatorVersion: "generic_multilingual_v1",
      profileKind: "coding",
      profileConfidence: "strong",
      needsCurrentInformation: false,
      hasImageInput: false,
      hasDocumentInput: false,
      expectedOutputLength: "medium",
      estimatedInputTokens: 1_000,
      reservedInputTokens: 1_200,
      requestOutputCapTokens: 4_000,
      eligibleCount: 2,
      rejectedByReason: {},
      selectedModelId: "gpt-5-6-luna",
      selectionReason: "task_preference",
      selectionMargin: 3,
      userSelectedModelId: "gpt-5-6-luna",
      decisionMicros: 900,
    },
    select: { id: true },
  });
  return run.id;
};

const newAttempt = async (runId: string, attemptIndex = 0) =>
  openAttempt({ runId, attemptIndex, modelId: "gpt-5-6-luna", provider: "openai" });

const newDraft = (attemptId: string, overrides: Record<string, unknown> = {}) =>
  createDraftManifest({
    attemptId,
    sourceRefs: [{ kind: "message", id: "m1", hash: "h1" }],
    tokenizerVersion: "o200k_base",
    tokenCount: 1_100,
    contextWindowTokens: 128_000,
    ...overrides,
  });

const finalize = (attemptId: string, now?: Date) =>
  finalizeManifest({
    attemptId,
    plannerVersion: "planner-v1",
    adapterVersion: "adapter-v1",
    effectiveRequestHash: `hash-${randomUUID()}`,
    contentHashVersion: "manifest-content-v1",
    hashAlgorithm: "hmac-sha256",
    hashKeyId: "test-key",
    now,
  });

// One logical response, three attempts, each with its own model, Planner mode
// and manifest. This is the shape that cannot be flattened onto the run.
test("one run carries several attempts, each with its own manifest", async () => {
  const runId = await newRun();

  const primary = await openAttempt({ runId, attemptIndex: 0, modelId: "gpt-5-6-luna", provider: "openai" });
  await newDraft(primary, { tokenizerVersion: "o200k_base", contextWindowTokens: 128_000 });
  const primaryFinalized = await finalize(primary);
  await markDispatched({ attemptId: primary, dispatchedAt: primaryFinalized, providerRequestId: "req_1" });
  await closeAttempt({ attemptId: primary, outcome: "failed_pre_token", failureLayer: "provider" });

  // Fallback: a different model, a different tokenizer, a different window --
  // and a Planner failure, so it is never dispatched.
  const fallback = await openAttempt({ runId, attemptIndex: 1, modelId: "deepseek-v4-flash", provider: "deepseek" });
  await newDraft(fallback, { tokenizerVersion: "deepseek-v3", contextWindowTokens: 64_000, tokenCount: 900 });
  await abandonDraft({ attemptId: fallback, reason: "planner_timeout", failureLayer: "planner" });

  // §6: one pass-through downgrade for the same selected model.
  const passThrough = await openAttempt({
    runId,
    attemptIndex: 2,
    modelId: "deepseek-v4-flash",
    provider: "deepseek",
    plannerMode: "pass_through",
  });
  await newDraft(passThrough, { tokenizerVersion: "deepseek-v3", contextWindowTokens: 64_000, tokenCount: 900 });
  const passFinalized = await finalize(passThrough);
  await markDispatched({ attemptId: passThrough, dispatchedAt: passFinalized, providerRequestId: "req_3" });
  await closeAttempt({
    attemptId: passThrough,
    outcome: "succeeded",
    actualInputTokens: 950,
    actualOutputTokens: 400,
    firstVisibleTokenAt: new Date(),
  });

  const attempts = await prisma.routingAttempt.findMany({
    where: { runId },
    orderBy: { attemptIndex: "asc" },
    include: { manifest: true },
  });
  assert.equal(attempts.length, 3);

  // Each attempt's tokenizer and window travel with its own manifest; nothing
  // here was overwritten by the attempt that followed it.
  assert.equal(attempts[0].manifest?.tokenizerVersion, "o200k_base");
  assert.equal(attempts[1].manifest?.tokenizerVersion, "deepseek-v3");
  assert.equal(attempts[0].manifest?.contextWindowTokens, 128_000);
  assert.equal(attempts[1].manifest?.contextWindowTokens, 64_000);

  assert.equal(attempts[0].outcome, "failed_pre_token");
  assert.equal(attempts[1].outcome, "not_dispatched");
  assert.equal(attempts[1].manifest?.state, "not_dispatched");
  assert.equal(attempts[1].manifest?.notDispatchedReason, "planner_timeout");
  assert.equal(attempts[2].plannerMode, "pass_through");
  assert.equal(attempts[2].outcome, "succeeded");

  // Three manifests, three distinct ids. Not one shared row.
  const manifestIds = new Set(attempts.map((a) => a.manifest?.id));
  assert.equal(manifestIds.size, 3);
});

// ROUTE-06, as a constraint rather than a query somebody remembers to run.
test("an attempt cannot be dispatched without a finalized manifest", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);

  await assert.rejects(
    markDispatched({ attemptId }),
    (error: unknown) => error instanceof DispatchBoundaryError,
    "dispatch was recorded with no manifest at all"
  );

  await newDraft(attemptId);
  await assert.rejects(
    markDispatched({ attemptId }),
    (error: unknown) => error instanceof DispatchBoundaryError,
    "dispatch was recorded against a draft manifest"
  );

  const finalizedAt = await finalize(attemptId);
  await markDispatched({ attemptId, dispatchedAt: finalizedAt });
  const attempt = await prisma.routingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  assert.notEqual(attempt.dispatchedAt, null);
});

// "Dispatch is prohibited unless manifest finalization ... succeed[s]" is an
// ordering claim, not only an existence one.
test("a dispatch cannot predate the finalization that authorised it", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  const finalizedAt = await finalize(attemptId);

  await assert.rejects(
    prisma.routingAttempt.update({
      where: { id: attemptId },
      data: { dispatchedAt: new Date(finalizedAt.getTime() - 1_000) },
    }),
    /check|constraint/i
  );
});

// A fallback may receive different context, so a manifest two attempts both
// pointed at would describe neither.
test("a manifest belongs to exactly one attempt", async () => {
  const runId = await newRun();
  const first = await newAttempt(runId, 0);
  const second = await newAttempt(runId, 1);
  await newDraft(first);

  await assert.rejects(
    prisma.contextManifest.create({
      data: {
        attemptId: first,
        sourceRefs: [],
        tokenizerVersion: "o200k_base",
        tokenCount: 10,
        contextWindowTokens: 1_000,
      },
    }),
    /unique|constraint/i,
    "a second manifest was attached to one attempt"
  );

  // Pinned from creation rather than from finalization: a draft's tokenizer,
  // token count and window were already chosen for one attempt's model, so
  // moving it would attach context sized for that model to a different one --
  // the exact hazard that makes the manifest attempt-scoped.
  const firstManifest = await prisma.contextManifest.findFirstOrThrow({
    where: { attemptId: first },
  });
  assert.equal(firstManifest.finalizedAt, null, "the draft is not finalized yet");
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: firstManifest.id },
      data: { attemptId: second },
    }),
    /cannot be moved to another attempt/i
  );
});

// Finalization is what turns the effective-request hash into evidence. If the
// row can still change afterwards, it is a field rather than a proof.
//
// The one exception is MANIFEST-02's retention compaction, which drops the
// per-part detail and marks the row -- covered in
// tests/integration/context-manifest-retention.db.test.ts, including every
// edit that must still be refused once that door exists. Nothing this test
// names is part of it: the hash, the counts, the versions and the lifecycle
// are exactly what compaction leaves alone.
test("a finalized manifest cannot be edited, compaction aside", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  await finalize(attemptId);

  const manifest = await prisma.contextManifest.findFirstOrThrow({ where: { attemptId } });

  for (const data of [
    { effectiveRequestHash: "tampered" },
    { tokenCount: 1 },
    { tokenizerVersion: "something-else" },
    { sourceRefs: [{ kind: "message", id: "added-later" }] },
    { state: "draft" },
    { finalizedAt: new Date() },
    { summaryVersion: "v2" },
  ]) {
    await assert.rejects(
      prisma.contextManifest.update({ where: { id: manifest.id }, data }),
      /only retention compaction may modify it/i,
      `${Object.keys(data)[0]} was editable after finalization`
    );
  }

  const after = await prisma.contextManifest.findUniqueOrThrow({ where: { id: manifest.id } });
  assert.equal(after.effectiveRequestHash, manifest.effectiveRequestHash);
  assert.equal(after.tokenCount, manifest.tokenCount);
});

test("finalizing twice is refused rather than silently re-stamping", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  await finalize(attemptId);

  await assert.rejects(
    finalize(attemptId),
    (error: unknown) => error instanceof DispatchBoundaryError
  );
});

// A finalized manifest missing its Planner, Adapter or request hash proves
// nothing about what was sent.
test("a manifest cannot be finalized without what makes it evidence", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  const manifest = await prisma.contextManifest.findFirstOrThrow({ where: { attemptId } });

  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: manifest.id },
      data: { state: "finalized", finalizedAt: new Date(), plannerVersion: "planner-v1" },
    }),
    /check|constraint/i,
    "finalized with no adapter version or request hash"
  );
});

// ESTIMATE-03 has zero tolerance for an over-limit request reaching a
// provider, and the manifest is where both halves of that comparison live.
test("a manifest whose token count exceeds its window cannot exist", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);

  await assert.rejects(
    createDraftManifest({
      attemptId,
      sourceRefs: [],
      tokenizerVersion: "o200k_base",
      tokenCount: 130_000,
      contextWindowTokens: 128_000,
    }),
    /check|constraint/i
  );
});

test("an abandoned draft must say why", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  const manifest = await prisma.contextManifest.findFirstOrThrow({ where: { attemptId } });

  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: manifest.id },
      data: { state: "not_dispatched" },
    }),
    /check|constraint/i
  );

  await abandonDraft({ attemptId, reason: "planner_timeout", failureLayer: "planner" });
  const abandoned = await prisma.contextManifest.findUniqueOrThrow({ where: { id: manifest.id } });
  assert.equal(abandoned.notDispatchedReason, "planner_timeout");
  // Not finalized, so still editable -- immutability begins at finalization,
  // which is the moment the row starts claiming something about a dispatch.
  assert.equal(abandoned.finalizedAt, null);
});

// The gate's own number, computed the way the gate will compute it.
test("dispatched-attempt manifest coverage is 100% by construction", async () => {
  const runId = await newRun();

  for (const index of [0, 1]) {
    const attemptId = await openAttempt({
      runId,
      attemptIndex: index,
      modelId: "gpt-5-6-luna",
      provider: "openai",
    });
    await newDraft(attemptId);
    const finalizedAt = await finalize(attemptId);
    await markDispatched({ attemptId, dispatchedAt: finalizedAt });
  }

  // A never-dispatched attempt must not count against coverage.
  const abandoned = await openAttempt({
    runId,
    attemptIndex: 2,
    modelId: "deepseek-v4-flash",
    provider: "deepseek",
  });
  await newDraft(abandoned);
  await abandonDraft({ attemptId: abandoned, reason: "planner_timeout", failureLayer: "planner" });

  const coverage = await dispatchedAttemptManifestCoverage();
  assert.equal(coverage.dispatched, 2);
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.coveragePercent, 100);
});

// The run keeps the aggregate; the attempt keeps the detail. The link is what
// lets the manifest behind the visible answer be reached in one join.
test("the run points at the attempt that answered, and cannot point at two", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  const finalizedAt = await finalize(attemptId);
  await markDispatched({ attemptId, dispatchedAt: finalizedAt });
  await closeAttempt({ attemptId, outcome: "succeeded" });

  await prisma.routingRun.update({
    where: { id: runId },
    data: { finalAttemptId: attemptId, finalModelId: "gpt-5-6-luna" },
  });

  const withManifest = await prisma.routingRun.findUniqueOrThrow({
    where: { id: runId },
    include: { finalAttempt: { include: { manifest: true } } },
  });
  assert.equal(withManifest.finalAttempt?.manifest?.state, "finalized");

  const otherRun = await newRun();
  await assert.rejects(
    prisma.routingRun.update({
      where: { id: otherRun },
      data: { finalAttemptId: attemptId },
    }),
    /unique|constraint/i,
    "two runs claimed the same final attempt"
  );
});

test("a run that reports a fallback must have rerouted, and vice versa", async () => {
  const runId = await newRun();

  await assert.rejects(
    prisma.routingRun.update({
      where: { id: runId },
      data: { fallbackState: "fallback_used" },
    }),
    /check|constraint/i,
    "a fallback was reported with no reroute"
  );

  await prisma.routingRun.update({
    where: { id: runId },
    data: { fallbackState: "fallback_used", rerouteCount: 1 },
  });
  const run = await prisma.routingRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.rerouteCount, 1);
});

// Deleting the run takes its attempts and their manifests. Nothing outlives
// the response it describes.
test("attempts and manifests do not outlive their run", async () => {
  const runId = await newRun();
  const attemptId = await newAttempt(runId);
  await newDraft(attemptId);
  assert.equal(await prisma.contextManifest.count(), 1);

  await prisma.routingRun.delete({ where: { id: runId } });
  assert.equal(await prisma.routingAttempt.count(), 0);
  assert.equal(await prisma.contextManifest.count(), 0);
});

// FALLBACK-03: a successful fallback must have context rebuilt for the model
// that actually ran, not the one that failed.
//
// The 1:1 attempt/manifest relation makes "has its own manifest" true by
// construction, so these tests are about the part that is not structural: a
// manifest copied from the first attempt carries the *first* model's window,
// and that is what the query looks at.

const MODEL_WITH_WINDOW = "gpt-5-6-terra";
const TERRA_WINDOW = 1_050_000;

test("a fallback whose manifest was rebuilt for its own model counts as covered", async () => {
  const runId = await newRun();
  const first = await openAttempt({
    runId,
    attemptIndex: 0,
    modelId: "gpt-5-6-luna",
    provider: "openai",
  });
  await newDraft(first);
  const firstFinalized = await finalize(first);
  await markDispatched({ attemptId: first, dispatchedAt: firstFinalized });
  await closeAttempt({
    attemptId: first,
    outcome: "failed_pre_token",
    failureLayer: "provider",
  });

  const fallback = await openAttempt({
    runId,
    attemptIndex: 1,
    modelId: MODEL_WITH_WINDOW,
    provider: "openai",
  });
  await newDraft(fallback, { contextWindowTokens: TERRA_WINDOW });
  const finalized = await finalize(fallback);
  await markDispatched({ attemptId: fallback, dispatchedAt: finalized });
  await closeAttempt({ attemptId: fallback, outcome: "succeeded" });

  const coverage = await successfulFallbackCandidateManifestCoverage();
  assert.equal(coverage.successfulFallbacks, 1);
  assert.equal(coverage.covered, 1);
  assert.deepEqual(coverage.offenders, []);
  assert.equal(coverage.coveragePercent, 100);
});

test("a fallback carrying the failed model's window is reported, not counted", async () => {
  // The defect the gate exists for: context assembled for the first model and
  // handed to the second. Structurally indistinguishable from a rebuild --
  // except for the window it was cut to.
  const runId = await newRun();
  const first = await openAttempt({
    runId,
    attemptIndex: 0,
    modelId: "gpt-5-6-luna",
    provider: "openai",
  });
  await newDraft(first, { contextWindowTokens: 128_000 });
  const firstFinalized = await finalize(first);
  await markDispatched({ attemptId: first, dispatchedAt: firstFinalized });
  await closeAttempt({
    attemptId: first,
    outcome: "failed_pre_token",
    failureLayer: "provider",
  });

  const fallback = await openAttempt({
    runId,
    attemptIndex: 1,
    modelId: MODEL_WITH_WINDOW,
    provider: "openai",
  });
  // Inherited: the first model's window, on the second model's attempt.
  await newDraft(fallback, { contextWindowTokens: 128_000 });
  const finalized = await finalize(fallback);
  await markDispatched({ attemptId: fallback, dispatchedAt: finalized });
  await closeAttempt({ attemptId: fallback, outcome: "succeeded" });

  const coverage = await successfulFallbackCandidateManifestCoverage();
  assert.equal(coverage.covered, 0);
  assert.equal(coverage.offenders.length, 1);
  assert.match(coverage.offenders[0].reason, /is not this model's 1050000/);
  assert.equal(coverage.coveragePercent, 0);
});

test("a model with no declared window is unverifiable, not covered", async () => {
  // Counting it as covered would let the catalogue's undeclared models carry
  // the gate to 100% with nothing checked; counting it as a failure would
  // report a missing declaration as a fallback defect.
  const runId = await newRun();
  const first = await openAttempt({
    runId,
    attemptIndex: 0,
    modelId: "gpt-5-6-luna",
    provider: "openai",
  });
  await newDraft(first);
  const firstFinalized = await finalize(first);
  await markDispatched({ attemptId: first, dispatchedAt: firstFinalized });
  await closeAttempt({ attemptId: first, outcome: "failed_pre_token", failureLayer: "provider" });

  const fallback = await openAttempt({
    runId,
    attemptIndex: 1,
    modelId: "grok-3-mini",
    provider: "xai",
  });
  await newDraft(fallback);
  const finalized = await finalize(fallback);
  await markDispatched({ attemptId: fallback, dispatchedAt: finalized });
  await closeAttempt({ attemptId: fallback, outcome: "succeeded" });

  const coverage = await successfulFallbackCandidateManifestCoverage();
  assert.equal(coverage.successfulFallbacks, 1);
  assert.equal(coverage.unverifiable, 1);
  assert.equal(coverage.covered, 0);
  assert.deepEqual(coverage.offenders, []);
  // Nothing decidable, so the percentage says so rather than reporting zero.
  assert.equal(coverage.coveragePercent, 100);
});

test("the first attempt is never a fallback, however it ended", async () => {
  const runId = await newRun();
  const only = await openAttempt({
    runId,
    attemptIndex: 0,
    modelId: MODEL_WITH_WINDOW,
    provider: "openai",
  });
  // A window that is not this model's, to show the query ignores the first
  // attempt entirely rather than passing it for the right reason by accident.
  // Still above the draft's token count -- a manifest claiming otherwise
  // cannot exist, and the CHECK refuses it.
  await newDraft(only, { contextWindowTokens: 128_000 });
  const finalized = await finalize(only);
  await markDispatched({ attemptId: only, dispatchedAt: finalized });
  await closeAttempt({ attemptId: only, outcome: "succeeded" });

  const coverage = await successfulFallbackCandidateManifestCoverage();
  assert.equal(coverage.successfulFallbacks, 0);
  assert.equal(coverage.coveragePercent, 100);
});
