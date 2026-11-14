import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_PROCESS_AUDIT_ANSWER_SCHEMA,
  AMUX_PROCESS_AUDIT_CLAIM_HOLD_MS,
  AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS,
  maskProcessAuditText,
  parseProcessAuditAnalysis,
  parseProcessAuditSettings,
  previousReportForPrompt,
  processAuditRequestAfterRun,
  processAuditDue,
  processAuditNextRunAt,
  processAuditPrompt,
  processAuditWindow,
  serializeProcessAuditSettings,
} from "../lib/amuxProcessAuditCore.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexReleaseRoot,
  processAuditCodexArguments,
  processAuditFilesystemPermissions,
  runProcessAudit,
} from "../scripts/amux-process-audit-runner.mjs";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-21T00:00:00.000Z");

const analysis = (overrides = {}) => ({
  headline: "사용량 모름 정지가 여전히 1위",
  topItems: [
    { rank: 2, title: "둘째", stage: "3", kinds: ["over_constraint"], status: "continuing", evidence: ["lib/amux/execution.ts:458"],
      protects: "없음", impact: "8건", proposal: "기록만", risk: "낮음" },
    { rank: 1, title: "첫째", stage: "3", kinds: ["stall"], status: "new", evidence: ["prod: usage_outcome_unknown 8"],
      protects: "없음", impact: "35.6h", proposal: "읽고 진행", risk: "낮음" },
  ],
  shortList: [{ stage: "1", item: "중복 검사", evidence: "lib/amux/ideaCardDuplicateScanService.ts:14", proposal: "경고로" }],
  changes: { newStopReasons: ["review_server_unknown"], resolved: ["GENFILE-002 반복"], notes: [] },
  keep: ["시도 예산 5회"],
  unverified: ["bridge halt 횟수"],
  markdown: "# AMUX 프로세스 분석\n\n본문",
  ...overrides,
});

test("settings default off and survive malformed rows as the defaults", () => {
  assert.deepEqual(parseProcessAuditSettings(null), AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS);
  assert.deepEqual(parseProcessAuditSettings("{not json"), AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS);
  assert.deepEqual(parseProcessAuditSettings("[]"), AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS);
  assert.equal(AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS.enabled, false);
  assert.equal(AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS.cadenceDays, 7);
  const odd = parseProcessAuditSettings(JSON.stringify({ enabled: "yes", cadenceDays: 99, runRequestedAt: "nope",
    claim: { token: "x", at: now.toISOString(), windowStart: now.toISOString(), windowEnd: now.toISOString() } }));
  assert.deepEqual(odd, AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS);
  const kept = { enabled: true, cadenceDays: 3, runRequestedAt: now.toISOString(),
    claim: { token: ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"), at: now.toISOString(), windowStart: now.toISOString(), windowEnd: now.toISOString(),
      trigger: "run_now", metrics: { tasks: { created: 3 } } } };
  assert.deepEqual(parseProcessAuditSettings(serializeProcessAuditSettings(kept)), kept);
  // A claim without its trigger or its figures is not a claim.
  for (const broken of [{ ...kept.claim, trigger: "other" }, { ...kept.claim, metrics: null }, { ...kept.claim, metrics: [] }]) {
    assert.equal(parseProcessAuditSettings(JSON.stringify({ ...kept, claim: broken })).claim, null);
  }
});

test("a run is due on the cadence only while the schedule is on", () => {
  const off = { ...AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS };
  const on = { ...off, enabled: true, cadenceDays: 7 };
  assert.deepEqual(processAuditDue({ settings: off, lastReportAt: null, now }), { due: false, reason: "disabled" });
  assert.deepEqual(processAuditDue({ settings: on, lastReportAt: null, now }), { due: true, trigger: "schedule" });
  assert.deepEqual(processAuditDue({ settings: on, lastReportAt: new Date(now.getTime() - 6 * DAY), now }),
    { due: false, reason: "not_yet" });
  assert.deepEqual(processAuditDue({ settings: on, lastReportAt: new Date(now.getTime() - 7 * DAY), now }),
    { due: true, trigger: "schedule" });
});

test("run now wins over a schedule that is off, once", () => {
  const requested = { ...AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS, runRequestedAt: new Date(now.getTime() - 60_000).toISOString() };
  assert.deepEqual(processAuditDue({ settings: requested, lastReportAt: null, now }), { due: true, trigger: "run_now" });
  // Still recorded means no run claimed after it answered it, whatever report came since.
  assert.deepEqual(processAuditDue({ settings: requested, lastReportAt: new Date(now.getTime() - 1_000), now }),
    { due: true, trigger: "run_now" });
  assert.deepEqual(processAuditDue({ settings: { ...requested, runRequestedAt: null }, lastReportAt: new Date(now.getTime() - 1_000), now }),
    { due: false, reason: "disabled" });
});

test("a claim in flight holds every poll until it lapses", () => {
  const claim = (ageMs) => ({ token: ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"), at: new Date(now.getTime() - ageMs).toISOString(),
    windowStart: now.toISOString(), windowEnd: now.toISOString(), trigger: "schedule", metrics: {} });
  const settings = { ...AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS, enabled: true, runRequestedAt: now.toISOString(), claim: claim(60_000) };
  assert.deepEqual(processAuditDue({ settings, lastReportAt: null, now }), { due: false, reason: "running" });
  const lapsed = { ...settings, claim: claim(AMUX_PROCESS_AUDIT_CLAIM_HOLD_MS) };
  assert.equal(processAuditDue({ settings: lapsed, lastReportAt: null, now: new Date(now.getTime() + 1) }).due, true);
});

test("a finished run clears the request it answered and keeps one pressed while it ran", () => {
  const claimed = { token: ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"), at: now.toISOString(), windowStart: now.toISOString(),
    windowEnd: now.toISOString(), trigger: "run_now", metrics: {} };
  assert.equal(processAuditRequestAfterRun(null, claimed), null);
  assert.equal(processAuditRequestAfterRun(new Date(now.getTime() - 1).toISOString(), claimed), null);
  assert.equal(processAuditRequestAfterRun(now.toISOString(), claimed), null);
  const later = new Date(now.getTime() + 60_000).toISOString();
  assert.equal(processAuditRequestAfterRun(later, claimed), later);
});

test("the window is the fourteen days before the claim, and the next run follows the cadence", () => {
  const window = processAuditWindow(now);
  assert.equal(window.end.getTime() - window.start.getTime(), 14 * DAY);
  assert.equal(processAuditNextRunAt(AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS, null, now), null);
  const last = new Date(now.getTime() - DAY);
  assert.equal(processAuditNextRunAt({ ...AMUX_PROCESS_AUDIT_DEFAULT_SETTINGS, enabled: true }, last, now)?.getTime(), last.getTime() + 7 * DAY);
});

test("the answer is kept in the schema's shape, sorted by rank", () => {
  const parsed = parseProcessAuditAnalysis(analysis());
  assert.ok(parsed);
  assert.deepEqual(parsed.topItems.map((item) => item.rank), [1, 2]);
  assert.equal(parseProcessAuditAnalysis(analysis({ markdown: "  " })), null);
  assert.equal(parseProcessAuditAnalysis(analysis({ topItems: [{ ...analysis().topItems[0], status: "maybe" }] })), null);
  assert.equal(parseProcessAuditAnalysis(analysis({ topItems: [{ ...analysis().topItems[0], kinds: ["other"] }] })), null);
  assert.equal(parseProcessAuditAnalysis(analysis({ changes: { newStopReasons: [], resolved: [] } })), null);
  assert.equal(parseProcessAuditAnalysis("text"), null);
  assert.deepEqual(Object.keys(previousReportForPrompt(parsed)).includes("markdown"), false);
});

test("the schema is strict: every object closes its properties and requires them all", () => {
  const visit = (node, path) => {
    if (node && node.type === "object") {
      assert.equal(node.additionalProperties, false, path);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path);
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.${key}`);
    }
    if (node && node.type === "array") visit(node.items, `${path}[]`);
  };
  visit(AMUX_PROCESS_AUDIT_ANSWER_SCHEMA, "$");
});

test("secrets and e-mail addresses are masked before anything is stored", () => {
  const masked = maskProcessAuditText(
    "key sk-abcdefghijklmnopqrstuvwx, ghp_abcdefghijklmnopqrstuvwxyz12, postgres://u:p@h/db, owner@example.com, xoxb-1234567890-abc",
  );
  for (const leaked of ["sk-abc", "ghp_", "postgres://", "owner@example.com", "xoxb-"]) assert.equal(masked.includes(leaked), false, leaked);
  assert.equal(maskProcessAuditText("lib/amux/execution.ts:458 usage_outcome_unknown"), "lib/amux/execution.ts:458 usage_outcome_unknown");
  const parsed = parseProcessAuditAnalysis(analysis({ markdown: "연락처 owner@example.com" }));
  assert.equal(parsed?.markdown.includes("@"), false);
});

test("the prompt carries the commit, the window and the figures as data", () => {
  const prompt = processAuditPrompt({ windowStart: "2026-11-07T00:00:00.000Z", windowEnd: "2026-11-21T00:00:00.000Z",
    developSha: "a".repeat(40), metrics: { tasks: { created: 94 } }, previous: null });
  assert.match(prompt, /read-only checkout of origin\/develop at a{40}/);
  assert.match(prompt, /<data>\n\{"window"/);
  assert.match(prompt, /"created":94/);
  assert.match(prompt, /in Korean/);
});

const ROOTS = ["/tmp/amux-process-audit-x/repo", "/home/tommy/.codex/packages/standalone/releases/0.160.0/"];

test("the model's commands may read only the minimal system paths, the clone and the CLI's release", () => {
  const args = processAuditCodexArguments({ schemaPath: "/tmp/s.json", model: null, readableRoots: ROOTS });
  assert.equal(args.includes("--sandbox"), false, "the profile replaces --sandbox; the CLI refuses both");
  assert.ok(args.includes('default_permissions="process_audit"'));
  assert.ok(args.includes(`permissions.process_audit.filesystem={":minimal"="read","${ROOTS[0]}"="read","${ROOTS[1]}"="read"}`));
  assert.equal(args.some((arg) => arg.includes('"write"') || arg.includes('":root"') || arg.includes('"/home/tommy"')), false);
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("--output-schema"));
  assert.equal(args.includes("-m"), false);
  assert.deepEqual(processAuditCodexArguments({ schemaPath: "/tmp/s.json", model: "gpt-6.1-sol", readableRoots: ROOTS }).slice(-3),
    ["-m", "gpt-6.1-sol", "-"]);
  for (const bad of [[], ["relative/path"], ['/tmp/a"b'], ["/tmp/a\nb"]]) {
    assert.throws(() => processAuditFilesystemPermissions(bad));
  }
});

test("the CLI's release directory is opened, never its home or the account's home", async () => {
  const resolve = async () => "/home/tommy/.codex/packages/standalone/releases/0.160.0/bin/codex";
  assert.equal(await codexReleaseRoot("/home/tommy/.local/bin/codex", { resolve, home: "/home/tommy" }),
    "/home/tommy/.codex/packages/standalone/releases/0.160.0");
  await assert.rejects(codexReleaseRoot("/x", { resolve: async () => "/home/tommy/bin/codex", home: "/home/tommy" }));
  await assert.rejects(codexReleaseRoot("/x", { resolve: async () => "/home/tommy/.codex/bin/codex", home: "/home/tommy" }));
});

const ENV = {
  AMUX_PROCESS_AUDIT_APP_URL: "https://app.test/",
  AMUX_PROCESS_AUDIT_SECRET: "s".repeat(40),
  AMUX_PROCESS_AUDIT_CODEX_BIN: "/bin/codex",
  HOME: "/home/tommy",
  PATH: "/usr/bin",
};

const fakeFetch = (replies, calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
  const reply = replies.shift();
  return { status: reply.status, text: async () => JSON.stringify(reply.body) };
};

const codexStdout = (content) => [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: content } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 300 } }),
].join("\n");

test("the runner does nothing when the app says no run is due", async () => {
  const calls = [];
  const code = await runProcessAudit({ env: ENV, fetchImpl: fakeFetch([{ status: 200, body: { due: false, reason: "disabled" } }], calls),
    runCodex: async () => { throw new Error("must not run"); }, clone: async () => { throw new Error("must not clone"); },
    releaseRoot: async () => "/opt/codex" });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://app.test/api/internal/amux-process-audit/context");
  assert.equal(calls[0].authorization, `Bearer ${"s".repeat(40)}`);
});

test("a due run clones develop outside home, gives the CLI none of the runner's secrets, posts the answer and cleans up", async () => {
  const calls = [];
  let seen = null;
  let cloned = null;
  const workRoot = mkdtempSync(join(tmpdir(), "audit-test-"));
  const code = await runProcessAudit({
    env: ENV,
    workRoot,
    releaseRoot: async () => "/opt/codex/releases/0.160.0",
    fetchImpl: fakeFetch([
      { status: 200, body: { due: true, token: ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"), windowStart: "a", windowEnd: "b", metrics: { x: 1 }, previous: null } },
      { status: 201, body: { state: "stored", id: "r1", removed: 0 } },
    ], calls),
    clone: async ({ checkout, repository }) => {
      cloned = { checkout, repository };
      return "b".repeat(40);
    },
    runCodex: async (input) => {
      seen = input;
      return codexStdout(JSON.stringify(analysis()));
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.cwd, cloned.checkout);
  assert.ok(cloned.checkout.startsWith(workRoot));
  assert.equal(cloned.repository, "https://github.com/mposition/Tomverse.git");
  assert.ok(seen.args.includes(`permissions.process_audit.filesystem={":minimal"="read",${JSON.stringify(cloned.checkout)}="read","/opt/codex/releases/0.160.0"="read"}`));
  // The clone and the schema are gone after the run.
  assert.deepEqual(readdirSync(workRoot), []);
  rmSync(workRoot, { recursive: true, force: true });
  assert.deepEqual(Object.keys(seen.env).sort(), ["HOME", "PATH"]);
  assert.equal(JSON.stringify(seen.env).includes("s".repeat(40)), false);
  assert.equal(calls[1].url, "https://app.test/api/internal/amux-process-audit/report");
  assert.equal(calls[1].body.developSha, "b".repeat(40));
  assert.equal(calls[1].body.token, ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"));
  assert.equal(calls[1].body.analysis.topItems[0].rank, 1);
  assert.equal("metrics" in calls[1].body, false);
});

test("an answer outside the schema is not posted", async () => {
  const calls = [];
  const code = await runProcessAudit({
    env: ENV,
    fetchImpl: fakeFetch([{ status: 200, body: { due: true, token: "t", windowStart: "a", windowEnd: "b", metrics: {}, previous: null } }], calls),
    clone: async () => "b".repeat(40),
    releaseRoot: async () => "/opt/codex",
    runCodex: async () => codexStdout("not json"),
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
});

test("the runner refuses to start without its configuration", async () => {
  assert.equal(await runProcessAudit({ env: { ...ENV, AMUX_PROCESS_AUDIT_SECRET: "short" }, fetchImpl: async () => { throw new Error("no"); } }), 1);
});

test("the box unit runs the bundle and the timer only polls", () => {
  const unit = readFileSync(new URL("../scripts/systemd/tomverse-amux-process-audit.service", import.meta.url), "utf8");
  const timer = readFileSync(new URL("../scripts/systemd/tomverse-amux-process-audit.timer", import.meta.url), "utf8");
  assert.match(unit, /ExecStart=\/usr\/bin\/node %h\/\.local\/lib\/tomverse-amux-process-audit\/amux-process-audit-runner\.mjs/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(timer, /OnUnitInactiveSec=1h/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["build:amux-process-audit-box"], /scripts\/amux-process-audit-runner\.mjs --bundle/);
});

test("the report's Markdown makes no request: links and images render as text, no raw HTML", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxProcessAuditPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\n  a: \(\{ children \}\) => <span/);
  assert.match(panel, /\n  img: \(\{ alt \}\) => <span/);
  assert.match(panel, /components=\{MARKDOWN_COMPONENTS\}/);
  assert.equal(/rehypeRaw|rehype-raw|dangerouslySetInnerHTML/.test(panel), false);
});

test("every grouped text column passes only as a code-shaped value", () => {
  const metrics = readFileSync(new URL("../lib/amuxProcessAuditMetrics.ts", import.meta.url), "utf8");
  for (const column of ['a."reason"', '"reason"', '"resolutionOutcome"', '"verdict"', '"action"', '"answerSource"']) {
    assert.ok(metrics.includes(`WHEN ${column} ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN ${column} ELSE 'other_text' END`), column);
  }
  assert.equal(/left\("?a?\.?"?reason/.test(metrics), false);
});
