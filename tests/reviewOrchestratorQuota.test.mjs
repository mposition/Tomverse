import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

test("Codex quota keeps stdin open until the asynchronous account response", () => {
  const root = mkdtempSync(join(tmpdir(), "review-codex-transport-"));
  const quotaModule = pathToFileURL(resolve("tools/review-orchestrator/lib/quota.mjs")).href;
  try {
    for (const usedPercent of [40, 100]) {
      // Node acts as the CLI: app-server is its script path, and EOF stops the
      // process before an asynchronous response, as the real Codex runtime does.
      writeFileSync(join(root, "app-server"), `
        const readline = require("node:readline");
        const input = readline.createInterface({ input: process.stdin });
        const methods = [];
        input.on("line", line => {
          const request = JSON.parse(line);
          methods.push(request.method);
          if (request.id === 2) setTimeout(() => {
            if (JSON.stringify(methods) !== JSON.stringify([
              "initialize", "initialized", "account/rateLimits/read"
            ])) process.exit(2);
            console.log(JSON.stringify({ id: 2, result: {
              rateLimits: { primary: { usedPercent: ${usedPercent} } }
            }}));
          }, 50);
        });
        process.stdin.on("end", () => process.exit(0));
      `);
      const script = `
        import { probeProviderQuota } from ${JSON.stringify(quotaModule)};
        console.log(JSON.stringify(await probeProviderQuota({
          id: "codex", enabled: true, quotaProbe: "codex", command: process.execPath
        }, ${JSON.stringify(root)})));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script],
        { cwd: root, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        state: usedPercent === 100 ? "exhausted" : "available", remainingPercent: 100 - usedPercent,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("Claude usage is paced: a good reading lasts five minutes, a 429 backs off, the last good one stands for 30", async () => {
  const { pacedClaudeQuota, readClaudeUsage, CLAUDE_REFRESH_MS, CLAUDE_LAST_KNOWN_MAX_MS } =
    await import("../tools/review-orchestrator/lib/quota.mjs");
  const provider = { id: "claude", quotaProbe: "claude" };
  const MIN = 60_000;
  const good = { state: "available", remainingPercent: 62 };
  let answer = { quota: good, status: 200, retryAfterSeconds: null };
  const reads = [];
  const read = async (_provider, { now }) => (reads.push(now), answer);
  const pacing = new Map();
  const at = (now) => pacedClaudeQuota(provider, { now, read, pacing });

  assert.deepEqual(await at(0), good);
  assert.deepEqual(await at(CLAUDE_REFRESH_MS - 1), good);
  assert.equal(reads.length, 1, "a good reading is reused for five minutes");

  // Rate-limited: the last good reading stands, and each 429 waits twice as long.
  answer = { quota: { state: "unknown" }, status: 429, retryAfterSeconds: null };
  assert.deepEqual(await at(5 * MIN), good);
  assert.deepEqual(await at(5 * MIN + 2 * MIN - 1), good);
  assert.equal(reads.length, 2, "no read during the first two-minute wait");
  assert.deepEqual(await at(7 * MIN), good);
  assert.equal(reads.length, 3);
  assert.deepEqual(await at(7 * MIN + 4 * MIN - 1), good);
  assert.equal(reads.length, 3, "the second 429 waits four minutes");
  // Retry-After longer than the backoff is honoured.
  answer = { quota: { state: "unknown" }, status: 429, retryAfterSeconds: 20 * 60 };
  await at(11 * MIN);
  assert.equal(reads.length, 4);
  assert.deepEqual(await at(11 * MIN + 20 * MIN - 1), { state: "unknown" }, "past 30 minutes the last reading is no evidence");
  assert.equal(reads.length, 4);
  assert.ok(CLAUDE_LAST_KNOWN_MAX_MS === 30 * MIN);

  // A good reading resets the backoff.
  answer = { quota: good, status: 200, retryAfterSeconds: null };
  assert.deepEqual(await at(31 * MIN), good);
  answer = { quota: { state: "unknown" }, status: 429, retryAfterSeconds: null };
  await at(36 * MIN);
  assert.equal(reads.length, 6);
  await at(36 * MIN + 2 * MIN);
  assert.equal(reads.length, 7, "back to a two-minute wait after a good reading");

  // Any other failure retries after a minute, with no good reading to fall back on.
  const fresh = new Map();
  const failing = async () => ({ quota: { state: "unknown" }, status: 500, retryAfterSeconds: null });
  assert.deepEqual(await pacedClaudeQuota(provider, { now: 0, read: failing, pacing: fresh }), { state: "unknown" });
  assert.equal(fresh.get("claude:credentials-file").retryAt, MIN);

  // Four other failures do not climb the 429 ladder: the first 429 still waits two minutes.
  const mixed = new Map();
  let status = 500;
  const flaky = async () => ({ quota: { state: "unknown" }, status, retryAfterSeconds: null });
  for (let i = 0; i < 4; i += 1) await pacedClaudeQuota(provider, { now: i * MIN, read: flaky, pacing: mixed });
  status = 429;
  await pacedClaudeQuota(provider, { now: 4 * MIN, read: flaky, pacing: mixed });
  assert.equal(mixed.get("claude:credentials-file").retryAt, 4 * MIN + 2 * MIN);

  // Two providers on the same login share one pacing record, so one account is read once.
  const shared = new Map();
  const counted = [];
  const once = async (_p, { now }) => (counted.push(now), { quota: good, status: 200, retryAfterSeconds: null });
  await pacedClaudeQuota({ id: "claude", quotaProbe: "claude" }, { now: 0, read: once, pacing: shared });
  await pacedClaudeQuota({ id: "claude-opus", quotaProbe: "claude" }, { now: 1, read: once, pacing: shared });
  assert.equal(counted.length, 1);
  // A provider on its own env token is a different credential, read on its own.
  await pacedClaudeQuota({ id: "claude-token", quotaProbe: "claude", passEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] },
    { now: 2, read: once, pacing: shared });
  assert.equal(counted.length, 2);

  // One read: the status and Retry-After come back; no token, no request.
  const requests = [];
  const fetchUsage = async (url, init) => {
    requests.push({ url, init });
    return new Response("{\"error\":{}}", { status: 429, headers: { "retry-after": "120" } });
  };
  const creds = () => ({ accessToken: "fake-token", expiresAt: 10_000 });
  assert.deepEqual(await readClaudeUsage({}, { fetchUsage, readCredentials: creds, now: 1 }),
    { quota: { state: "unknown" }, status: 429, retryAfterSeconds: 120 });
  assert.equal(requests[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(requests[0].init.headers.Authorization, "Bearer fake-token");
  assert.deepEqual(await readClaudeUsage({}, { fetchUsage, readCredentials: creds, now: 20_000 }),
    { quota: { state: "unknown" }, status: null, retryAfterSeconds: null });
  assert.equal(requests.length, 1, "an expired token sends nothing");
  const ok = async () => new Response(JSON.stringify({ five_hour: { utilization: 30 }, seven_day: { utilization: 55 } }));
  assert.deepEqual((await readClaudeUsage({}, { fetchUsage: ok, readCredentials: creds, now: 1 })).quota,
    { state: "available", remainingPercent: 45 });
});

test("Retry-After is read as seconds or as an HTTP date", async () => {
  const { retryAfterSecondsFrom } = await import("../tools/review-orchestrator/lib/quota.mjs");
  const now = Date.parse("2026-10-10T01:00:00Z");
  assert.equal(retryAfterSecondsFrom("120", now), 120);
  assert.equal(retryAfterSecondsFrom(" 600 ", now), 600);
  assert.equal(retryAfterSecondsFrom("Sat, 10 Oct 2026 01:20:00 GMT", now), 1200);
  assert.equal(retryAfterSecondsFrom("Sat, 10 Oct 2026 00:50:00 GMT", now), null, "a date in the past asks for no wait");
  for (const none of [null, undefined, "", "0", "soon", "-5"]) assert.equal(retryAfterSecondsFrom(none, now), null, String(none));
});
