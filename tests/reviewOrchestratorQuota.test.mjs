import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pickReviewer, planAssignments } from "../tools/review-orchestrator/lib/assign.mjs";
import {
  claudeQuotaFromUsage, codexQuotaFromUsage, consumeManualQuota,
  manualQuotaFromSnapshot, probeProviderQuota, readQuotaStatus, recordManualQuota, writeQuotaStatus,
} from "../tools/review-orchestrator/lib/quota.mjs";

test("Claude and Codex quota responses block any exhausted usage window", () => {
  assert.deepEqual(claudeQuotaFromUsage({ five_hour: { utilization: 100 }, seven_day: { utilization: 40 } }),
    { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(claudeQuotaFromUsage({ limits: [{ kind: "session", percent: 25 }] }),
    { state: "available", remainingPercent: 75 });
  assert.deepEqual(claudeQuotaFromUsage({ five_hour: { utilization: -1 }, limits: [{ kind: "worker", percent: 100 }] }),
    { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(codexQuotaFromUsage({ rateLimits: { primary: { usedPercent: 100 } } }),
    { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(codexQuotaFromUsage({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 20 }, secondary: { usedPercent: 50 } },
  } }), { state: "available", remainingPercent: 50 });
  assert.deepEqual(codexQuotaFromUsage({ rateLimits: { primary: {} } }), { state: "unknown" });
});

test("stale, spent, or zero manual evidence cannot authorize assignment", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "review-quota-"));
  const provider = { id: "copilot", enabled: true, quotaProbe: "manual" };
  const config = { stateDir, providers: [provider] };
  const now = Date.now();
  try {
    assert.deepEqual(await probeProviderQuota(provider, stateDir, now), { state: "unknown" });
    recordManualQuota(config, "copilot", 0, "credits", now);
    assert.deepEqual(await probeProviderQuota(provider, stateDir, now),
      { state: "exhausted", remaining: 0, unit: "credits" });
    assert.equal(consumeManualQuota(config, "copilot", now), false);
    recordManualQuota(config, "copilot", 34, "credits", now);
    assert.deepEqual(await probeProviderQuota(provider, stateDir, now),
      { state: "available", remaining: 34, unit: "credits" });
    assert.equal(consumeManualQuota(config, "copilot", now), true);
    assert.deepEqual(await probeProviderQuota(provider, stateDir, now),
      { state: "unknown", reason: "manual_evidence_consumed" });
    assert.equal(consumeManualQuota(config, "copilot", now), false);
    assert.deepEqual(manualQuotaFromSnapshot({ remaining: 1, unit: "credits",
      observedAt: new Date(now - 5 * 60_000 - 1).toISOString() }, now), { state: "unknown" });
    assert.throws(() => recordManualQuota(config, "copilot", -1, "credits", now), /remaining_quota_invalid/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("blocked providers wait instead of closing queued slots and manual evidence is one use per pass", () => {
  const providers = [
    { id: "claude", vendor: "anthropic", enabled: true },
    { id: "copilot", vendor: "moonshot", enabled: true, quotaProbe: "manual", maxConcurrent: 2 },
  ];
  assert.deepEqual(pickReviewer({ providers, authorVendor: "openai", load: {},
    blockedProviders: new Set(["claude", "copilot"]) }), { kind: "wait" });
  const jobs = [{ job: { id: "one", authorVendor: "openai" }, slots: [
    { index: 0, status: "queued" }, { index: 1, status: "queued" },
  ] }];
  const decisions = planAssignments({ jobs, providers, load: {}, now: Date.now(),
    blockedProviders: new Set(["claude"]) });
  assert.deepEqual(decisions.map(({ provider }) => provider), ["copilot"]);
});

test("quota record is local-only and status exposes the recorded balance state", () => {
  const root = mkdtempSync(join(tmpdir(), "review-quota-cli-"));
  const configPath = join(root, "config.json");
  const server = resolve("tools/review-orchestrator/bin/review-orchestrator.mjs");
  writeFileSync(configPath, JSON.stringify({ stateDir: join(root, "state"), repos: {},
    providers: [{ id: "cursor", vendor: "xai", enabled: true,
      quotaProbe: "manual", command: "cursor-agent", args: [] }] }));
  const env = { ...process.env, REVIEW_ORCH_CONFIG: configPath };
  const run = (...args) => spawnSync(process.execPath, [server, ...args], { env, encoding: "utf8" });
  try {
    const recorded = run("quota", "record", "cursor", "0", "percent");
    assert.equal(recorded.status, 0, recorded.stderr);
    const checked = run("quota", "check", "cursor");
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), { cursor: { state: "exhausted", remaining: 0, unit: "percent" } });
    const status = run("status");
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).providers[0], {
      id: "cursor", vendor: "xai", enabled: true, running: 0, last24h: 0,
      quota: "exhausted", remaining: 0, quotaUnit: "percent",
    });
    const rpc = run("rpc", Buffer.from(JSON.stringify({ command: "quota" })).toString("base64url"));
    assert.equal(rpc.status, 64);
    assert.match(rpc.stderr, /rpc_command_invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reads fresh daemon evidence without launching a provider probe", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "review-quota-status-"));
  const config = { stateDir, providers: [{ id: "codex", enabled: true, quotaProbe: "codex" }] };
  const now = Date.now();
  try {
    assert.deepEqual(readQuotaStatus(config, now), { codex: { state: "unknown" } });
    writeQuotaStatus(config, { codex: { state: "exhausted", remainingPercent: 0 } }, now);
    assert.deepEqual(readQuotaStatus(config, now + 89_999),
      { codex: { state: "exhausted", remainingPercent: 0 } });
    assert.deepEqual(readQuotaStatus(config, now + 90_001), { codex: { state: "unknown" } });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
