import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { DispatchBoundaryError } from "@/lib/routingAttemptStore";
import {
  authoriseDispatch,
  beginInstrumentedDispatch,
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
  // Router picked it.
  assert.equal(run.mode, "manual");
  assert.equal(run.selectionVersion, "manual");
  assert.equal(run.userSelectedModelId, "gpt-5-6-luna");
  assert.equal(run.initialModelId, "gpt-5-6-luna");

  assert.equal(run.routingAttempts.length, 1);
  const attempt = run.routingAttempts[0];
  assert.equal(attempt.providerRequestId, "req_abc");
  assert.notEqual(attempt.dispatchedAt, null);
  assert.equal(attempt.manifest?.state, "finalized");
  assert.ok(attempt.manifest?.effectiveRequestHash);

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

// Deletion beats audit retention, and the cascade is what makes that true for
// records that hang three levels below the account.
test("a deleted run takes its attempts and manifests with it", async () => {
  const record = await authorise(await begin());
  assert.equal(await prisma.contextManifest.count(), 1);

  await prisma.routingRun.delete({ where: { id: record!.runId } });
  assert.equal(await prisma.routingAttempt.count(), 0);
  assert.equal(await prisma.contextManifest.count(), 0);
});
