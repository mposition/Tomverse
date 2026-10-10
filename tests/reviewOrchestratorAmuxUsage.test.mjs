import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  AMUX_USAGE_CACHE_MS,
  AMUX_USAGE_MAX_BYTES,
  AMUX_USAGE_TIMEOUT_MS,
  amuxQuota,
  amuxQuotaFromUsage,
  amuxUsageEndpoint,
  readAmuxUsage,
} from "../tools/review-orchestrator/lib/amux-usage.mjs";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { probeProviderQuotas } from "../tools/review-orchestrator/lib/quota.mjs";

// The shape AMUX's GET /api/usage answers with (crates/amux-server/src/api/usage.rs),
// with made-up figures and no account detail.
const usage = (overrides = {}) => ({
  available: true,
  cache_managed: true,
  providers: [
    {
      id: "claude", available: true, measured: true, stale: null,
      windows: [
        { kind: "session", label: "5-hour session", remaining_percent: 100, used_percent: 0 },
        { kind: "weekly_all", label: "Weekly · all models", remaining_percent: 3, used_percent: 97 },
        { kind: "weekly_scoped", label: "weekly", remaining_percent: 100, used_percent: 0 },
      ],
    },
    { id: "codex", available: true, measured: true, windows: [{ kind: "primary", label: "7-day", remaining_percent: 46, used_percent: 54 }] },
    { id: "copilot", available: true, measured: true, windows: [{ kind: "premium_interactions", remaining_percent: 28.9, used_percent: 71.1 }] },
    {
      id: "cursor", available: true, measured: true, remaining_usd: null,
      windows: [{ kind: "totalPercentUsed", label: "Included plan", remaining_percent: 0, used_percent: 100 }],
    },
    { id: "gemini", available: false, measured: false, windows: [] },
    { id: "devin", available: true, measured: false, windows: [] },
  ],
  ...overrides,
});

test("a provider's quota is the smallest share AMUX measured across its windows", () => {
  const body = usage();
  // Claude's weekly window binds, though its session window is untouched.
  assert.deepEqual(amuxQuotaFromUsage(body, "claude"), { state: "available", remainingPercent: 3 });
  assert.deepEqual(amuxQuotaFromUsage(body, "codex"), { state: "available", remainingPercent: 46 });
  assert.deepEqual(amuxQuotaFromUsage(body, "copilot"), { state: "available", remainingPercent: 28.9 });
  // AMUX does not read Cursor's credit grants yet, so a spent pool reads as
  // exhausted -- which is why Cursor keeps its own probe until it does.
  assert.deepEqual(amuxQuotaFromUsage(body, "cursor"), { state: "exhausted", remainingPercent: 0 });
  // Not measured, not available, not listed: unknown, never a guess.
  assert.deepEqual(amuxQuotaFromUsage(body, "gemini"), { state: "unknown" });
  assert.deepEqual(amuxQuotaFromUsage(body, "devin"), { state: "unknown" });
  assert.deepEqual(amuxQuotaFromUsage(body, "nobody"), { state: "unknown" });
  // The whole body unavailable or stale is unknown for everyone.
  assert.deepEqual(amuxQuotaFromUsage(usage({ available: false }), "claude"), { state: "unknown" });
  assert.deepEqual(amuxQuotaFromUsage(usage({ stale: true }), "codex"), { state: "unknown" });
  assert.deepEqual(amuxQuotaFromUsage(null, "claude"), { state: "unknown" });
  // One stale provider, or one window it could not read, is not partial evidence.
  const stale = usage();
  stale.providers[0] = { ...stale.providers[0], stale: true };
  assert.deepEqual(amuxQuotaFromUsage(stale, "claude"), { state: "unknown" });
  const partial = usage();
  partial.providers[1] = { ...partial.providers[1], windows: [...partial.providers[1].windows, { kind: "secondary", remaining_percent: null }] };
  assert.deepEqual(amuxQuotaFromUsage(partial, "codex"), { state: "unknown" });
  // Cursor's credit, once AMUX reports it: a spent pool stays usable while
  // credit is left, as with cursor-quota.mjs; no credit pauses it.
  const credit = (credit_usd) => {
    const body = usage();
    body.providers[3] = { ...body.providers[3], credit_usd };
    return amuxQuotaFromUsage(body, "cursor");
  };
  assert.deepEqual(credit(100), { state: "available", remainingPercent: 0, creditUsd: 100 });
  assert.deepEqual(credit(0), { state: "exhausted", remainingPercent: 0, creditUsd: 0 });
  assert.deepEqual(credit(null), { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(credit(-1), { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(credit("100"), { state: "exhausted", remainingPercent: 0 });
  const roomy = usage();
  roomy.providers[1] = { ...roomy.providers[1], credit_usd: 12.5 };
  assert.deepEqual(amuxQuotaFromUsage(roomy, "codex"), { state: "available", remainingPercent: 46, creditUsd: 12.5 });
  const odd = usage();
  odd.providers[2] = { ...odd.providers[2], windows: [{ remaining_percent: 140 }] };
  assert.deepEqual(amuxQuotaFromUsage(odd, "copilot"), { state: "unknown" });
});

test("only AMUX on this machine is read, and its self-signed certificate only there", async () => {
  assert.equal(amuxUsageEndpoint("https://127.0.0.1:8824/api/usage")?.href, "https://127.0.0.1:8824/api/usage");
  assert.ok(amuxUsageEndpoint("http://localhost:8824/api/usage"));
  assert.ok(amuxUsageEndpoint("https://[::1]:8824/api/usage"));
  assert.equal(new URL("https://[::1]:8824/").hostname, "[::1]", "the loopback set matches URL.hostname's spelling");
  for (const bad of ["https://amux.example.com/api/usage", "https://192.168.0.7:8824/api/usage", "file:///etc/passwd",
    "https://user:pw@127.0.0.1:8824/api/usage", "not a url", 8824, undefined]) {
    assert.equal(amuxUsageEndpoint(bad), null, String(bad));
  }
  // The TLS check is relaxed for https on loopback, and nowhere else.
  let seen;
  let destroyed = 0;
  const fake = (url, options) => {
    seen = options;
    return { on() {}, end() {}, destroy() { destroyed += 1; } };
  };
  const tls = readAmuxUsage(new URL("https://127.0.0.1:8824/api/usage"), { request: fake, timeoutMs: 10 });
  assert.equal(seen.rejectUnauthorized, false);
  const plain = readAmuxUsage(new URL("http://127.0.0.1:8824/api/usage"), { request: fake, timeoutMs: 10 });
  assert.equal("rejectUnauthorized" in seen, false);
  // Neither fake ever answers: the deadline ends both reads and tears down the request.
  assert.deepEqual(await Promise.all([tls, plain]), [null, null]);
  assert.equal(destroyed, 2);
});

const serve = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/api/usage`, close: () => new Promise((resolve) => server.close(resolve)) };
};

test("reading the usage body: JSON within the size limit, anything else is no answer", async () => {
  const ok = await serve((req, res) => res.end(JSON.stringify(usage())));
  assert.equal((await readAmuxUsage(new URL(ok.url))).providers.length, 6);
  await ok.close();
  const failing = await serve((req, res) => {
    res.statusCode = 503;
    res.end("{}");
  });
  assert.equal(await readAmuxUsage(new URL(failing.url)), null);
  await failing.close();
  const garbled = await serve((req, res) => res.end("{not json"));
  assert.equal(await readAmuxUsage(new URL(garbled.url)), null);
  await garbled.close();
  const huge = await serve((req, res) => res.end("x".repeat(AMUX_USAGE_MAX_BYTES + 1)));
  assert.equal(await readAmuxUsage(new URL(huge.url)), null);
  await huge.close();
  const silent = await serve(() => {});
  assert.equal(await readAmuxUsage(new URL(silent.url), { timeoutMs: 100 }), null);
  await silent.close();
  // A body that trickles in, a byte at a time inside the idle timeout, still
  // ends at the deadline: the limit is for the whole read.
  const timers = [];
  const trickle = await serve((req, res) => {
    res.write("{");
    timers.push(setInterval(() => res.write(" "), 20));
  });
  const started = Date.now();
  assert.equal(await readAmuxUsage(new URL(trickle.url), { timeoutMs: 300 }), null);
  assert.ok(Date.now() - started < 2_000, "a trickling body held the read past its deadline");
  for (const timer of timers) clearInterval(timer);
  await trickle.close();
});

test("the read waits longer than AMUX's own probes, and AMUX's Cursor reads run together", () => {
  // A cache miss in AMUX answers after its slowest probe; each has PROBE_TIMEOUT.
  const rust = readFileSync("vendor/amux/crates/amux-server/src/api/usage/agent_quota.rs", "utf8");
  const probeSeconds = Number(rust.match(/const PROBE_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/)?.[1]);
  assert.ok(probeSeconds > 0, "AMUX's PROBE_TIMEOUT is no longer where this test reads it");
  assert.ok(AMUX_USAGE_TIMEOUT_MS >= probeSeconds * 1000 + 5_000, "a cold but healthy AMUX would read as unknown");
  // The credit read never lengthens the Cursor probe: both go together.
  assert.match(rust, /tokio::join!\(\s*cursor_dashboard_call\(&client, CURSOR_URL, token\),\s*cursor_dashboard_call\(&client, CURSOR_CREDIT_URL, token\),\s*\)/);
});

test("every provider on one URL shares one read a minute", async () => {
  const reads = new Map();
  let calls = 0;
  let release;
  const read = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve(usage());
    });
  };
  const url = "https://127.0.0.1:8824/api/usage";
  const at = 1_000_000;
  // Asked at once, as probeProviderQuotas does: one read answers both.
  const pending = Promise.all([
    amuxQuota({ id: "claude" }, url, { now: at, read, reads }),
    amuxQuota({ id: "codex" }, url, { now: at, read, reads }),
  ]);
  release();
  const [claude, codex] = await pending;
  assert.equal(calls, 1);
  assert.equal(claude.remainingPercent, 3);
  assert.equal(codex.remainingPercent, 46);
  // Within the minute the reading is reused; after it, read again.
  await amuxQuota({ id: "copilot" }, url, { now: at + AMUX_USAGE_CACHE_MS - 1, read: async () => { calls += 1; return usage(); }, reads });
  assert.equal(calls, 1);
  const reread = amuxQuota({ id: "claude" }, url, { now: at + AMUX_USAGE_CACHE_MS, read, reads });
  release();
  await reread;
  assert.equal(calls, 2);
  // A provider named differently in AMUX says so.
  assert.equal((await amuxQuota({ id: "codex-review", amuxProvider: "codex" }, url, { now: at + AMUX_USAGE_CACHE_MS, read, reads })).remainingPercent, 46);
  // A failed read is unknown for everyone until the next minute.
  const failed = new Map();
  assert.deepEqual(await amuxQuota({ id: "claude" }, url, { now: at, read: async () => null, reads: failed }), { state: "unknown" });
  assert.deepEqual(await amuxQuota({ id: "claude" }, url, { now: at, read: async () => { throw new Error("down"); }, reads: new Map() }), { state: "unknown" });
  // A URL off this machine is never read.
  let offMachine = 0;
  assert.deepEqual(await amuxQuota({ id: "claude" }, "https://example.com/api/usage", { read: async () => { offMachine += 1; return usage(); }, reads: new Map() }), { state: "unknown" });
  assert.equal(offMachine, 0);
});

test("the daemon reads AMUX for every provider that names it, and the config must say where", async () => {
  const base = { stateDir: "/x", repos: { demo: { url: "u", mirror: "m" } } };
  const provider = (overrides = {}) => ({ id: "claude", vendor: "anthropic", enabled: true, command: "c", args: [], quotaProbe: "amux", ...overrides });
  assert.ok(validateConfig({ ...base, amuxUsageUrl: "https://127.0.0.1:8824/api/usage", providers: [provider()] }));
  assert.throws(() => validateConfig({ ...base, providers: [provider()] }), /quotaProbe amux needs amuxUsageUrl/);
  assert.throws(() => validateConfig({ ...base, amuxUsageUrl: "https://amux.example.com/api/usage", providers: [provider()] }), /amuxUsageUrl/);
  assert.throws(() => validateConfig({ ...base, amuxUsageUrl: "https://127.0.0.1:8824/api/usage", providers: [provider({ quotaProbe: "claude", amuxProvider: "claude" })] }), /amuxProvider/);

  const live = await serve((req, res) => res.end(JSON.stringify(usage())));
  const config = validateConfig({
    ...base,
    amuxUsageUrl: live.url,
    providers: [
      provider(),
      provider({ id: "codex", vendor: "openai" }),
      provider({ id: "devin", vendor: "cognition", enabled: false }),
    ],
  });
  assert.deepEqual(await probeProviderQuotas(config), {
    claude: { state: "available", remainingPercent: 3 },
    codex: { state: "available", remainingPercent: 46 },
    devin: { state: "disabled" },
  });
  await live.close();
});
