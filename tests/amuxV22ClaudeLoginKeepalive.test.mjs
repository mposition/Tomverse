import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CLI_REFRESH_LEAD_MS,
  CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS,
  claudeLoginState,
  runClaudeLoginKeepalive,
} from "../scripts/amux-v22-claude-login-keepalive.mjs";

const NOW = Date.parse("2026-11-15T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const login = (fields) => Buffer.from(JSON.stringify({ claudeAiOauth: {
  accessToken: "a".repeat(40), refreshToken: "r".repeat(40),
  expiresAt: NOW + 6 * HOUR, refreshTokenExpiresAt: NOW + 72 * HOUR, ...fields } }));

test("a login with hours left is fresh", () => {
  assert.equal(claudeLoginState(login({}), NOW).state, "fresh");
});

test("an access token about to expire or past it is due for a refresh", () => {
  assert.equal(claudeLoginState(login({ expiresAt: NOW + CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS }), NOW).state,
    "refresh_due");
  assert.equal(claudeLoginState(login({ expiresAt: NOW - HOUR }), NOW).state, "refresh_due");
});

test("a cleared or expired refresh token needs the operator", () => {
  // What the CLI leaves after a rejected refresh (2026-11-15 05:10Z on the box).
  assert.equal(claudeLoginState(login({ accessToken: "", refreshToken: "", expiresAt: 0 }), NOW).state,
    "login_required");
  assert.equal(claudeLoginState(login({ refreshTokenExpiresAt: NOW - 1 }), NOW).state, "login_required");
  assert.equal(claudeLoginState(Buffer.from("{}"), NOW).state, "missing");
  assert.equal(claudeLoginState(Buffer.from("not json"), NOW).state, "unreadable");
});

test("the state never carries a token", () => {
  const state = claudeLoginState(login({}), NOW);
  assert.doesNotMatch(JSON.stringify(state), /aaaa|rrrr/);
});

function harness(logins, { cliFails = false, stageFails = false, copies = [] } = {}) {
  const calls = [];
  const lines = [];
  let index = 0;
  return {
    calls, lines,
    deps: {
      now: () => NOW,
      readCopyExpiries: async () => copies,
      readLogin: async () => {
        const next = logins[Math.min(index, logins.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      runCli: async (args) => {
        calls.push(args[0] === "-p" ? "prompt" : args.join(" "));
        index += 1;
        if (cliFails) throw new Error("exit 1");
      },
      runStage: async () => { calls.push("stage"); if (stageFails) throw new Error("exit 1"); },
      // The stored login may change while a round waits, like after a CLI use.
      sleep: async (ms) => { calls.push(`sleep ${ms}`); index += 1; },
      log: (line) => lines.push(line),
    },
  };
}

test("a fresh login does nothing", async () => {
  const h = harness([login({})]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.lines[0].outcome, "fresh");
});

test("a due login refreshed by status is restaged without a prompt", async () => {
  const h = harness([login({ expiresAt: NOW + 60_000 }), login({ expiresAt: NOW + 8 * HOUR })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, ["auth status", "stage"]);
  assert.equal(h.lines[0].outcome, "refreshed");
  assert.equal(h.lines[0].by, "status");
});

test("when status does not refresh, one prompt does", async () => {
  const due = login({ expiresAt: NOW - 1 });
  const h = harness([due, due, login({ expiresAt: NOW + 8 * HOUR })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, ["auth status", "prompt", "stage"]);
  assert.equal(h.lines[0].by, "prompt");
});

test("a refresh that never happens fails the unit without a stage", async () => {
  const due = login({ expiresAt: NOW - 1 });
  const h = harness([due], { cliFails: true });
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.deepEqual(h.calls, ["auth status", "prompt"]);
  assert.equal(h.lines[0].outcome, "refresh_failed");
});

// On the box (2026-11-15..20) the CLI declined every refresh with five minutes
// or more left, so the first round in the window logged refresh_failed every
// eight hours and paged AMUX_WORKER_REFRESH_FAILED.
test("a round that lands before the CLI would refresh waits for it instead of failing", async () => {
  const early = login({ expiresAt: NOW + 9 * 60_000 });
  const h = harness([early, early, login({ expiresAt: NOW + 8 * HOUR })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, [`sleep ${9 * 60_000 - CLAUDE_CLI_REFRESH_LEAD_MS}`, "auth status", "stage"]);
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].outcome, "refreshed");
  assert.equal(h.lines[0].by, "status");
  assert.equal(h.lines[0].waitedSeconds, 300);
});

test("the wait fits the window: no round waits past the lead", () => {
  assert.ok(CLAUDE_CLI_REFRESH_LEAD_MS > 0);
  assert.ok(CLAUDE_CLI_REFRESH_LEAD_MS < 5 * 60_000, "inside the CLI's own buffer");
  // The timer steps 5 min; the window must be wider so a round always lands in it.
  assert.ok(CLAUDE_KEEPALIVE_REFRESH_WITHIN_MS - CLAUDE_CLI_REFRESH_LEAD_MS > 5 * 60_000);
});

test("a login refreshed by another use during the wait is restaged without the CLI", async () => {
  const h = harness([login({ expiresAt: NOW + 9 * 60_000 }), login({ expiresAt: NOW + 8 * HOUR })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, [`sleep ${9 * 60_000 - CLAUDE_CLI_REFRESH_LEAD_MS}`, "stage"]);
  assert.equal(h.lines[0].by, "elsewhere");
});

test("a round inside the CLI's buffer asks at once", async () => {
  const h = harness([login({ expiresAt: NOW + CLAUDE_CLI_REFRESH_LEAD_MS - 1 }),
    login({ expiresAt: NOW + 8 * HOUR })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, ["auth status", "stage"]);
  assert.equal(h.lines[0].waitedSeconds, undefined);
});

test("a refresh that still fails after the wait is reported once", async () => {
  const early = login({ expiresAt: NOW + 9 * 60_000 });
  const h = harness([early], { cliFails: true });
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.deepEqual(h.calls, [`sleep ${9 * 60_000 - CLAUDE_CLI_REFRESH_LEAD_MS}`, "auth status", "prompt"]);
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].outcome, "refresh_failed");
});

test("a login cleared during the wait needs the operator and uses no CLI", async () => {
  const h = harness([login({ expiresAt: NOW + 9 * 60_000 }),
    login({ accessToken: "", refreshToken: "", expiresAt: 0 })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.deepEqual(h.calls, [`sleep ${9 * 60_000 - CLAUDE_CLI_REFRESH_LEAD_MS}`]);
  assert.equal(h.lines[0].outcome, "login_required");
});

test("a login the operator must renew uses no CLI at all", async () => {
  const h = harness([login({ accessToken: "", refreshToken: "", expiresAt: 0 })]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.equal(h.lines[0].outcome, "login_required");
});

test("a failed restage after a refresh fails the unit", async () => {
  const h = harness([login({ expiresAt: NOW - 1 }), login({ expiresAt: NOW + 8 * HOUR })],
    { stageFails: true });
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.equal(h.lines[0].staged, "failed");
});

test("a fresh login restages copies left behind by a failed restage, until one succeeds", async () => {
  const source = login({});
  const behind = [NOW + 6 * HOUR, NOW + 5 * 60_000];
  const failing = harness([source], { copies: behind, stageFails: true });
  assert.equal(await runClaudeLoginKeepalive(failing.deps), 1);
  assert.deepEqual(failing.calls, ["stage"]);
  assert.equal(failing.lines[0].restaged, "failed");
  // The next round still sees the copy behind, so it tries again.
  const retry = harness([source], { copies: behind });
  assert.equal(await runClaudeLoginKeepalive(retry.deps), 0);
  assert.deepEqual(retry.calls, ["stage"]);
  assert.equal(retry.lines[0].restaged, "ok");
});

test("copies level with a fresh login are left alone", async () => {
  const h = harness([login({})], { copies: [NOW + 6 * HOUR, NOW + 6 * HOUR] });
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.lines[0].restaged, undefined);
});

test("a missing login file is reported for the operator, not thrown", async () => {
  const gone = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const h = harness([gone]);
  assert.equal(await runClaudeLoginKeepalive(h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.equal(h.lines[0].outcome, "login_required");
  assert.equal(h.lines[0].state, "missing");
});

test("a refresh token with less than a day left warns", async () => {
  const h = harness([login({ refreshTokenExpiresAt: NOW + 2 * HOUR })]);
  await runClaudeLoginKeepalive(h.deps);
  assert.equal(h.lines[0].warning, "relogin_soon");
});

// The autorec account (2026-11-21) has no worker copies: main() passes no
// stage at all, which is "skipped", never a failed or silent restage.
test("a login with no stage to run is refreshed and reports the restage as skipped", async () => {
  const h = harness([login({ expiresAt: NOW + 60_000 }), login({ expiresAt: NOW + 8 * HOUR })]);
  h.deps.runStage = null;
  assert.equal(await runClaudeLoginKeepalive(h.deps), 0);
  assert.deepEqual(h.calls, ["auth status"]);
  assert.equal(h.lines[0].outcome, "refreshed");
  assert.equal(h.lines[0].staged, "skipped");
});

test("the restage opt-out is explicit; a unit that forgot its workers still fails the restage", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../scripts/amux-v22-claude-login-keepalive.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.env\.AMUX_V22_KEEPALIVE_RESTAGE !== "off"/);
  assert.match(source, /runStage: !restage \? null :/);
  assert.match(source, /AMUX_V22_STAGE_AUTH_SCRIPT or AMUX_V22_CLAUDE_WORKERS is not set/);
});
