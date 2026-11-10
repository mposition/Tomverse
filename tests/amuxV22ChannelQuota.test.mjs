import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { normalizeAmuxV22CodexQuota, normalizeAmuxV22CopilotQuota,
  normalizeAmuxV22CursorQuota, probeAmuxV22ChannelQuota } from
  "../lib/amux/v22ChannelQuota.mjs";
import { createAmuxV22SidecarHandler } from "../lib/amux/v22OneShotSidecar.mjs";
import { amuxQuotaObservationFeedsDispatch } from "../lib/amux/v22WorkerClaimCore.ts";

const at = "2026-11-08T00:00:00.000Z";
const now = Date.parse(at);
const inSeconds = (hours) => Math.floor(now / 1000) + hours * 3600;
const config = { worker: "codex-chore", binaryPath: "/usr/local/bin/cli",
  worktreePath: "/srv/tomverse/worktrees/codex-chore", homePath: "/home/review/codex-chore",
  claudeConfigDir: "/home/review/.amux-cli-profiles/codex" };

const fields = ["provider", "remaining_basis_points", "confidence_basis_points", "exhausted",
  "source", "observed_at", "reset_at"];
function assertObservation(value, provider, remaining, resetAt) {
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
  assert.equal(value.provider, provider);
  assert.equal(value.remaining_basis_points, remaining);
  assert.equal(value.exhausted, remaining === 0);
  assert.equal(value.confidence_basis_points, 10_000);
  assert.equal(value.source, "provider_api");
  assert.equal(value.observed_at, at);
  assert.equal(value.reset_at, resetAt);
}

test("Codex quota reads the account-wide bucket's windows, never a model bucket", () => {
  const body = { rateLimits: { planType: "pro" }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 45.5, windowDurationMins: 300, resetsAt: inSeconds(3) },
      secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: inSeconds(90) } },
    codex_bengalfox: { primary: { usedPercent: 100, resetsAt: inSeconds(1) } } } };
  assertObservation(normalizeAmuxV22CodexQuota(body, at), "openai", 3900,
    new Date(inSeconds(3) * 1000).toISOString());
  // An older CLI sends only the legacy snapshot.
  assertObservation(normalizeAmuxV22CodexQuota({ rateLimits: {
    primary: { usedPercent: 100, resetsAt: inSeconds(2) }, secondary: null } }, at),
  "openai", 0, new Date(inSeconds(2) * 1000).toISOString());
  for (const bad of [null, [], {}, { rateLimits: { planType: "pro" } },
    { rateLimits: { primary: { usedPercent: 10 } } },
    { rateLimits: { primary: { usedPercent: 10, resetsAt: inSeconds(-1) } } },
    { rateLimits: { primary: { usedPercent: -1, resetsAt: inSeconds(1) } } },
    { rateLimits: { primary: { usedPercent: "10", resetsAt: inSeconds(1) } } },
    { rateLimits: { primary: { usedPercent: 10, resetsAt: String(inSeconds(1)) } } }])
    assert.equal(normalizeAmuxV22CodexQuota(bad, at), null, JSON.stringify(bad));
  assert.equal(normalizeAmuxV22CodexQuota(body, "not a time"), null);
});

test("Copilot quota is the premium entitlement with its own reset", () => {
  const resetDate = "2026-12-01T00:00:00Z";
  const reset = new Date(resetDate).toISOString();
  const row = { remainingPercentage: 25.555, entitlementRequests: 300, usedRequests: 224,
    resetDate };
  assertObservation(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions: row } }, at),
    "github-copilot", 2555, reset);
  assertObservation(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions:
    { ...row, usedRequests: 300, remainingPercentage: 3 } } }, at), "github-copilot", 0, reset);
  assertObservation(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions:
    { isUnlimitedEntitlement: true, entitlementRequests: -1, resetDate } } }, at),
  "github-copilot", 10_000, reset);
  // Copilot CLI 1.0.94 sends the read's own moment as resetDate: the next
  // monthly reset (1st, 00:00 UTC) stands in for one that is not ahead.
  for (const stale of ["2026-11-07T16:00:00-08:00", "2026-11-01T00:00:00Z", at])
    assertObservation(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions:
      { ...row, resetDate: stale } } }, at), "github-copilot", 2555, "2026-12-01T00:00:00.000Z");
  assert.equal(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions:
    { ...row, resetDate: "2026-12-31T23:00:00Z" } } }, "2026-12-31T23:30:00.000Z").reset_at,
  "2027-01-01T00:00:00.000Z");
  for (const bad of [{ ...row, resetDate: undefined }, { ...row, resetDate: "not a date" },
    { ...row, remainingPercentage: 101 }, { ...row, entitlementRequests: 0 },
    { ...row, usedRequests: undefined }, { isUnlimitedEntitlement: true, resetDate }])
    assert.equal(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { premium_interactions: bad } }, at),
      null, JSON.stringify(bad));
  assert.equal(normalizeAmuxV22CopilotQuota({ quotaSnapshots: { chat: row } }, at), null);
});

test("Cursor quota is the less-used plan pool, exhausted only when both are full", () => {
  const end = String(now + 10 * 86_400_000);
  const reset = new Date(Number(end)).toISOString();
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: end,
    planUsage: { totalPercentUsed: 30, autoPercentUsed: 12.5, apiPercentUsed: 41 } }, at),
  "cursor", 8750, reset);
  // The 2026-11-10 account: Cursor models full, other models 14% used -> still served.
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: end, planUsage: { limit: 2000,
    autoPercentUsed: 100, apiPercentUsed: 13.91111111111111, totalPercentUsed: 96.01481481481483 } }, at),
  "cursor", 8608, reset);
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: end,
    planUsage: { autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 } }, at),
  "cursor", 0, reset);
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: end,
    planUsage: { totalPercentUsed: 41 } }, at), "cursor", 5900, reset);
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: Number(end),
    planUsage: { remaining: 500, limit: 2000 } }, at), "cursor", 2500, reset);
  assertObservation(normalizeAmuxV22CursorQuota({ billingCycleEnd: end, creditGrantsBalance:
    { creditBalanceCents: "1250" }, planUsage: { totalPercentUsed: 20, remaining: 0 } }, at),
  "cursor", 0, reset);
  for (const bad of [{ planUsage: { totalPercentUsed: 30 } },
    { billingCycleEnd: String(now - 1), planUsage: { totalPercentUsed: 30 } },
    { billingCycleEnd: end, planUsage: { totalPercentUsed: -1 } },
    { billingCycleEnd: end, planUsage: { remaining: 500 } },
    { billingCycleEnd: end, planUsage: {} },
    { billingCycleEnd: "1e15", planUsage: { totalPercentUsed: 1 } }])
    assert.equal(normalizeAmuxV22CursorQuota(bad, at), null, JSON.stringify(bad));
});

/** A fake CLI: records what it was started with and answers each written
 * request through `answer`, which returns the frames to print. */
function fakeCli(answer, decode) {
  const started = [];
  let killed = 0;
  const spawnChild = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { killed += 1; setImmediate(() => child.emit("close", null)); };
    started.push({ binary, args, options });
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const { messages, rest } = decode(pending);
      pending = rest;
      for (const message of messages)
        for (const reply of answer(message)) child.stdout.write(reply);
    });
    return child;
  };
  return { spawnChild, started, killed: () => killed };
}
const lineDecode = (text) => {
  const lines = text.split("\n");
  return { rest: lines.pop(), messages: lines.filter(Boolean).map((line) => JSON.parse(line)) };
};
const frameDecode = (text) => {
  const messages = [];
  for (;;) {
    const match = /^Content-Length: (\d+)\r\n\r\n/.exec(text);
    if (!match || text.length < match[0].length + Number(match[1])) return { messages, rest: text };
    messages.push(JSON.parse(text.slice(match[0].length, match[0].length + Number(match[1]))));
    text = text.slice(match[0].length + Number(match[1]));
  }
};
const frame = (message) => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const runHome = (copilotToken = null) => {
  const homes = [];
  return { homes, create: async (provider, given, { now: clock }) => {
    assert.equal(given, config); assert.equal(clock, now);
    const home = { provider, cleaned: false, copilotToken,
      config: { ...given, homePath: "/home/review/codex-chore/run-x",
        claudeConfigDir: provider === "openai" ? "/home/review/codex-chore/run-x/codex" :
          "/home/review/codex-chore/run-x/.config" } };
    home.cleanup = async () => { home.cleaned = true; };
    homes.push(home);
    return home;
  } };
};

test("Codex probe asks app-server only for rate limits, inside the cut-down run home", async () => {
  const methods = [];
  const cli = fakeCli((message) => {
    methods.push(message.method);
    if (message.id === 1) return ["codex diagnostic line\n", `${JSON.stringify({ id: 1, result: {} })}\n`];
    if (message.id === 2) return [`${JSON.stringify({ id: 2, result: { rateLimits: {
      primary: { usedPercent: 20, resetsAt: inSeconds(4) } } } })}\n`];
    return [];
  }, lineDecode);
  const home = runHome();
  const result = await probeAmuxV22ChannelQuota("openai", config,
    { now: () => now, spawn: cli.spawnChild, createRunHome: home.create });
  assertObservation(result, "openai", 8000, new Date(inSeconds(4) * 1000).toISOString());
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(cli.started.length, 1);
  const [{ binary, args, options }] = cli.started;
  assert.equal(binary, config.binaryPath);
  assert.deepEqual(args, ["app-server", "--stdio", "--disable", "remote_control"]);
  assert.equal(options.cwd, "/home/review/codex-chore/run-x");
  assert.deepEqual(options.env, { HOME: "/home/review/codex-chore/run-x", PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8", CODEX_HOME: "/home/review/codex-chore/run-x/codex" });
  assert.equal(cli.killed(), 1);
  assert.equal(home.homes[0].cleaned, true);
});

test("Copilot probe uses only the run's token and the connect/getQuota exchange", async () => {
  const token = "ghu_" + "a".repeat(36);
  const methods = [];
  const cli = fakeCli((message) => {
    methods.push(message.method);
    if (message.id === 1) return [frame({ jsonrpc: "2.0", id: 9, method: "session.event", params: {} }),
      frame({ jsonrpc: "2.0", id: 1, error: { code: -32601 } })];
    if (message.id === 2) return [frame({ jsonrpc: "2.0", id: 2, result: { protocolVersion: 3 } })];
    if (message.id === 3) {
      assert.deepEqual(message.params, { gitHubToken: token });
      return [frame({ jsonrpc: "2.0", id: 3, result: { quotaSnapshots: { premium_interactions: {
        remainingPercentage: 60, entitlementRequests: 300, usedRequests: 120,
        resetDate: "2026-12-01T00:00:00Z" } } } })];
    }
    return [];
  }, frameDecode);
  const home = runHome(token);
  const result = await probeAmuxV22ChannelQuota("github-copilot", config,
    { now: () => now, spawn: cli.spawnChild, createRunHome: home.create });
  assertObservation(result, "github-copilot", 6000, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(methods, ["connect", undefined, "ping", "account.getQuota"]);
  const [{ args, options }] = cli.started;
  assert.ok(args.includes("--no-auto-login") && args.includes("--headless"));
  // Copilot CLI 1.0.107 exits 1 on `--no-remote`; `--no-remote-export` is still accepted.
  assert.equal(args.includes("--no-remote"), false);
  assert.equal(args.includes("--no-remote-export"), true);
  assert.equal(options.env.COPILOT_GITHUB_TOKEN, token);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(home.homes[0].cleaned, true);
});

test("a CLI that errors, closes or floods gives no reading and is always cleaned up", async () => {
  for (const answer of [
    (message) => message.id === 2 ? [`${JSON.stringify({ id: 2, error: { code: 1 } })}\n`] : [],
    (message) => message.id === 2 ? ["x".repeat(300_000)] : [],
    (message) => message.id === 2 ? [`${JSON.stringify({ id: 2, result: { rateLimits: {} } })}\n`] : [],
  ]) {
    const cli = fakeCli(answer, lineDecode);
    const home = runHome();
    assert.equal(await probeAmuxV22ChannelQuota("openai", config,
      { now: () => now, spawn: cli.spawnChild, createRunHome: home.create }), null);
    assert.equal(home.homes[0].cleaned, true);
  }
  const closing = fakeCli(() => [], lineDecode);
  const spawnAndClose = (...args) => {
    const child = closing.spawnChild(...args);
    setImmediate(() => child.emit("close", 1));
    return child;
  };
  assert.equal(await probeAmuxV22ChannelQuota("openai", config,
    { now: () => now, spawn: spawnAndClose, createRunHome: runHome().create }), null);
  // A sign-in the run would refuse is no reading, and starts no CLI.
  let spawned = 0;
  assert.equal(await probeAmuxV22ChannelQuota("openai", config, { now: () => now,
    spawn: () => { spawned += 1; }, createRunHome: async () => { throw new Error("refused"); } }), null);
  assert.equal(spawned, 0);
  for (const provider of ["anthropic", "gemini", ""])
    assert.equal(await probeAmuxV22ChannelQuota(provider, config, { spawn: () => { spawned += 1; } }), null);
  assert.equal(await probeAmuxV22ChannelQuota("openai", { ...config, binaryPath: "codex" },
    { spawn: () => { spawned += 1; } }), null);
  assert.equal(spawned, 0);
});

test("Cursor probe sends the cut-down copy's access token and zeroes the sign-in", async () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 86_400 })).toString("base64url");
  const accessToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature-not-real`;
  let read;
  const sent = [];
  const end = String(now + 86_400_000);
  const result = await probeAmuxV22ChannelQuota("cursor", { ...config, worker: "cursor-chore" }, {
    now: () => now,
    readFile: async (path) => {
      assert.equal(path, `${config.claudeConfigDir}/cursor/auth.json`.replaceAll("/", path.includes("\\") ? "\\" : "/"));
      read = Buffer.from(JSON.stringify({ accessToken, refreshToken: "refresh-secret-not-real" }));
      return read;
    },
    request: async (token) => { sent.push(token);
      return { billingCycleEnd: end, planUsage: { totalPercentUsed: 75 } }; },
  });
  assertObservation(result, "cursor", 2500, new Date(Number(end)).toISOString());
  assert.deepEqual(sent, [accessToken]);
  assert.equal(read.every((byte) => byte === 0), true);
  // An access token expiring within six hours is refused before any request.
  const soon = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600 })).toString("base64url");
  assert.equal(await probeAmuxV22ChannelQuota("cursor", config, { now: () => now,
    readFile: async () => Buffer.from(JSON.stringify({ accessToken: `a.${soon}.b`, refreshToken: "r" })),
    request: async () => { sent.push("unexpected"); return {}; } }), null);
  assert.equal(sent.length, 1);
});

test("the sidecar answers a reading only for its own provider", async () => {
  const requestId = "00000000-0000-4000-8000-000000000002";
  const reading = (provider) => ({ provider, remaining_basis_points: 5000,
    confidence_basis_points: 10_000, exhausted: false, source: "provider_api",
    observed_at: at, reset_at: "2026-12-01T00:00:00.000Z" });
  for (const [provider, observed, kind] of [["openai", "openai", "quota"],
    ["openai", "anthropic", "quota_unavailable"], ["cursor", "github-copilot", "quota_unavailable"],
    ["anthropic", "anthropic", "quota"]]) {
    const handler = createAmuxV22SidecarHandler({ worker: "codex-chore", stateDir: "/unused",
      provider, run: async () => ({}), quota: async () => reading(observed) });
    const answer = await handler({ op: "quota", requestId, worker: "codex-chore" });
    assert.equal(answer.kind, kind, `${provider}/${observed}`);
    assert.equal(answer.observation?.provider ?? null, kind === "quota" ? provider : null);
  }
});

test("non-Claude readings feed dispatch only behind their exact switch", () => {
  for (const provider of ["anthropic", "Anthropic", " anthropic "])
    for (const gate of [undefined, "", "enabled", "disabled"])
      assert.equal(amuxQuotaObservationFeedsDispatch(provider, gate), true);
  for (const provider of ["openai", "github-copilot", "cursor"]) {
    assert.equal(amuxQuotaObservationFeedsDispatch(provider, "enabled"), true);
    for (const gate of [undefined, "", "1", "true", "ENABLED", " enabled"])
      assert.equal(amuxQuotaObservationFeedsDispatch(provider, gate), false, `${provider}/${gate}`);
  }
});
