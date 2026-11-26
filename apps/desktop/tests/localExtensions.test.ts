import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { desktopLocalExtensionsCopy } from "../../../locales/desktopLocalExtensions";
import { localExtensionsReply } from "../src/host/local-extensions";
import { localExtensionsCommand } from "../src/local-extensions-contract";

const FIXTURE = fileURLToPath(new URL("../../tomverse-cli/tests/fixtures/mcp-server.mjs", import.meta.url));
const dir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), `tvd-${prefix}-`)));

const setup = (marker: string) => {
  const home = dir("home");
  const claudeDir = dir("claude");
  const root = dir("root");
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: process.execPath, args: [FIXTURE] } } }));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MARKER: marker } } } }));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
  return { folders: { home, claudeDir }, root };
};

test("the IPC takes typed commands only: no path, command line or address", () => {
  assert.equal(localExtensionsCommand.safeParse({ type: "list", path: "/tmp/x" }).success, false);
  assert.equal(localExtensionsCommand.safeParse({ type: "mcp-approve", id: "../x", hash: "a".repeat(64) }).success, false);
  assert.equal(localExtensionsCommand.safeParse({ type: "mcp-approve", id: "repo", hash: "short" }).success, false);
  assert.equal(localExtensionsCommand.safeParse({ type: "mcp-check", id: "repo", command: "node" }).success, false);
  assert.equal(localExtensionsCommand.safeParse({ type: "hook-enable", hash: "a".repeat(64), enabled: "yes" }).success, false);
  assert.equal(localExtensionsCommand.safeParse({ type: "mcp-enable", id: "repo", enabled: false }).success, true);
});

test("the list shows what is yours and what the project brings, and nothing runs to show it", async () => {
  const marker = join(dir("marker"), "started.txt");
  const { folders, root } = setup(marker);
  const view = await localExtensionsReply(root, { type: "list" }, folders);
  assert.deepEqual(view.mcp.map((s) => [s.id, s.scope, s.state]), [["mine", "user", "ready"], ["repo", "project", "pending_approval"]]);
  assert.deepEqual(view.hooks.map((h) => [h.event, h.scope, h.state, h.source]), [["Stop", "project", "pending_approval", "settings.json"]]);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await localExtensionsReply(null, { type: "list" }, folders), { project: false, mcp: [], hooks: [], problems: [] });
});

test("approving needs the hash that was shown; a changed definition is not approved; a pending server is never started to be checked", async () => {
  const marker = join(dir("marker"), "started.txt");
  const { folders, root } = setup(marker);
  const repo = (await localExtensionsReply(root, { type: "list" }, folders)).mcp.find((s) => s.id === "repo")!;
  // The window shows a server, the file changes, then the person clicks Approve for what they saw.
  const stale = await localExtensionsReply(root, { type: "mcp-approve", id: "repo", hash: "0".repeat(64) }, folders);
  assert.equal(stale.mcp.find((s) => s.id === "repo")!.state, "pending_approval");
  const unchecked = await localExtensionsReply(root, { type: "mcp-check", id: "repo" }, folders);
  assert.equal(unchecked.check, undefined);
  assert.equal(existsSync(marker), false, "an unapproved server is not launched, not even to check it");
  const approved = await localExtensionsReply(root, { type: "mcp-approve", id: "repo", hash: repo.hash }, folders);
  assert.equal(approved.mcp.find((s) => s.id === "repo")!.state, "ready");
  const checked = await localExtensionsReply(root, { type: "mcp-check", id: "repo" }, folders);
  assert.deepEqual([checked.check?.state, (checked.check?.toolCount ?? 0) > 0], ["connected", true]);
  assert.equal(existsSync(marker), true);
  const off = await localExtensionsReply(root, { type: "mcp-enable", id: "repo", enabled: false }, folders);
  assert.equal(off.mcp.find((s) => s.id === "repo")!.state, "disabled");
  // A user's own server is never "approved" through this path; it needs none.
  const own = (await localExtensionsReply(root, { type: "list" }, folders)).mcp.find((s) => s.id === "mine")!;
  assert.equal((await localExtensionsReply(root, { type: "mcp-approve", id: "mine", hash: own.hash }, folders)).mcp.find((s) => s.id === "mine")!.state, "ready");
});

test("hooks are approved by hash and can be switched off", async () => {
  const { folders, root } = setup(join(dir("marker"), "x.txt"));
  const hook = (await localExtensionsReply(root, { type: "list" }, folders)).hooks[0]!;
  assert.equal((await localExtensionsReply(root, { type: "hook-approve", hash: "f".repeat(64) }, folders)).hooks[0]!.state, "pending_approval");
  assert.equal((await localExtensionsReply(root, { type: "hook-approve", hash: hook.hash }, folders)).hooks[0]!.state, "active");
  assert.equal((await localExtensionsReply(root, { type: "hook-enable", hash: hook.hash, enabled: false }, folders)).hooks[0]!.state, "disabled");
  assert.equal((await localExtensionsReply(root, { type: "hook-enable", hash: hook.hash, enabled: true }, folders)).hooks[0]!.state, "active");
});

test("every language has every line of the MCP and hooks wording", () => {
  const keys = Object.keys(desktopLocalExtensionsCopy.en).sort();
  for (const language of SUPPORTED_LANGUAGES) {
    assert.deepEqual(Object.keys(desktopLocalExtensionsCopy[language]).sort(), keys, language);
    for (const key of ["checkConnected"] as const) assert.match(desktopLocalExtensionsCopy[language][key], /\{count\}/, `${language}.${key}`);
    assert.match(desktopLocalExtensionsCopy[language].checkFailed, /\{detail\}/, language);
  }
});
