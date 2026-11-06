import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AMUX_V22_CLAUDE_AUTH_MIN_REMAINING_MS, AMUX_V22_CLAUDE_REFRESH_PLACEHOLDER,
  inspectAmuxV22ClaudeAuth, inspectAmuxV22WorkerAuth, stageAmuxV22WorkerAuth,
} from "../lib/amux/v22WorkerAuthStage.mjs";

const NOW = Date.UTC(2026, 10, 6, 8, 0, 0);
const ACCESS = "sk-ant-oat01-" + "a".repeat(40);
const REFRESH = "sk-ant-ort01-" + "b".repeat(40);
const login = (overrides = {}) => Buffer.from(JSON.stringify({ claudeAiOauth: {
  accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + 6 * 60 * 60 * 1000,
  refreshTokenExpiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
  scopes: ["user:inference", "user:profile"], subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x", ...overrides } }), "utf8");

test("the Claude copy keeps the access token and its expiry but never the refresh secret", () => {
  const { copy, expiresAt } = inspectAmuxV22ClaudeAuth(login(), NOW);
  const text = copy.toString("utf8");
  const auth = JSON.parse(text).claudeAiOauth;
  assert.equal(auth.accessToken, ACCESS);
  assert.equal(auth.refreshToken, AMUX_V22_CLAUDE_REFRESH_PLACEHOLDER);
  assert.equal(auth.expiresAt, expiresAt);
  assert.deepEqual(auth.scopes, ["user:inference", "user:profile"]);
  assert.equal(auth.subscriptionType, "max");
  assert.equal(text.includes(REFRESH), false);
  assert.equal("refreshTokenExpiresAt" in auth, false);
});

test("an expired, short-lived or malformed Claude login is refused", () => {
  const short = NOW + AMUX_V22_CLAUDE_AUTH_MIN_REMAINING_MS - 1;
  for (const bytes of [login({ expiresAt: NOW - 1 }), login({ expiresAt: short }),
    login({ accessToken: "x" }), login({ refreshToken: undefined }),
    login({ scopes: "user:inference" }), Buffer.from("{}"), Buffer.from("not json"),
    Buffer.from(JSON.stringify({ primaryApiKey: "sk-ant-api03-x" }))]) {
    assert.throws(() => inspectAmuxV22ClaudeAuth(bytes, NOW), /unsafe AMUX v22 worker sign-in/);
  }
  assert.doesNotThrow(() => inspectAmuxV22ClaudeAuth(
    login({ expiresAt: NOW + AMUX_V22_CLAUDE_AUTH_MIN_REMAINING_MS }), NOW));
});

test("only the three worker providers are staged", () => {
  assert.throws(() => inspectAmuxV22WorkerAuth("cursor", login(), NOW), /worker sign-in/);
  assert.throws(() => inspectAmuxV22WorkerAuth("__proto__", login(), NOW), /worker sign-in/);
});

async function box() {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-auth-"));
  const home = join(root, "home");
  const stateRoot = join(root, "state");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(stateRoot, "tomverse-amux-v22-claude-impl", "cli"), { recursive: true });
  return { home, stateRoot, cli: join(stateRoot, "tomverse-amux-v22-claude-impl", "cli") };
}

test("staging replaces the worker's copy with a private file and leaves no temporary", async () => {
  const { home, stateRoot, cli } = await box();
  await writeFile(join(home, ".claude", ".credentials.json"), login());
  await writeFile(join(cli, ".credentials.json"), "old");
  const staged = await stageAmuxV22WorkerAuth({ provider: "anthropic",
    worker: "claude-impl", home, stateRoot, now: NOW });
  assert.equal(staged.expiresAt, NOW + 6 * 60 * 60 * 1000);
  const written = await readFile(join(cli, ".credentials.json"), "utf8");
  assert.equal(JSON.parse(written).claudeAiOauth.accessToken, ACCESS);
  assert.equal(written.includes(REFRESH), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(cli, ".credentials.json"))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(cli), [".credentials.json"]);
});

test("a failed rename leaves no temporary copy of the token behind", async () => {
  const { home, stateRoot, cli } = await box();
  await writeFile(join(home, ".claude", ".credentials.json"), login());
  // The target name is a directory, so the rename after the write fails.
  await mkdir(join(cli, ".credentials.json", "occupied"), { recursive: true });
  await assert.rejects(stageAmuxV22WorkerAuth({ provider: "anthropic",
    worker: "claude-impl", home, stateRoot, now: NOW }));
  assert.deepEqual(await readdir(cli), [".credentials.json"]);
});

test("a refused login or a check run leaves the current copy unchanged", async () => {
  const { home, stateRoot, cli } = await box();
  await writeFile(join(cli, ".credentials.json"), "current");
  await writeFile(join(home, ".claude", ".credentials.json"), login({ expiresAt: NOW + 60_000 }));
  await assert.rejects(stageAmuxV22WorkerAuth({ provider: "anthropic", worker: "claude-impl",
    home, stateRoot, now: NOW }), /worker sign-in/);
  await writeFile(join(home, ".claude", ".credentials.json"), login());
  await stageAmuxV22WorkerAuth({ provider: "anthropic", worker: "claude-impl",
    home, stateRoot, now: NOW, check: true });
  assert.equal(await readFile(join(cli, ".credentials.json"), "utf8"), "current");
  await assert.rejects(stageAmuxV22WorkerAuth({ provider: "anthropic", worker: "../etc",
    home, stateRoot, now: NOW }), /worker sign-in/);
});
