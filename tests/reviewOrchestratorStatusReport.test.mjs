import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import {
  STATUS_REPORT_SECRET_ENV,
  buildStatusSnapshot,
  createStatusReporter,
  sendStatusReport,
} from "../tools/review-orchestrator/lib/status-report.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T01:00:00.000Z");
const SECRET = "s".repeat(40);
const URL_OK = "https://tomverse.example/api/internal/review-orchestrator/status";

const job = (id, slots, extra = {}) => ({
  job: { id, author: "claude", authorVendor: "anthropic", scope: "secret scope text", base: "abc", head: "def", ...extra },
  slots,
});
const done = (verdict, endedAt, provider = "codex") => ({ index: 0, status: "done", verdict, endedAt, provider, findings: [{ severity: "minor", summary: "finding text" }] });

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
  const snapshot = buildStatusSnapshot({
    jobs,
    providers,
    load: { claude: { running: 1, recent24h: 4 } },
    draining: false,
    now: NOW,
  });
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    draining: false,
    pendingJobs: 2,
    providers: [
      { id: "claude", vendor: "anthropic", enabled: true, running: 1, maxConcurrent: 2 },
      { id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 1 },
      { id: "devin", vendor: "unknown", enabled: false, running: 0, maxConcurrent: 1 },
    ],
    last24h: { accept: 1, reject: 1, unknown: 1 },
  });
  const text = JSON.stringify(snapshot);
  for (const leak of ["r-2026", "secret scope", "finding text", "CODEX_HOME", "abc", "def"]) {
    assert.ok(!text.includes(leak), `the snapshot carries ${leak}`);
  }
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
});

test("statusReport config: https only, no credentials, and the secret never reaches a reviewer", () => {
  const base = { stateDir: "/tmp/x", repos: {}, providers: [{ id: "codex", vendor: "openai", enabled: true, command: "codex", args: [] }] };
  assert.equal(validateConfig(base).statusReport, undefined);
  assert.deepEqual(validateConfig({ ...base, statusReport: { url: URL_OK } }).statusReport, { intervalSeconds: 60, url: URL_OK });
  assert.equal(validateConfig({ ...base, statusReport: { url: URL_OK, intervalSeconds: 120 } }).statusReport.intervalSeconds, 120);
  for (const statusReport of [
    { url: "http://tomverse.example/status" },
    { url: "https://user:pass@tomverse.example/status" },
    { url: `${URL_OK}#x` },
    { url: "not a url" },
    { url: URL_OK, intervalSeconds: 5 },
    { url: URL_OK, secret: SECRET },
    "https://tomverse.example/status",
  ]) {
    assert.throws(() => validateConfig({ ...base, statusReport }), /statusReport/, JSON.stringify(statusReport));
  }
  for (const enabled of [true, false]) {
    assert.throws(
      () => validateConfig({ ...base, providers: [{ id: "codex", vendor: "openai", enabled, command: "codex", args: [], passEnv: [STATUS_REPORT_SECRET_ENV] }] }),
      /passEnv must not carry/
    );
  }
});

test("one report: the bearer goes to the configured URL only, and the answer is a status code", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"result":"recorded"}', { status: 200 });
  };
  const snapshot = { schemaVersion: 1 };
  assert.deepEqual(await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot, fetchImpl }), { ok: true, outcome: "http_200" });
  assert.equal(calls[0].url, URL_OK);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.body, JSON.stringify(snapshot));
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const refused = await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot, fetchImpl: async () => new Response("", { status: 401 }) });
  assert.deepEqual(refused, { ok: false, outcome: "http_401" });
  const offline = await sendStatusReport({ url: URL_OK, secret: SECRET, snapshot, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(offline, { ok: false, outcome: "network_error" });
});

test("the reporter is off without config or secret, paces itself and logs only changes", async () => {
  const config = { statusReport: { url: URL_OK, intervalSeconds: 60 } };
  const lines = [];
  const log = (line) => lines.push(line);
  const env = { [STATUS_REPORT_SECRET_ENV]: SECRET };
  assert.equal(createStatusReporter({ config: {}, env, log, snapshot: () => ({}) }), null);
  assert.equal(createStatusReporter({ config, env: {}, log, snapshot: () => ({}) }), null);
  assert.equal(createStatusReporter({ config, env: { [STATUS_REPORT_SECRET_ENV]: "tiny-secret-value" }, log, snapshot: () => ({}) }), null);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith("status report off:") && !line.includes("tiny-secret-value")));
  lines.length = 0;

  let clock = 0;
  let answer = 404;
  let sent = 0;
  let release;
  const fetchImpl = async () => {
    sent += 1;
    if (answer === "hang") await new Promise((resolve) => (release = resolve));
    return new Response("", { status: answer === "hang" ? 200 : answer });
  };
  const reporter = createStatusReporter({ config, env, log, snapshot: () => ({ schemaVersion: 1 }), fetchImpl, now: () => clock });
  reporter.maybeSend();
  await reporter.settled();
  assert.equal(sent, 1);
  assert.deepEqual(lines, ["status report failed: http_404"]);

  // Not again before the interval, and the same failure is not logged twice.
  clock = 30_000;
  reporter.maybeSend();
  assert.equal(sent, 1);
  clock = 60_000;
  reporter.maybeSend();
  await reporter.settled();
  assert.equal(sent, 2);
  assert.deepEqual(lines, ["status report failed: http_404"]);

  answer = 200;
  clock = 120_000;
  reporter.maybeSend();
  await reporter.settled();
  assert.deepEqual(lines, ["status report failed: http_404", "status report ok"]);

  // A report still in flight is never overlapped by the next one.
  answer = "hang";
  clock = 180_000;
  reporter.maybeSend();
  clock = 400_000;
  reporter.maybeSend();
  assert.equal(sent, 4, "a second report started while one was in flight");
  release();
  await reporter.settled();

  // A snapshot that cannot be built is skipped, and nothing is sent.
  const broken = createStatusReporter({ config, env, log, snapshot: () => { throw new Error("store unreadable"); }, fetchImpl, now: () => 0 });
  broken.maybeSend();
  assert.equal(sent, 4);
  assert.equal(lines.at(-1), "status report skipped: store unreadable");
});

test("the daemon reports after each tick without waiting for the answer", () => {
  const source = readFileSync(new URL("../tools/review-orchestrator/bin/review-orchestrator.mjs", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("async function daemon"), source.indexOf("async function drain"));
  assert.match(loop, /reporter\?\.maybeSend\(\);/);
  assert.doesNotMatch(loop, /await reporter/);
  assert.ok(loop.indexOf("orchestrator.tick(quotas)") < loop.indexOf("reporter?.maybeSend()"));
});
