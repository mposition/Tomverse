import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import {
  STATUS_REPORT_SECRET_ENV,
  STATUS_SNAPSHOT_INTERVAL_SECONDS,
  buildStatusSnapshot,
  createStatusSnapshotWriter,
  writeStatusSnapshot,
} from "../tools/review-orchestrator/lib/status-report.mjs";
import {
  SEND_INTERVAL_SECONDS,
  SNAPSHOT_MAX_AGE_SECONDS,
  STATUS_REPORT_SECRET_ENV as SENDER_SECRET_ENV,
  createStatusSender,
  normaliseStatusSnapshot,
  sendStatusReport,
  statusSenderSettings,
} from "../tools/review-orchestrator/bin/review-status-sender.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T01:00:00.000Z");
const SECRET = "s".repeat(40);
const URL_OK = "https://tomverse.example/api/internal/review-orchestrator/status";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const job = (id, slots, extra = {}) => ({
  job: { id, author: "claude", authorVendor: "anthropic", scope: "secret scope text", base: "abc", head: "def", ...extra },
  slots,
});
const done = (verdict, endedAt, provider = "codex") => ({ index: 0, status: "done", verdict, endedAt, provider, findings: [{ severity: "minor", summary: "finding text" }] });
const SNAPSHOT = {
  schemaVersion: 1,
  draining: false,
  pendingJobs: 2,
  providers: [{ id: "claude", vendor: "anthropic", enabled: true, running: 1, maxConcurrent: 2 }],
  last24h: { accept: 3, reject: 1, unknown: 0 },
};

test("the snapshot carries counts and reviewer names, nothing from a job", () => {
  const jobs = [
    job("r-20261009-000000-aaaaaa", [done("accept", NOW - HOUR)]),
    job("r-20261009-000100-bbbbbb", [done("reject", NOW - 2 * HOUR)]),
    job("r-20261009-000200-cccccc", [done("accept", NOW - HOUR), done("unknown", NOW - HOUR)]),
    // Older than a day: not counted.
    job("r-20261007-000000-dddddd", [done("accept", NOW - 25 * HOUR)]),
    // Waiting for a reviewer, and running.
    job("r-20261009-000300-eeeeee", [{ index: 0, status: "queued" }]),
    job("r-20261009-000400-ffffff", [{ index: 0, status: "running", provider: "claude", assignedAt: NOW - 1000 }, { index: 1, status: "queued" }]),
  ];
  const providers = [
    { id: "claude", vendor: "anthropic", enabled: true, maxConcurrent: 2, command: "claude", args: [] },
    { id: "codex", vendor: "openai", enabled: true, command: "codex", args: [], passEnv: ["CODEX_HOME"] },
    { id: "devin", enabled: false },
  ];
  const quotas = {
    claude: { state: "available", remainingPercent: 37.46 },
    // A probe's own fields beyond the state and the amount are not carried.
    codex: { state: "exhausted", remainingPercent: 0, reason: "rate_limited", account: "someone@example.com" },
    devin: { state: "disabled" },
  };
  const snapshot = buildStatusSnapshot({ jobs, providers, load: { claude: { running: 1, recent24h: 4 } }, quotas, draining: false, now: NOW });
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    draining: false,
    pendingJobs: 2,
    providers: [
      { id: "claude", vendor: "anthropic", enabled: true, running: 1, maxConcurrent: 2, quota: { state: "available", remaining: 37.5, unit: "percent" } },
      { id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 1, quota: { state: "exhausted", remaining: 0, unit: "percent" } },
      { id: "devin", vendor: "unknown", enabled: false, running: 0, maxConcurrent: 1, quota: { state: "disabled", remaining: null, unit: null } },
    ],
    last24h: { accept: 1, reject: 1, unknown: 1 },
  });
  assert.ok(!JSON.stringify(snapshot).includes("someone@example.com"));
  const text = JSON.stringify(snapshot);
  for (const leak of ["r-2026", "secret scope", "finding text", "CODEX_HOME", "abc", "def"]) {
    assert.ok(!text.includes(leak), `the snapshot carries ${leak}`);
  }
  assert.deepEqual(normaliseStatusSnapshot(snapshot), snapshot, "what the daemon writes, the sender forwards unchanged");
});

test("a quota is a state and one amount, whatever the probe reported", () => {
  const quota = (value) => buildStatusSnapshot({ jobs: [], providers: [{ id: "x", vendor: "openai", enabled: true }], load: {}, quotas: { x: value }, now: NOW }).providers[0].quota;
  assert.deepEqual(quota({ state: "available", remainingPercent: 100, unlimited: true }), { state: "available", remaining: 100, unit: "percent" });
  assert.deepEqual(quota({ state: "available", remainingPercent: 140 }), { state: "available", remaining: 100, unit: "percent" });
  assert.deepEqual(quota({ state: "available", remaining: 12.345, unit: "usd" }), { state: "available", remaining: 12.35, unit: "usd" });
  assert.deepEqual(quota({ state: "available", remaining: 340, unit: "credits" }), { state: "available", remaining: 340, unit: "credits" });
  assert.deepEqual(quota({ state: "available" }), { state: "available", remaining: null, unit: null });
  for (const unknown of [undefined, null, { state: "unknown" }, { state: "broken", remainingPercent: 5 }, { state: "available", remaining: 5, unit: "tokens" }]) {
    const read = quota(unknown);
    assert.deepEqual(read, unknown?.state === "available" ? { state: "available", remaining: null, unit: null } : { state: "unknown", remaining: null, unit: null }, JSON.stringify(unknown));
  }
  // The sender takes the same shapes and refuses a quota no probe could produce.
  const withQuota = (value) => normaliseStatusSnapshot({ ...SNAPSHOT, providers: [{ ...SNAPSHOT.providers[0], quota: value }] });
  assert.deepEqual(withQuota({ state: "available", remaining: 37.5, unit: "percent", owner: "x" }).providers[0].quota, { state: "available", remaining: 37.5, unit: "percent" });
  assert.deepEqual(withQuota({ state: "unknown", remaining: null, unit: null }).providers[0].quota, { state: "unknown", remaining: null, unit: null });
  for (const bad of [
    null,
    { state: "broken", remaining: null, unit: null },
    { state: "available", remaining: 150, unit: "percent" },
    { state: "available", remaining: -1, unit: "usd" },
    { state: "available", remaining: 5, unit: "tokens" },
    { state: "disabled", remaining: 5, unit: "percent" },
    { state: "available", remaining: "5", unit: "percent" },
  ]) {
    assert.equal(withQuota(bad), null, JSON.stringify(bad));
  }
  // An older daemon writes no quota; the sender forwards the snapshot without one.
  assert.deepEqual(normaliseStatusSnapshot(SNAPSHOT), SNAPSHOT);
});

test("the snapshot stays inside the app's limits", () => {
  const providers = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, vendor: "openai", enabled: true, maxConcurrent: 500 }));
  providers.unshift({ id: "Bad Id", vendor: "openai", enabled: true });
  const snapshot = buildStatusSnapshot({ jobs: [], providers, load: { p0: { running: 99 } }, draining: true, now: NOW });
  assert.equal(snapshot.providers.length, 16);
  assert.equal(snapshot.providers[0].id, "p0");
  assert.equal(snapshot.providers[0].running, 64);
  assert.equal(snapshot.providers[0].maxConcurrent, 64);
  assert.equal(snapshot.draining, true);
  assert.deepEqual(snapshot.last24h, { accept: 0, reject: 0, unknown: 0 });
  // The sender keeps its own copy of these limits; they must agree at the edges.
  assert.deepEqual(normaliseStatusSnapshot(snapshot), snapshot);
});

test("the daemon and the sender agree on the secret's name and the timing", () => {
  assert.equal(SENDER_SECRET_ENV, STATUS_REPORT_SECRET_ENV);
  // The sender calls a snapshot stale after three missed daemon writes, and
  // the app calls five minutes without a report a lost server.
  assert.equal(SNAPSHOT_MAX_AGE_SECONDS, 3 * STATUS_SNAPSHOT_INTERVAL_SECONDS);
  assert.ok(SNAPSHOT_MAX_AGE_SECONDS + SEND_INTERVAL_SECONDS < 5 * 60);
});

test("the sender forwards only the snapshot's own fields, whatever the file holds", () => {
  const tampered = {
    ...SNAPSHOT,
    jobId: "r-20261009-000000-aaaaaa",
    providers: [{ ...SNAPSHOT.providers[0], scope: "secret scope text" }],
    last24h: { ...SNAPSHOT.last24h, findings: ["finding text"] },
  };
  assert.deepEqual(normaliseStatusSnapshot(tampered), SNAPSHOT);
  const dup = SNAPSHOT.providers[0];
  for (const bad of [
    null,
    [],
    { ...SNAPSHOT, schemaVersion: 2 },
    { ...SNAPSHOT, draining: "no" },
    { ...SNAPSHOT, pendingJobs: -1 },
    { ...SNAPSHOT, providers: [dup, dup] },
    { ...SNAPSHOT, providers: [{ ...dup, id: "Claude Opus!" }] },
    { ...SNAPSHOT, providers: [{ ...dup, maxConcurrent: 0 }] },
    { ...SNAPSHOT, providers: [{ ...dup, running: 65 }] },
    { ...SNAPSHOT, last24h: { accept: 1, reject: 1 } },
  ]) {
    assert.equal(normaliseStatusSnapshot(bad), null, JSON.stringify(bad));
  }
});

test("the daemon's config names a snapshot directory, never a URL or a secret", () => {
  const base = { stateDir: "/tmp/x", repos: {}, providers: [{ id: "codex", vendor: "openai", enabled: true, command: "codex", args: [] }] };
  assert.equal(validateConfig(base).statusSnapshot, undefined);
  assert.deepEqual(validateConfig({ ...base, statusSnapshot: { dir: "/var/lib/review-status" } }).statusSnapshot, {
    dir: "/var/lib/review-status",
  });
  for (const statusSnapshot of [
    { dir: "relative/dir" },
    { dir: "/var/lib/../etc" },
    // No interval knob: the sender's staleness rule depends on the daemon's minute.
    { dir: "/var/lib/review-status", intervalSeconds: 300 },
    { dir: "/var/lib/review-status", url: URL_OK },
    { dir: "/var/lib/review-status", secret: SECRET },
    "/var/lib/review-status",
  ]) {
    assert.throws(() => validateConfig({ ...base, statusSnapshot }), /statusSnapshot/, JSON.stringify(statusSnapshot));
  }
  for (const enabled of [true, false]) {
    assert.throws(
      () => validateConfig({ ...base, providers: [{ id: "codex", vendor: "openai", enabled, command: "codex", args: [], passEnv: [STATUS_REPORT_SECRET_ENV] }] }),
      /passEnv must not carry/
    );
  }
});

test("the review account holds no credential for the app: the daemon writes a file and never sends", () => {
  for (const file of ["../tools/review-orchestrator/bin/review-orchestrator.mjs", "../tools/review-orchestrator/lib/service.mjs"]) {
    const source = read(file);
    assert.doesNotMatch(source, /REVIEW_ORCHESTRATOR_STATUS_SECRET|STATUS_REPORT_SECRET_ENV|statusReportSecret|sendStatusReport|createStatusSender|fetch\(/, file);
  }
  const daemonUnit = read("../tools/review-orchestrator/deploy/review-orchestrator.service");
  assert.doesNotMatch(daemonUnit, /status-report|review-status|STATUS_SECRET/);
  const senderUnit = read("../tools/review-orchestrator/deploy/review-status-sender.service");
  assert.match(senderUnit, /^DynamicUser=yes$/m);
  assert.doesNotMatch(senderUnit, /^User=/m, "the sender must not run as the review account");
  assert.match(senderUnit, /^EnvironmentFile=\/etc\/review-status\/secret\.env$/m);
  assert.match(senderUnit, /^Environment=REVIEW_STATUS_URL=https:\/\//m);
  // A root-owned copy, never the review account's checkout or anything mapped from it.
  assert.match(senderUnit, /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/review-status-sender\/review-status-sender\.mjs$/m);
  assert.doesNotMatch(senderUnit, /\/home\/review|BindPaths|BindReadOnlyPaths/);
  // The sender is one file that loads nothing but Node built-ins, and reads no
  // review configuration, store or reviewer output.
  const sender = read("../tools/review-orchestrator/bin/review-status-sender.mjs");
  const imports = [...sender.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]
  );
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((specifier) => !specifier.startsWith("node:")), [], "the sender must import only node: built-ins");
  assert.doesNotMatch(sender, /\bimport\s*\(\s*[^"'\s]/, "no dynamic import of a computed specifier");
  assert.doesNotMatch(sender, /loadConfig|Store|listJobs|reviewPath/);

  const loop = read("../tools/review-orchestrator/bin/review-orchestrator.mjs");
  const daemon = loop.slice(loop.indexOf("async function daemon"), loop.indexOf("async function drain"));
  assert.match(daemon, /snapshotWriter\?\.maybeWrite\(\);/);
  assert.ok(daemon.indexOf("orchestrator.tick(quotas)") < daemon.indexOf("snapshotWriter?.maybeWrite()"));
});

test("the snapshot writer replaces the file whole, paces itself and logs only changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-status-"));
  try {
    writeStatusSnapshot(join(dir, "status"), SNAPSHOT);
    const path = join(dir, "status", "snapshot.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), SNAPSHOT);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o644, "the sender's account must be able to read it");
    }

    const lines = [];
    let clock = 0;
    const writes = [];
    let fail = false;
    const writer = createStatusSnapshotWriter({
      config: { statusSnapshot: { dir: "/x" } },
      log: (line) => lines.push(line),
      snapshot: () => SNAPSHOT,
      now: () => clock,
      write: (target, value) => {
        if (fail) throw Object.assign(new Error("denied"), { code: "EACCES" });
        writes.push([target, value]);
      },
    });
    assert.equal(createStatusSnapshotWriter({ config: {}, log: () => {}, snapshot: () => SNAPSHOT }), null);
    writer.maybeWrite();
    clock = 30_000;
    writer.maybeWrite();
    assert.equal(writes.length, 1);
    clock = 60_000;
    writer.maybeWrite();
    assert.equal(writes.length, 2);
    assert.deepEqual(lines, ["status snapshot written"]);
    fail = true;
    clock = 120_000;
    writer.maybeWrite();
    clock = 180_000;
    writer.maybeWrite();
    assert.deepEqual(lines, ["status snapshot written", "status snapshot failed: EACCES"], "a failed write never throws into the tick");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sender settings: https only, an absolute snapshot path, and a real secret", () => {
  const env = {
    [STATUS_REPORT_SECRET_ENV]: SECRET,
    REVIEW_STATUS_URL: URL_OK,
    REVIEW_STATUS_SNAPSHOT: "/var/lib/review-status/snapshot.json",
  };
  assert.deepEqual(statusSenderSettings(env), { secret: SECRET, url: URL_OK, snapshotPath: env.REVIEW_STATUS_SNAPSHOT });
  for (const [change, pattern] of [
    [{ [STATUS_REPORT_SECRET_ENV]: undefined }, /SECRET/],
    [{ [STATUS_REPORT_SECRET_ENV]: "tiny-secret-value" }, /SECRET/],
    [{ REVIEW_STATUS_URL: "http://tomverse.example/status" }, /https/],
    [{ REVIEW_STATUS_URL: "https://user:pass@tomverse.example/status" }, /credentials/],
    [{ REVIEW_STATUS_URL: "not a url" }, /absolute https/],
    [{ REVIEW_STATUS_SNAPSHOT: "snapshot.json" }, /absolute path/],
  ]) {
    const result = statusSenderSettings({ ...env, ...change });
    assert.match(result.error ?? "", pattern, JSON.stringify(change));
    assert.ok(!result.error.includes("tiny-secret-value"));
  }
});

test("one report: the bearer goes to the configured URL only, and the answer is a status code", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"result":"recorded"}', { status: 200 });
  };
  assert.deepEqual(await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot: SNAPSHOT, fetchImpl }), { ok: true, outcome: "http_200" });
  assert.equal(calls[0].url, URL_OK);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.body, JSON.stringify(SNAPSHOT));
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const refused = await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot: SNAPSHOT, fetchImpl: async () => new Response("", { status: 401 }) });
  assert.deepEqual(refused, { ok: false, outcome: "http_401" });
  const offline = await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot: SNAPSHOT, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(offline, { ok: false, outcome: "network_error" });
});

test("the sender sends a fresh snapshot, and goes quiet when the daemon stops writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-status-"));
  try {
    const path = join(dir, "snapshot.json");
    writeStatusSnapshot(dir, { ...SNAPSHOT, extra: "dropped" });
    const settings = { secret: SECRET, url: URL_OK, snapshotPath: path };
    const lines = [];
    const bodies = [];
    let status = 200;
    let clock = statSync(path).mtimeMs + 1000;
    const sender = createStatusSender({
      settings,
      log: (line) => lines.push(line),
      now: () => clock,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return new Response("", { status });
      },
    });
    await sender.sendOnce();
    assert.deepEqual(bodies, [SNAPSHOT]);
    await sender.sendOnce();
    assert.equal(bodies.length, 2);
    assert.deepEqual(lines, ["status report ok"]);

    status = 401;
    await sender.sendOnce();
    assert.deepEqual(lines.at(-1), "status report failed: http_401");

    // Three missed writes: the file is left alone, and the app sees silence.
    clock += 181_000;
    await sender.sendOnce();
    await sender.sendOnce();
    assert.equal(bodies.length, 3);
    assert.equal(lines.at(-1), "status snapshot is stale; not sending");
    assert.equal(lines.filter((line) => line.includes("stale")).length, 1);

    // Not a snapshot, or too large to be one: nothing is sent.
    clock = Date.now() + 1000;
    writeFileSync(path, "{nope");
    utimesSync(path, new Date(), new Date());
    await sender.sendOnce();
    writeFileSync(path, JSON.stringify({ ...SNAPSHOT, padding: "x".repeat(9000) }));
    await sender.sendOnce();
    assert.equal(bodies.length, 3);
    assert.equal(lines.at(-1), "status snapshot is not a valid snapshot; not sending");

    rmSync(path);
    await sender.sendOnce();
    assert.equal(lines.at(-1), "status snapshot unreadable: ENOENT");
    assert.ok(lines.every((line) => !line.includes(SECRET)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reviewer's credit travels with its quota, only when the probe read it", () => {
  const providers = [{ id: "cursor", vendor: "xai", enabled: true }];
  const quota = (value) => buildStatusSnapshot({ jobs: [], providers, load: {}, quotas: { cursor: value }, now: NOW }).providers[0].quota;
  assert.deepEqual(quota({ state: "available", remainingPercent: 0, creditUsd: 100 }),
    { state: "available", remaining: 0, unit: "percent", credit: 100 });
  assert.deepEqual(quota({ state: "exhausted", remainingPercent: 0, creditUsd: 0 }),
    { state: "exhausted", remaining: 0, unit: "percent", credit: 0 });
  assert.deepEqual(quota({ state: "available", remainingPercent: 40, creditUsd: 12.345 }).credit, 12.35);
  // No credit read: no credit key, the shape every earlier sender and app accepts.
  assert.deepEqual(quota({ state: "exhausted", remainingPercent: 0 }), { state: "exhausted", remaining: 0, unit: "percent" });
  assert.deepEqual(quota({ state: "unknown", creditUsd: 100 }), { state: "unknown", remaining: null, unit: null });

  const withQuota = (value) => normaliseStatusSnapshot({ ...SNAPSHOT, providers: [{ ...SNAPSHOT.providers[0], quota: value }] });
  assert.deepEqual(withQuota({ state: "available", remaining: 0, unit: "percent", credit: 100 }).providers[0].quota,
    { state: "available", remaining: 0, unit: "percent", credit: 100 });
  for (const bad of [
    { state: "available", remaining: 0, unit: "percent", credit: -1 },
    { state: "available", remaining: 0, unit: "percent", credit: "100" },
    { state: "unknown", remaining: null, unit: null, credit: 5 },
    { state: "available", remaining: 0, unit: "percent", credit: 2_000_000_000 },
  ]) {
    assert.equal(withQuota(bad), null, JSON.stringify(bad));
  }
});
