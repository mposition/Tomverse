import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAmuxV22SidecarHandler } from
  "../lib/amux/v22OneShotSidecar.mjs";
import { probeAmuxV22ReadOnlyApiModelAccess } from
  "../lib/amux/v22ReadOnlyApiHost.mjs";
import { amuxV22ApiModelAccessEvidenceDigest, amuxV22ApiModelAccessResult,
  parseAmuxV22ApiModelAccessResult } from
  "../lib/amux/v22ApiModelAccessProtocol.mjs";

const worker = "claude-investigate";
const request = Object.freeze({ version: 1,
  requestId: "00000000-0000-4000-8000-000000000071",
  taskId: "c48886b9-86f8-4631-8db8-c0b288a707af",
  priorAttemptId: "97858395-3d66-42fa-9bfb-0e5a6cba39d8",
  worker, provider: "anthropic", selectedModelId: "claude-opus-5-5",
  launchProofId: "00000000-0000-4000-8000-000000000071",
  launchProofDigest: "1".repeat(64), apiExecutionFrameDigest: "2".repeat(64),
  credentialMetadataDigest: "3".repeat(64), launcherConfigDigest: "4".repeat(64) });
const host = Object.freeze({ worker,
  frame: { provider: "anthropic", modelId: request.selectedModelId,
    credentialMetadataDigest: request.credentialMetadataDigest },
  apiExecutionFrameDigest: request.apiExecutionFrameDigest,
  launcherConfigDigest: request.launcherConfigDigest,
  apiKey: "sk-ant-dedicated-test-key-never-sent" });

test("dedicated non-root model access uses one fixed metadata GET and binds alias to canonical", async () => {
  let calls = 0;
  const result = await probeAmuxV22ReadOnlyApiModelAccess(request, host, {
    testOnly: true,
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.anthropic.com/v1/models/claude-opus-5-5");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["anthropic-version"], "2023-06-01");
      assert.equal(init.headers["x-api-key"], host.apiKey);
      assert.equal("body" in init, false);
      return new Response(JSON.stringify({ id: "claude-opus-5-5-20261001",
        type: "model", display_name: "Claude Opus", created_at:
          "2026-10-01T00:00:00Z", lifecycle: "active", max_tokens: 128000 }),
        { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.access, "verified");
  assert.equal(result.selectedModelId, "claude-opus-5-5");
  assert.equal(result.canonicalModelId, "claude-opus-5-5-20261001");
  assert.equal(result.balanceKnown, false);
  assert.equal(result.maximumCostMicroUsd, 3_400_000);
  assert.equal(result.worstExposureMicroUsd, 6_800_000);
  assert.match(amuxV22ApiModelAccessEvidenceDigest(result), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(host.apiKey), false);
});

test("auth, 404, 429, 5xx and malformed metadata fail closed without retry", async () => {
  for (const [status, expectedAccess, expectedReason] of [
    [401, "unavailable", "auth_failed"], [403, "unavailable", "auth_failed"],
    [404, "unavailable", "model_unavailable"], [429, "unknown", "rate_limited"],
    [503, "unknown", "provider_unavailable"],
  ]) {
    let calls = 0;
    const result = await probeAmuxV22ReadOnlyApiModelAccess(request, host, {
      testOnly: true, fetcher: async () => { calls += 1;
        return new Response("{}", { status }); },
    });
    assert.equal(calls, 1, `HTTP ${status} must not retry`);
    assert.equal(result.access, expectedAccess);
    assert.equal(result.reason, expectedReason);
  }
  let calls = 0;
  const malformed = await probeAmuxV22ReadOnlyApiModelAccess(request, host, {
    testOnly: true, fetcher: async () => { calls += 1;
      return new Response(JSON.stringify({ id: request.selectedModelId,
        type: "not-a-model", price: 1 }), { status: 200 }); },
  });
  assert.equal(calls, 1);
  assert.equal(malformed.access, "unknown");
  assert.equal(malformed.reason, "invalid_response");
});

test("only an active ModelInfo lifecycle verifies; missing, deprecated and retired refuse before a paid call", async () => {
  for (const lifecycle of [undefined, "deprecated", "retired", "ACTIVE", null]) {
    let calls = 0;
    const body = { id: "claude-opus-5-5-20261001", type: "model",
      display_name: "Claude Opus", created_at: "2026-10-01T00:00:00Z",
      ...(lifecycle === undefined ? {} : { lifecycle }) };
    const result = await probeAmuxV22ReadOnlyApiModelAccess(request, host, {
      testOnly: true, fetcher: async () => { calls += 1;
        return new Response(JSON.stringify(body), { status: 200 }); },
    });
    assert.equal(calls, 1, `lifecycle ${String(lifecycle)} must not retry`);
    assert.equal(result.access, "unknown", `lifecycle ${String(lifecycle)}`);
    assert.equal(result.reason, "invalid_response");
    assert.equal(result.canonicalModelId, null);
  }
});

test("model access deadline covers a body that stalls after response headers", async () => {
  let fireTimeout;
  const pending = probeAmuxV22ReadOnlyApiModelAccess(request, host, {
    testOnly: true,
    setTimer: callback => { fireTimeout = callback; return 7; },
    clearTimer: () => {},
    fetcher: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { status: 200 }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof fireTimeout, "function");
  fireTimeout();
  const result = await pending;
  assert.equal(result.access, "unknown");
  assert.equal(result.reason, "request_timeout");
});

test("sidecar journals model access before GET and never repeats after restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-api-model-access-"));
  try {
    let calls = 0;
    const modelAccess = async value => {
      calls += 1;
      return probeAmuxV22ReadOnlyApiModelAccess(value, host, { testOnly: true,
        fetcher: async () => new Response(JSON.stringify({
          id: request.selectedModelId, type: "model", lifecycle: "active" }),
          { status: 200 }) });
    };
    const first = createAmuxV22SidecarHandler({ worker, stateDir,
      run: async () => { throw new Error("paid path must remain closed"); }, modelAccess,
      protocolCapabilities: () => ["read_only_api_retry_v1"] });
    const result = await first({ op: "api_model_access", ...request });
    assert.equal(parseAmuxV22ApiModelAccessResult(result).access, "verified");
    const restarted = createAmuxV22SidecarHandler({ worker, stateDir,
      run: async () => { throw new Error("paid path must remain closed"); }, modelAccess,
      protocolCapabilities: () => ["read_only_api_retry_v1"] });
    assert.deepEqual(await restarted({ op: "api_model_access", ...request }), result);
    assert.equal(calls, 1, "durable read-back must not repeat the provider GET");
    await assert.rejects(restarted({ op: "api_model_access", ...request,
      launchProofDigest: "9".repeat(64) }), /request conflict/);
    assert.equal(calls, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("the Rust wire fixture is exactly what the TypeScript protocol produces", () => {
  const wire = JSON.parse(readFileSync(new URL(
    "./fixtures/amux-v22-api-model-access-wire-v1.json", import.meta.url), "utf8"));
  const verified = amuxV22ApiModelAccessResult(wire.request,
    { access: "verified", canonicalModelId: "claude-opus-5-5", reason: null });
  const unknown = amuxV22ApiModelAccessResult(wire.request,
    { access: "unknown", canonicalModelId: null, reason: "request_timeout" });
  assert.deepEqual(wire.pending, { requests: [wire.request] });
  assert.deepEqual(wire.verified, { ...verified });
  assert.deepEqual(wire.unknown, { ...unknown });
  const evidenceDigest = amuxV22ApiModelAccessEvidenceDigest(verified);
  assert.equal(wire.recorded.evidenceDigest, evidenceDigest);
  assert.equal(wire.readback.evidence.evidenceDigest, evidenceDigest);
  assert.equal(wire.recorded.evidenceId, verified.requestId);
  assert.equal(wire.readback.evidence.launchProofId, verified.launchProofId);
});
