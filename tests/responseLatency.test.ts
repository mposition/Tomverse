import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { clientLatencyBodySchema, latencyDistribution, summarizeResponseLatency, type ResponseLatencySample } from "../lib/responseLatencyCore";
import { createResponseLatencyToken, verifyResponseLatencyToken } from "../lib/responseLatencyToken";
import { createClientLatency } from "../lib/responseLatencyClient";
import { createLatencyStages } from "../lib/responseLatencyStages";

test("stage observations keep overlapping work separate and stop exactly once", async () => {
  let time = 0;
  const recorder = createLatencyStages({}, () => time);
  const context = recorder.stage("contextPrepareMs");
  time = 20;
  const draft = recorder.stage("draftPrepareMs");
  time = 50; context();
  time = 70; draft(); context();
  assert.deepEqual({ ...recorder.timings }, { contextPrepareMs: 50, draftPrepareMs: 50 });
  await assert.rejects(recorder.measure("refinerPrepareMs", async () => { time = 100; throw Error("refused"); }));
  assert.equal(recorder.timings.refinerPrepareMs, 30);
});

test("full send reports separate preparation, headers, first content, stream end and finalization", async () => {
  const original = globalThis.fetch;
  let time = 100;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); };
  try {
    const recorder = createClientLatency(0, { contextPrepareMs: 50, draftPrepareMs: 50 }, () => time);
    const location = recorder.stage("locationMs");
    time = 130; location(); recorder.dispatched();
    time = 200; recorder.headers(new Response(null, { headers: { "X-Response-Latency-Token": "proof" } }));
    recorder.content(" ");
    time = 300; recorder.content("answer");
    time = 400; recorder.content("longer answer"); recorder.streamEnded();
    time = 420; recorder.finish("completed");
    assert.ok(clientLatencyBodySchema.safeParse(body).success);
    assert.deepEqual(body, { token: "proof", outcome: "completed", prepareMs: 130, firstContentMs: 300, completionMs: 420,
      stages: { contextPrepareMs: 50, draftPrepareMs: 50, locationMs: 30, responseHeadersMs: 70,
        dispatchToContentMs: 170, contentToEndMs: 100, clientFinalizeMs: 20 } });
    for (const stages of [{ prompt: "private" }, { contextPrepareMs: -1 }, { modelSyncMs: 421 }, { routingMs: 4 }]) {
      assert.equal(clientLatencyBodySchema.safeParse({ ...body, stages }).success, false);
    }
    const restored = createClientLatency(undefined, { contextPrepareMs: 5_000 }, () => time);
    restored.dispatched();
    restored.headers(new Response(null, { headers: { "X-Response-Latency-Token": "proof" } }));
    time += 10; restored.content("restored answer"); restored.finish("completed");
    assert.ok(clientLatencyBodySchema.safeParse(body).success);
    assert.equal((body.stages as Record<string, number>).contextPrepareMs, undefined);
  } finally { globalThis.fetch = original; }
});

test("distributions distinguish missing data from zero and separate product/source cohorts", () => {
  assert.deepEqual(latencyDistribution([]), { count: 0, p50Ms: null, p95Ms: null });
  assert.deepEqual(latencyDistribution([30, 0, 10, 20]), { count: 4, p50Ms: 10, p95Ms: 30 });
  const sample: ResponseLatencySample = { product: "chat", mode: "auto", source: "server", modelId: "a", provider: "openai", outcome: "completed", timings: { firstContentMs: 100 } };
  const summary = summarizeResponseLatency([sample, { ...sample, outcome: "failed", timings: {} }, { ...sample, product: "review" }, { ...sample, source: "client" }]);
  assert.equal(summary.groups.length, 4);
  assert.equal(summary.groups[0].count, 1);
  assert.equal(summary.groups[0].timings.firstContentMs.count, 1);
  assert.equal(summary.groups[0].evidence, "small_sample");
  assert.deepEqual(summary.groups[0].outcomes, { completed: 1 });
  assert.deepEqual(summary.groups[1].outcomes, { failed: 1 });
});

test("client reports reject text, dimensions, negative, excessive and out-of-order durations", () => {
  const valid = { token: "proof", outcome: "completed", prepareMs: 10, firstContentMs: 20, completionMs: 30 };
  assert.ok(clientLatencyBodySchema.safeParse(valid).success);
  for (const extra of [{ prompt: "secret" }, { modelId: "forged" }, { prepareMs: -1 }, { completionMs: 3_600_001 }, { firstContentMs: 9 }, { firstContentMs: 31 }]) {
    assert.equal(clientLatencyBodySchema.safeParse({ ...valid, ...extra }).success, false);
  }
});

test("timing proof binds dimensions and purpose, expires and rejects tampering", () => {
  const old = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = "latency-test-only-secret";
  try {
    const id = randomUUID();
    const token = createResponseLatencyToken(id, "review", "auto", 100)!;
    assert.equal(verifyResponseLatencyToken(token, 200)?.id, id);
    assert.equal(verifyResponseLatencyToken(token, 200)?.product, "review");
    assert.equal(verifyResponseLatencyToken(token, 3_600_100), null);
    assert.equal(verifyResponseLatencyToken(`${token}x`, 200), null);
    const [body, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.product = "chat";
    assert.equal(verifyResponseLatencyToken(`${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`, 200), null);
    payload.purpose = "unrelated-feature";
    const wrongPurpose = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const wrongSignature = createHmac("sha256", process.env.NEXTAUTH_SECRET).update(`response-latency:${wrongPurpose}`).digest("base64url");
    assert.equal(verifyResponseLatencyToken(`${wrongPurpose}.${wrongSignature}`, 200), null);
    process.env.NEXTAUTH_SECRET = "rotated";
    assert.equal(verifyResponseLatencyToken(token, 200), null);
    delete process.env.NEXTAUTH_SECRET;
    assert.equal(createResponseLatencyToken(id, "chat", "manual"), null);
  } finally {
    if (old === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = old;
  }
});

test("browser sends one bounded report without answer text, only after a signed header", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); };
  try {
    const absent = createClientLatency();
    absent.finish("failed");
    assert.equal(bodies.length, 0);
    const recorder = createClientLatency(performance.now() - 100);
    recorder.dispatched();
    recorder.headers(new Response(null, { headers: { "X-Response-Latency-Token": "proof" } }));
    recorder.content(" ");
    recorder.content("private answer never sent");
    recorder.finish("completed");
    recorder.finish("failed");
    assert.equal(bodies.length, 1);
    assert.ok(clientLatencyBodySchema.safeParse(bodies[0]).success);
    assert.doesNotMatch(JSON.stringify(bodies), /private answer/);
    await Promise.resolve();
    globalThis.fetch = () => { throw new Error("native adapter unavailable"); };
    const native = createClientLatency();
    native.headers(new Response(null, { headers: { "X-Response-Latency-Token": "proof" } }));
    assert.doesNotThrow(() => native.finish("failed"));
  } finally { globalThis.fetch = original; }
});
