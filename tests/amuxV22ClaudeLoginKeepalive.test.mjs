import assert from "node:assert/strict";
import test from "node:test";

import {
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

function harness(logins, { cliFails = false, stageFails = false } = {}) {
  const calls = [];
  const lines = [];
  let index = 0;
  return {
    calls, lines,
    deps: {
      now: () => NOW,
      readLogin: async () => logins[Math.min(index, logins.length - 1)],
      runCli: async (args) => {
        calls.push(args[0] === "-p" ? "prompt" : args.join(" "));
        index += 1;
        if (cliFails) throw new Error("exit 1");
      },
      runStage: async () => { calls.push("stage"); if (stageFails) throw new Error("exit 1"); },
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

test("a refresh token with less than a day left warns", async () => {
  const h = harness([login({ refreshTokenExpiresAt: NOW + 2 * HOUR })]);
  await runClaudeLoginKeepalive(h.deps);
  assert.equal(h.lines[0].warning, "relogin_soon");
});
