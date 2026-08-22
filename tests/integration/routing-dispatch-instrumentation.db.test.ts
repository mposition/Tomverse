import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  DispatchBoundaryError,
  readFallbackState,
  recordFallbackTransition,
} from "@/lib/routingAttemptStore";
import {
  authoriseDispatch,
  beginInstrumentedDispatch,
  beginRetryAttempt,
  recordFallbackRecovery,
  completeInstrumentedDispatch,
  dispatchInstrumentationCounters,
  dispatchInstrumentationMode,
  recordDispatched,
  recordNotDispatched,
} from "@/lib/routingDispatchInstrumentation";

// Step 2 of the rollout: the §5 records applied to the existing manual
// dispatch path, before Auto is allowed to dispatch on the same machinery.
//
// What is being established here is what the plan asks step 2 to establish --
// that a record is produced for a dispatch, that finalization is atomic, that
// the token and window figures are the ones actually used, that cancellation
// and stream failure reach the record the same way settlement does, and that
// the modes behave as a rollout state rather than as a permanent best-effort.

const reset = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "RoutingRun" RESTART IDENTITY CASCADE`);

beforeEach(async () => {
  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "observe";
  await reset();
});
after(async () => {
  delete process.env.ROUTING_DISPATCH_INSTRUMENTATION;
  await reset();
  await prisma.$disconnect();
});

const messages = [
  { role: "system", parts: [{ type: "text" as const, text: "You are Tomverse." }] },
  {
    role: "user",
    parts: [
      { type: "text" as const, text: "제 여권번호는 M12345678 입니다. 요약해 줘" },
      { type: "file" as const, mediaType: "application/pdf", bytes: 4_096 },
    ],
  },
];

const begin = (overrides: Record<string, unknown> = {}) =>
  beginInstrumentedDispatch({
    traceId: `trace-${randomUUID()}`,
    userId: null,
    subjectKey: `subject-${randomUUID()}`,
    plan: "Pro",
    modelId: "gpt-5-6-luna",
    provider: "openai",
    messages,
    tokenizerVersion: "generic_multilingual_v1",
    tokenCount: 1_200,
    contextWindowTokens: 128_000,
    estimatedInputTokens: 1_000,
    reservedInputTokens: 1_200,
    requestOutputCapTokens: 4_000,
    ...overrides,
  });

const authorise = (record: Awaited<ReturnType<typeof begin>>) =>
  authoriseDispatch(record, {
    modelId: "gpt-5-6-luna",
    provider: "openai",
    maxOutputTokens: 4_000,
    settings: { temperature: 0.7 },
    toolConfig: null,
    messages,
    plannerVersion: "none",
    adapterVersion: "vercel-ai-sdk-streamText-v1",
  });

test("a manual dispatch produces a run, an attempt and a finalized manifest", async () => {
  const draft = await begin();
  assert.ok(draft);

  const authorised = await authorise(draft);
  assert.ok(authorised);
  await recordDispatched(authorised, "req_abc");

  const run = await prisma.routingRun.findUniqueOrThrow({
    where: { id: authorised!.runId },
    include: { routingAttempts: { include: { manifest: true } } },
  });

  // The user chose this model, so the run says so rather than claiming the
  // Router picked it. `routerDecision` was not supplied, and the sentinels
  // are what keeps a manual turn out of the metrics that grade routing.
  assert.equal(run.mode, "manual");
  assert.equal(run.selectionVersion, "manual");
  assert.equal(run.taskProfileVersion, "manual");
  assert.equal(run.candidateFilterVersion, "manual");
  assert.equal(run.userSelectedModelId, "gpt-5-6-luna");
  assert.equal(run.initialModelId, "gpt-5-6-luna");

  assert.equal(run.routingAttempts.length, 1);
  const attempt = run.routingAttempts[0];
  assert.equal(attempt.providerRequestId, "req_abc");
  assert.notEqual(attempt.dispatchedAt, null);
  assert.equal(attempt.manifest?.state, "finalized");
  assert.ok(attempt.manifest?.effectiveRequestHash);

  // How the hash can be checked later. A commitment nobody can name the
  // scheme, algorithm and key for cannot be verified once any of the three
  // changes -- and the key rotates, which is the whole reason the manifest
  // keyring is not the session secret.
  assert.match(attempt.manifest!.contentHashVersion!, /^manifest-content-v\d+$/);
  assert.equal(attempt.manifest?.hashAlgorithm, "hmac-sha256");
  assert.equal(attempt.manifest?.hashKeyId, process.env.MANIFEST_HASH_ACTIVE_KEY_ID);
  // The key itself is never stored: a record carrying its own verification
  // key lets whoever reads the table forge a match.
  assert.equal(
    JSON.stringify(attempt.manifest).includes(process.env.MANIFEST_HASH_KEYS!.split(":")[1]),
    false
  );

  // The figures are the ones the request actually used, not defaults.
  assert.equal(attempt.manifest?.tokenizerVersion, "generic_multilingual_v1");
  assert.equal(attempt.manifest?.tokenCount, 1_200);
  assert.equal(attempt.manifest?.contextWindowTokens, 128_000);
});

// The same property the pure module holds, re-checked after a round trip
// through Postgres: a serializer could reintroduce what the digest kept out.
test("nothing the user wrote reaches the stored manifest", async () => {
  const record = await authorise(await begin());
  const manifest = await prisma.contextManifest.findFirstOrThrow({
    where: { attemptId: record!.attemptId },
  });

  const serialised = JSON.stringify(manifest);
  assert.equal(serialised.includes("M12345678"), false);
  assert.equal(serialised.includes("여권"), false);
  assert.equal(serialised.includes("You are Tomverse"), false);

  // The shape survives, which is what makes the record worth keeping.
  const refs = manifest.sourceRefs as { role: string; parts: { kind: string; bytes: number }[] }[];
  assert.equal(refs.length, 2);
  assert.equal(refs[1].parts[1].kind, "file");
  assert.equal(refs[1].parts[1].bytes, 4_096);
});

// Every terminal outcome reaches the record through the settlement funnel, so
// the ones hardest to reproduce are not the ones most likely to be missed.
for (const [outcome, expected, layer] of [
  ["succeeded", "succeeded", "none"],
  ["cancelled", "cancelled", "none"],
  ["failed_post_token", "failed_post_token", "stream"],
] as const) {
  test(`a ${outcome} stream closes the attempt and the run`, async () => {
    const record = await authorise(await begin());
    await recordDispatched(record);
    await completeInstrumentedDispatch(record, {
      outcome,
      failureLayer: layer,
      actualInputTokens: 1_150,
      actualOutputTokens: 400,
      settlementOutcome: outcome === "succeeded" ? "completed" : "cancelled",
    });

    const attempt = await prisma.routingAttempt.findUniqueOrThrow({
      where: { id: record!.attemptId },
    });
    assert.equal(attempt.outcome, expected);
    assert.equal(attempt.failureLayer, layer);
    assert.equal(attempt.actualInputTokens, 1_150);

    const run = await prisma.routingRun.findUniqueOrThrow({ where: { id: record!.runId } });
    // Only a succeeded attempt is the one that answered.
    assert.equal(run.finalAttemptId, outcome === "succeeded" ? record!.attemptId : null);
    assert.equal(run.finalModelId, outcome === "succeeded" ? "gpt-5-6-luna" : null);
    assert.ok((run.totalLatencyMs ?? -1) >= 0);
  });
}

// The plan asks what the extra writes cost time-to-first-token. An answer
// nobody recorded is an opinion, so the overhead is stored.
test("the instrumentation records what it cost the request", async () => {
  const record = await authorise(await begin());
  await completeInstrumentedDispatch(record, { outcome: "succeeded" });

  const run = await prisma.routingRun.findUniqueOrThrow({ where: { id: record!.runId } });
  // decisionMicros carries the pre-dispatch overhead on a manual run: the
  // Router made no decision, so the field measures the only thing that
  // happened before the provider call.
  assert.ok(run.decisionMicros >= 0);
  assert.ok(run.decisionMicros < 5_000_000, "instrumentation took over five seconds");
});

// §6, and the state the coverage metric would otherwise be unable to read.
test("a preparation that fails leaves no draft stuck mid-lifecycle", async () => {
  const record = await begin();
  await recordNotDispatched(record, "planner_timeout", "planner");

  const attempt = await prisma.routingAttempt.findUniqueOrThrow({
    where: { id: record!.attemptId },
    include: { manifest: true },
  });
  assert.equal(attempt.outcome, "not_dispatched");
  assert.equal(attempt.failureLayer, "planner");
  assert.equal(attempt.manifest?.state, "not_dispatched");
  assert.equal(attempt.manifest?.notDispatchedReason, "planner_timeout");
  assert.equal(attempt.dispatchedAt, null);
});

// Finalizing is a compare-and-set, so a retry cannot re-stamp a manifest that
// already authorised a dispatch.
test("authorising twice is refused rather than silently re-stamping", async () => {
  const record = await authorise(await begin());
  const before = await prisma.contextManifest.findFirstOrThrow({
    where: { attemptId: record!.attemptId },
  });

  // Observe mode swallows the refusal and returns null; the manifest is
  // unchanged either way, which is the property that matters.
  const second = await authorise(record);
  assert.equal(second, null);

  const afterSecond = await prisma.contextManifest.findFirstOrThrow({
    where: { attemptId: record!.attemptId },
  });
  assert.equal(afterSecond.effectiveRequestHash, before.effectiveRequestHash);
  assert.equal(afterSecond.finalizedAt?.getTime(), before.finalizedAt?.getTime());
});

// A routed turn records the Router's own versions and the model the user did
// *not* get, which is what makes disagreement measurable afterwards.
test("a routed dispatch records the decision rather than the manual sentinels", async () => {
  const record = await authorise(
    await begin({
      routerDecision: {
        versions: {
          decision: "router-decision-v1",
          taskProfile: "task-profile-v1",
          candidates: "router-candidates-v1",
          selection: "router-selection-v1",
          scorePolicy: "router-score-policy-v1",
        },
        record: {
          versions: {
            decision: "router-decision-v1",
            taskProfile: "task-profile-v1",
            candidates: "router-candidates-v1",
            selection: "router-selection-v1",
            scorePolicy: "router-score-policy-v1",
          },
          taskKind: "translation",
          taskConfidence: "high",
          needsCurrentInformation: false,
          expectedOutputLength: "short",
          scripts: ["hangul"],
          signals: ["translation_verb"],
          reservedInputTokens: 1_200,
          requestOutputCapTokens: 4_000,
          consideredModelCount: 6,
          eligibleModelIds: ["gpt-5-6-luna", "deepseek-v4-flash"],
          rejections: [
            { modelId: "a", reason: "plan" },
            { modelId: "b", reason: "plan" },
            { modelId: "c", reason: "context_window" },
          ],
          selectedModelId: "gpt-5-6-luna",
          selectionReason: "task_preference",
          selectionMargin: 3,
          selectionDecidedBy: "quality_band",
          challengerModelId: null,
          turnsFavouringChallenger: 0,
          decisionLatencyMs: 2,
        },
        userSelectedModelId: "deepseek-v4-flash",
      },
    })
  );

  const run = await prisma.routingRun.findUniqueOrThrow({
    where: { id: record!.runId },
  });
  assert.equal(run.mode, "auto");
  assert.equal(run.selectionVersion, "router-selection-v1");
  // The scoring policy travels with the rule that applied it: a band moving
  // and the comparator moving are different changes, and a run carrying only
  // one of the two can be attributed to neither.
  assert.equal(run.selectionPolicyVersion, "router-score-policy-v1");
  assert.equal(run.taskProfileVersion, "task-profile-v1");
  assert.equal(run.selectionReason, "task_preference");
  assert.equal(run.eligibleCount, 2);
  // The user's own choice, kept beside Auto's, so the two can be compared.
  assert.equal(run.userSelectedModelId, "deepseek-v4-flash");
  assert.equal(run.selectedModelId, "gpt-5-6-luna");
  // Counts per reason, not the model ids that produced them.
  assert.deepEqual(run.rejectedByReason, { plan: 2, context_window: 1 });
  assert.equal(run.decisionMicros, 2_000);
});

test("off means off: nothing is written and nothing throws", async () => {
  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "off";
  assert.equal(dispatchInstrumentationMode(), "off");

  const record = await begin();
  assert.equal(record, null);
  assert.equal(await authorise(record), null);
  await recordDispatched(record);
  await completeInstrumentedDispatch(record, { outcome: "succeeded" });
  assert.equal(await prisma.routingRun.count(), 0);

  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "observe";
});

// The rollout distinction. `enforce` is the finished posture -- §5 makes
// dispatch conditional on the manifest -- and `observe` is the state that
// measures the failure rate before flipping it, not a permanent fallback.
test("enforce refuses the dispatch where observe continues without a record", async () => {
  const record = await begin();
  await authorise(record);

  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "enforce";
  await assert.rejects(
    authorise(record),
    (error: unknown) => error instanceof DispatchBoundaryError,
    "enforce mode accepted a failed finalization"
  );

  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "observe";
  const observed = await authorise(record);
  assert.equal(observed, null, "observe mode should return null rather than throw");
});

// "How often does this fail" has to be a number before enforce can be turned
// on, which is the whole reason observe exists.
test("the counters make the recording rate readable", async () => {
  const before = dispatchInstrumentationCounters();
  const record = await authorise(await begin());
  await completeInstrumentedDispatch(record, { outcome: "succeeded" });
  const afterOne = dispatchInstrumentationCounters();

  assert.equal(afterOne.started, before.started + 1);
  assert.equal(afterOne.recorded, before.recorded + 1);
  assert.equal(afterOne.failed, before.failed);
});

// §6/§7: one logical response, two attempts, one run. Two runs would look like
// two responses and the reroute rate would read as zero forever.
test("a retry is a second attempt on the same run, with its own manifest", async () => {
  const first = await authorise(await begin());
  await recordDispatched(first);
  await completeInstrumentedDispatch(first, {
    outcome: "failed_pre_token",
    failureLayer: "provider",
  });

  const second = await beginRetryAttempt(first, {
    attemptIndex: 1,
    modelId: "deepseek-v4-flash",
    provider: "deepseek",
    plannerMode: "planned",
    failureLayer: "provider",
    sourceRefs: [],
    tokenizerVersion: "generic_multilingual_v1",
    tokenCount: 1_200,
    contextWindowTokens: 64_000,
  });
  assert.ok(second);
  assert.equal(second!.runId, first!.runId, "the retry started a second run");
  assert.notEqual(second!.attemptId, first!.attemptId);

  const run = await prisma.routingRun.findUniqueOrThrow({
    where: { id: first!.runId },
    include: { routingAttempts: { include: { manifest: true }, orderBy: { attemptIndex: "asc" } } },
  });
  assert.equal(run.routingAttempts.length, 2);
  assert.equal(run.rerouteCount, 1);
  assert.equal(run.fallbackState, "fallback_used");
  assert.equal(run.passThroughUsed, false);

  // §5: a fallback creates a new attempt and its own manifest lifecycle. The
  // first attempt's manifest described a different model's request.
  assert.equal(run.routingAttempts[1].modelId, "deepseek-v4-flash");
  assert.equal(run.routingAttempts[1].plannerMode, "planned");
  assert.ok(run.routingAttempts[1].manifest);
  assert.notEqual(
    run.routingAttempts[1].manifest!.id,
    run.routingAttempts[0].manifest!.id
  );
});

// §6: the downgrade is available once per logical response, whichever attempt
// uses it. The guard is a compare-and-set so a retry racing itself cannot
// record two.
test("the pass-through downgrade cannot be spent twice on one run", async () => {
  const first = await authorise(await begin());
  await completeInstrumentedDispatch(first, {
    outcome: "not_dispatched",
    failureLayer: "planner",
  });

  const second = await beginRetryAttempt(first, {
    attemptIndex: 1,
    modelId: "gpt-5-6-luna",
    provider: "openai",
    plannerMode: "pass_through",
    failureLayer: "planner",
    sourceRefs: [],
    tokenizerVersion: "generic_multilingual_v1",
    tokenCount: 1_200,
    contextWindowTokens: 128_000,
  });
  assert.ok(second);

  const afterFirst = await prisma.routingRun.findUniqueOrThrow({
    where: { id: first!.runId },
  });
  assert.equal(afterFirst.passThroughUsed, true);
  // A pass-through is the same model and reuses the built context, so it is
  // not a reroute and does not spend the two-build budget.
  assert.equal(afterFirst.rerouteCount, 0);

  await assert.rejects(
    recordFallbackTransition({
      runId: first!.runId,
      spentPassThrough: true,
      spentModelFallback: false,
      fallbackState: "fallback_used",
    }),
    (error: unknown) => error instanceof DispatchBoundaryError
  );
});

// §8. Written when the retry produced an answer, so the next turn is never
// sent back to a model that never worked.
test("a successful fallback records where to go back to", async () => {
  const first = await authorise(await begin());
  const second = await beginRetryAttempt(first, {
    attemptIndex: 1,
    modelId: "deepseek-v4-flash",
    provider: "deepseek",
    plannerMode: "planned",
    failureLayer: "provider",
    sourceRefs: [],
    tokenizerVersion: "generic_multilingual_v1",
    tokenCount: 1_200,
    contextWindowTokens: 64_000,
  });

  const beforeAnswer = await prisma.routingRun.findUniqueOrThrow({
    where: { id: first!.runId },
  });
  assert.equal(beforeAnswer.recoveryCandidateModelId, null, "recorded before it worked");

  await recordFallbackRecovery(second, {
    switchReason: "temporary_hard_fallback",
    recoveryCandidateModelId: "gpt-5-6-luna",
    healthEvidence: "provider",
  });

  const run = await prisma.routingRun.findUniqueOrThrow({ where: { id: first!.runId } });
  assert.equal(run.switchReason, "temporary_hard_fallback");
  assert.equal(run.recoveryCandidateModelId, "gpt-5-6-luna");
  assert.equal(run.fallbackHealthEvidence, "provider");
});

// The budgets a decision is made against have to survive a fresh read, or a
// second process would decide it still had them.
test("the run's budgets read back the way the policy expects them", async () => {
  const first = await authorise(await begin());
  const fresh = await readFallbackState(first!.runId);
  assert.deepEqual(fresh, {
    passThroughUsed: false,
    rerouteCount: 0,
    visibleTokenEmitted: false,
  });

  await completeInstrumentedDispatch(first, { outcome: "succeeded", firstTokenMs: 240 });
  const afterStream = await readFallbackState(first!.runId);
  // A recorded first-token time is the durable evidence that something
  // reached the user, so a later decision cannot conclude nothing was shown.
  assert.equal(afterStream!.visibleTokenEmitted, true);
});

// Deletion beats audit retention, and the cascade is what makes that true for
// records that hang three levels below the account.
test("a deleted run takes its attempts and manifests with it", async () => {
  const record = await authorise(await begin());
  assert.equal(await prisma.contextManifest.count(), 1);

  await prisma.routingRun.delete({ where: { id: record!.runId } });
  assert.equal(await prisma.routingAttempt.count(), 0);
  assert.equal(await prisma.contextManifest.count(), 0);
});
