import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AGENT_OFFICE_CLI_MAX_BYTES, AGENT_OFFICE_CLI_STALE_MS, AGENT_OFFICE_CLI_TTL_MS,
  AGENT_OFFICE_CLI_WORKER, agentOfficeCliSnapshotSchema, maskAgentOfficeCliText,
} from "../lib/agentOfficeCliMonitorCore.ts";
import { createAgentOfficeCliBuffer, agentOfficeCliBuffer } from "../lib/agentOfficeCliMonitorBuffer.ts";
import { agentOfficeCliMonitorCredential, recordAgentOfficeCliMonitor } from "../lib/agentOfficeCliMonitor.ts";
import { readAgentOfficeCliMonitor } from "../lib/agentOfficeCliMonitorRead.ts";
import { collectAgentOfficeCliSnapshot, projectAgentOfficeCliSource,
  sendAgentOfficeCliSnapshot } from "../lib/agentOfficeCliMonitorCollector.mjs";

const source = (events = []) => ({ name: AGENT_OFFICE_CLI_WORKER, provider: "codex", events });
const pane = (output = "$ npm test\n24 passed") => ({ name: AGENT_OFFICE_CLI_WORKER, output });
const snapshot = () => projectAgentOfficeCliSource(source([
  { kind: "user", text: "Inspect the office reconnect behavior." },
  { kind: "assistant", text: "I will inspect its existing tests." },
  { kind: "tool", tool: "exec_command", detail: "npm test", output: "24 passed" },
]), pane());

test("the collector reuses two GET projections and omits reasoning and unknown fields", async () => {
  const reads = [];
  const value = await collectAgentOfficeCliSnapshot(async kind => {
    reads.push(kind);
    return kind === "pane" ? pane() : source([
      { kind: "user", text: "prompt" }, { kind: "reasoning", text: "private reasoning" },
      { kind: "assistant", text: "visible answer", hidden: "secret field" },
      { kind: "tool", tool: "exec_command", detail: "npm test", output: "passed" },
      { kind: "future_event", text: "do not export" },
    ]);
  });
  assert.deepEqual(reads.sort(), ["pane", "transcript"]);
  assert.deepEqual(value.events.map(event => event.kind), ["prompt", "assistant", "tool", "output"]);
  assert.equal(value.events[2].text, "exec_command\nnpm test");
  assert.equal(JSON.stringify(value).includes("private reasoning"), false);
  assert.equal(JSON.stringify(value).includes("secret field"), false);
  assert.equal("commands" in value, false);
});

test("an unavailable or mismatched source never fabricates a live capture", async () => {
  assert.throws(() => projectAgentOfficeCliSource({ ...source(), name: "claude-impl" }, pane()));
  assert.throws(() => projectAgentOfficeCliSource({ ...source(), provider: "claude" }, pane()));
  await assert.rejects(collectAgentOfficeCliSnapshot(async () => { throw new Error("offline"); }));
});

test("sensitive events are hidden before truncation, including ANSI and private-key blocks", () => {
  const token = "ghp_" + "a".repeat(36);
  const value = projectAgentOfficeCliSource(source([
    { kind: "assistant", text: "visible\n" + "x".repeat(5_000) + "\n" + token },
    { kind: "tool", tool: "Read", output: "-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----" },
  ]), pane("\x1b[31m" + token + "\x1b[0m"));
  assert.equal(JSON.stringify(value).includes(token), false);
  assert.equal(JSON.stringify(value).includes("private bytes"), false);
  assert.match(value.events[0].text, /REDACTED/);
  assert.equal(maskAgentOfficeCliText("\x1b[32msafe output\x1b[0m"), "safe output");
  assert.match(maskAgentOfficeCliText("remaining key bytes\n-----END PRIVATE KEY-----"), /REDACTED/);
  assert.match(maskAgentOfficeCliText("MIIE" + "aB3+".repeat(15) + "\n"), /REDACTED/);
  assert.equal(maskAgentOfficeCliText("<script>untrusted()</script>"), "<script>untrusted()</script>");
});

test("multibyte output and oversized histories fit the full wire byte limit", () => {
  const value = projectAgentOfficeCliSource(source(Array.from({ length: 400 }, (_, index) =>
    ({ kind: "assistant", text: `${index}:` + "한".repeat(9_000) }))), pane("한".repeat(12_000)));
  assert.equal(value.truncated, true);
  assert.ok(value.events.length <= 80);
  assert.ok(value.events.at(-1).text.startsWith("399:"));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= AGENT_OFFICE_CLI_MAX_BYTES);
  assert.equal(agentOfficeCliSnapshotSchema.safeParse(value).success, true);
});

test("the volatile buffer separates fresh, stale, expired and rotated-credential readings", () => {
  let clock = Date.now();
  const buffer = createAgentOfficeCliBuffer(() => clock);
  assert.equal(buffer.read("a").state, "unavailable");
  buffer.record(snapshot(), "a");
  assert.equal(buffer.read("a").state, "live");
  assert.equal(buffer.read("b").snapshot, null);
  clock += AGENT_OFFICE_CLI_STALE_MS + 1;
  assert.equal(buffer.read("a").state, "stale");
  clock += AGENT_OFFICE_CLI_TTL_MS;
  assert.equal(buffer.read("a").snapshot, null);
});

test("a delayed older capture cannot replace the latest captured conversation", () => {
  const buffer = createAgentOfficeCliBuffer();
  const current = snapshot();
  buffer.record(current, "a");
  assert.equal(buffer.record({ ...current, capturedAt: new Date(Date.parse(current.capturedAt) - 1_000).toISOString() }, "a"), "older");
  assert.equal(buffer.read("a").snapshot.capturedAt, current.capturedAt);
});

const fixtureSecret = "cli-monitor-fixture-credential-20261025";
function enable(t) {
  const old = [process.env.TOMVERSE_AMUX_CLI_MONITOR, process.env.TOMVERSE_AMUX_CLI_MONITOR_SECRET];
  process.env.TOMVERSE_AMUX_CLI_MONITOR = "1";
  process.env.TOMVERSE_AMUX_CLI_MONITOR_SECRET = fixtureSecret;
  t.after(() => {
    for (const [index, key] of ["TOMVERSE_AMUX_CLI_MONITOR", "TOMVERSE_AMUX_CLI_MONITOR_SECRET"].entries()) {
      if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index];
    }
  });
}
const request = (body, secret = fixtureSecret) => new Request("http://localhost/api/internal/amux/cli-monitor", {
  method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("ingest fails closed when disabled or unauthenticated", async (t) => {
  enable(t);
  assert.equal((await recordAgentOfficeCliMonitor(request(snapshot(), "incorrect"))).status, 401);
  process.env.TOMVERSE_AMUX_CLI_MONITOR = "0";
  assert.equal(agentOfficeCliMonitorCredential(), null);
  assert.equal((await recordAgentOfficeCliMonitor(request(snapshot()))).status, 401);
});

test("ingest refuses command fields, other workers, oversized bodies and expired captures", async (t) => {
  enable(t);
  for (const value of [
    { ...snapshot(), command: "run something" }, { ...snapshot(), worker: "codex-contract" },
    { ...snapshot(), rawOutput: "x".repeat(70_000) },
  ]) await assert.rejects(recordAgentOfficeCliMonitor(request(value)));
  assert.equal((await recordAgentOfficeCliMonitor(request({ ...snapshot(), capturedAt: "2020-01-01T00:00:00.000Z" }))).status, 400);
});

test("ingest masks again on the app boundary before making a snapshot readable", async (t) => {
  enable(t);
  const token = "sk-proj-" + "q".repeat(40);
  const value = { ...snapshot(), events: [{ kind: "output", text: token }], rawOutput: token };
  assert.equal((await recordAgentOfficeCliMonitor(request(value))).status, 200);
  const reading = agentOfficeCliBuffer.read(agentOfficeCliMonitorCredential());
  assert.equal(reading.state, "live");
  assert.equal(JSON.stringify(reading).includes(token), false);
});

test("the sender cannot send a credential to a non-TLS external destination", async () => {
  await assert.rejects(sendAgentOfficeCliSnapshot(snapshot(), { TOMVERSE_AMUX_CLI_MONITOR: "1",
    TOMVERSE_AMUX_CLI_MONITOR_SECRET: fixtureSecret, TOMVERSE_INTERNAL_URL: "http://external.example" }));
});

test("the owner read endpoint contains authentication, step-up and only GET; the collector has no send path", () => {
  const route = readFileSync("app/api/admin/office/cli-monitor/route.ts", "utf8");
  assert.match(route, /await getServerSession\(authOptions\)/);
  assert.deepEqual([...route.matchAll(/export async function (\w+)\(/g)].map(m => m[1]), ["GET"]);
  const collector = readFileSync("lib/agentOfficeCliMonitorCollector.mjs", "utf8");
  assert.equal(collector.includes("/send"), false);
  assert.equal(collector.includes("child_process"), false);
});

test("real owner authorization and step-up guard transcript reads before the buffer is exposed", async (t) => {
  enable(t);
  const keys = ["ADMIN_USER_IDS", "ADMIN_EMAILS", "ADMIN_OWNER_EMAILS", "ADMIN_READONLY_EMAILS", "ADMIN_RECENT_AUTH_MINUTES"];
  const old = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key,index) => { if(old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }));
  process.env.ADMIN_USER_IDS = "monitor-owner,monitor-reader";
  process.env.ADMIN_EMAILS = "monitor-owner@example.test,monitor-reader@example.test";
  process.env.ADMIN_OWNER_EMAILS = "monitor-owner@example.test";
  process.env.ADMIN_READONLY_EMAILS = "monitor-reader@example.test";
  process.env.ADMIN_RECENT_AUTH_MINUTES = "30";
  const session = (id = "monitor-owner", minutesAgo = 0) => ({ user: { id,
    email: `${id}@example.test`, authenticatedAt: new Date(Date.now()-minutesAgo*60_000).toISOString() },
    expires: new Date(Date.now()+3_600_000).toISOString() });
  const readRequest = suffix => new Request(`http://localhost/api/admin/office/cli-monitor${suffix ?? "?worker=codex-impl"}`);
  let limits = 0;
  const rateLimit = async () => { limits++; };
  assert.equal((await readAgentOfficeCliMonitor(readRequest(), null, rateLimit)).status, 404);
  assert.equal((await readAgentOfficeCliMonitor(readRequest(), session("monitor-reader"), rateLimit)).status, 404);
  const stale = await readAgentOfficeCliMonitor(readRequest(), session("monitor-owner",45), rateLimit);
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).error,"ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(limits,0);
  for(const suffix of ["?worker=codex-contract", "?worker=codex-impl&worker=codex-impl", "?worker=codex-impl&command=run"])
    assert.equal((await readAgentOfficeCliMonitor(readRequest(suffix),session(),rateLimit)).status,400);
  const current = snapshot();
  await recordAgentOfficeCliMonitor(request(current));
  const allowed = await readAgentOfficeCliMonitor(readRequest(),session(),rateLimit);
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get("Cache-Control"),"private, no-store, max-age=0");
  assert.equal((await allowed.json()).snapshot.worker,"codex-impl");
});
