import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AMUX_V22_READ_ONLY_ALLOWED_TOOLS,
  AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
  AMUX_V22_READ_ONLY_RETRY_CAPABILITY,
  AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION,
  amuxV22ReadOnlyActualLauncherConfigDigest, amuxV22ReadOnlyClaudeArgs,
  amuxV22ReadOnlyLauncherDigests,
  amuxV22ReadOnlyLaunchScope, amuxV22ReadOnlyLaunchScopeDigest,
  amuxV22SidecarLaunchConfigFromEnvironment,
  inspectAmuxV22ReadOnlyLauncherConfig, inspectAmuxV22ReadOnlyLocalCustomizations,
  validateAmuxV22ReadOnlyRetryBinding } from
  "../lib/amux/v22ReadOnlyRetryProtocol.mjs";

const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const digest = (kind, value) => createHash("sha256")
  .update(`amux-v22-task-recovery-${kind}-v1\n`)
  .update(canonical(value)).digest("hex");
const profileConfigDigest = "1".repeat(64);
const scope = amuxV22ReadOnlyLaunchScope({ profileConfigDigest });
const retry = {
  version: 1,
  launchBindingId: "00000000-0000-4000-8000-000000000001",
  riskAcceptanceDigest: "2".repeat(64), safeStopEvidenceDigest: "3".repeat(64),
  launchProofDigest: "4".repeat(64),
  launchScopeDigest: amuxV22ReadOnlyLaunchScopeDigest(scope),
  launcherPolicyVersion: AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
  launcherConfigDigest: scope.launcherConfigDigest,
  fixedArgvDigest: scope.fixedArgvDigest, toolPolicyDigest: scope.toolPolicyDigest,
  profileConfigDigest, briefDigest: "5".repeat(64), provider: "anthropic",
  modelId: "claude-opus-5-5", routeId: "route:one",
  routePolicyDigest: "6".repeat(64), catalogApprovalId: "catalog:one",
  catalogVersion: "catalog-v1", pricingVersion: "pricing-v1",
  costReceiptDigest: "7".repeat(64), additionalCapMicroUsd: "3400000",
  worstExposureMicroUsd: "6800000", role: "investigate",
};

test("read-only launcher digests use the frozen canonical bases", () => {
  assert.equal(AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION, 1);
  assert.equal(AMUX_V22_READ_ONLY_RETRY_CAPABILITY, "read_only_retry_v1");
  assert.deepEqual(AMUX_V22_READ_ONLY_ALLOWED_TOOLS, ["Glob", "Grep", "Read"]);
  const expected = {
    launcherConfigDigest: digest("read-only-launcher-config", {
      version: 1, launcherPolicyVersion: "amux-v22-read-only-retry-v1",
      targetHost: "amux-ubuntu",
      execStart: ["/usr/bin/node", "/opt/tomverse-amux-v22/task-sidecar.mjs"],
      profileConfigDigest,
    }),
    fixedArgvDigest: digest("read-only-fixed-argv", {
      version: 1, role: "investigate", permissionMode: "dontAsk",
      allowedTools: ["Glob", "Grep", "Read"], maxTurns: 8, outputFormat: "json",
    }),
    toolPolicyDigest: digest("read-only-tool-policy", {
      version: 1, allowedTools: ["Glob", "Grep", "Read"],
      deniedCapabilities: ["Bash", "Edit", "Write", "MCP", "browser", "network",
        "github_write", "external_action"],
    }),
  };
  assert.deepEqual(amuxV22ReadOnlyLauncherDigests(profileConfigDigest), expected);
  assert.deepEqual(scope, { version: 1,
    launcherPolicyVersion: "amux-v22-read-only-retry-v1", ...expected,
    profileConfigDigest, role: "investigate", allowedTools: ["Glob", "Grep", "Read"] });
  assert.equal(amuxV22ReadOnlyLaunchScopeDigest(scope),
    digest("read-only-launch-scope", scope));
});

test("read-only retry binding is exact, capped, and scope-bound", () => {
  assert.deepEqual(validateAmuxV22ReadOnlyRetryBinding(retry), { ok: true });
  const mutations = [
    { unknown: true }, { version: 2 }, { provider: "openai" }, { role: "design" },
    { launchBindingId: "not-a-uuid" }, { additionalCapMicroUsd: "3400001" },
    { additionalCapMicroUsd: "1", worstExposureMicroUsd: "6800000" },
    { worstExposureMicroUsd: "6800001" }, { fixedArgvDigest: "8".repeat(64) },
    { launchScopeDigest: "9".repeat(64) },
  ];
  for (const mutation of mutations)
    assert.equal(validateAmuxV22ReadOnlyRetryBinding({ ...retry, ...mutation }).ok,
      false, JSON.stringify(mutation));
});

test("actual launcher digest binds every child path and executable artifact", () => {
  const environment = {
    TOMVERSE_AMUX_V22_WORKER: "claude-chore",
    TOMVERSE_AMUX_V22_CLAUDE_BINARY: "/usr/bin/claude",
    TOMVERSE_AMUX_V22_WORKTREE: "/srv/tomverse/worktrees/claude-chore",
    TOMVERSE_AMUX_V22_HOME: "/home/tommy",
    TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR: "/home/tommy/.claude-chore",
  };
  const config = amuxV22SidecarLaunchConfigFromEnvironment(environment);
  assert.deepEqual(config, { worker: "claude-chore", binaryPath: "/usr/bin/claude",
    worktreePath: "/srv/tomverse/worktrees/claude-chore", homePath: "/home/tommy",
    claudeConfigDir: "/home/tommy/.claude-chore" });
  const basis = { ...config, profileConfigDigest,
    nodeArtifactDigest: "a".repeat(64), sidecarArtifactDigest: "b".repeat(64),
    cliArtifactDigest: "c".repeat(64), localCustomizationDigest: "3".repeat(64),
    worktreeIdentityDigest: "d".repeat(64),
    homeIdentityDigest: "e".repeat(64), claudeConfigIdentityDigest: "f".repeat(64) };
  const actual = amuxV22ReadOnlyActualLauncherConfigDigest(basis);
  assert.match(actual, /^[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries({
    binaryPath: "/usr/local/bin/claude", worktreePath: "/srv/tomverse/worktrees/other",
    homePath: "/home/other", claudeConfigDir: "/home/tommy/.claude-other",
    nodeArtifactDigest: "7".repeat(64), sidecarArtifactDigest: "8".repeat(64),
    cliArtifactDigest: "9".repeat(64), worktreeIdentityDigest: "0".repeat(64),
    homeIdentityDigest: "1".repeat(64), claudeConfigIdentityDigest: "2".repeat(64),
    localCustomizationDigest: "4".repeat(64),
  })) assert.notEqual(amuxV22ReadOnlyActualLauncherConfigDigest({ ...basis, [key]: value }),
    actual, key);
  const actualScope = amuxV22ReadOnlyLaunchScope({ profileConfigDigest,
    launcherConfigDigest: actual });
  assert.equal(validateAmuxV22ReadOnlyRetryBinding({ ...retry,
    launcherConfigDigest: actual, launchScopeDigest:
      amuxV22ReadOnlyLaunchScopeDigest(actualScope) }).ok, true);
  for (const value of ["relative", "/tmp/../etc", "/tmp/path/"])
    assert.throws(() => amuxV22SidecarLaunchConfigFromEnvironment({ ...environment,
      TOMVERSE_AMUX_V22_WORKTREE: value }));
});

test("launcher customization measurement binds bytes and rejects active command sources", async () => {
  const config = { worker: "claude-chore", binaryPath: "/usr/bin/claude",
    worktreePath: "/srv/tomverse/worktrees/claude-chore", homePath: "/home/tommy",
    claudeConfigDir: "/home/tommy/.claude-chore" };
  const settingsPath = "/home/tommy/.claude-chore/settings.json";
  const settings = new Map([[settingsPath, Buffer.from("{}")]]);
  const missing = new Set([
    "/home/tommy/.claude-chore/.claude.json", "/home/tommy/.claude-chore.json",
    "/home/tommy/.claude.json",
    "/srv/tomverse/worktrees/claude-chore/.claude/settings.json",
    "/srv/tomverse/worktrees/claude-chore/.claude/settings.local.json",
    "/srv/tomverse/worktrees/claude-chore/.mcp.json",
    "/home/tommy/.claude-chore/remote-settings.json",
    "/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-mcp.json",
    "/etc/claude-code/managed-CLAUDE.md",
    ...["commands", "agents", "skills", "hooks", "plugins"].flatMap(name => [
      `/home/tommy/.claude-chore/${name}`,
      `/srv/tomverse/worktrees/claude-chore/.claude/${name}`,
    ]),
  ]);
  let inode = 30;
  const directoryInfo = () => ({ isSymbolicLink: () => false,
    isDirectory: () => true, isFile: () => false, uid: 0, mode: 0o40755,
    nlink: 1, size: 0, dev: 1, ino: 20, ctimeMs: 1 });
  const sourceInfo = path => ({ isSymbolicLink: () => false,
    isDirectory: () => false, isFile: () => true, uid: 0, mode: 0o100444,
    nlink: 1, size: settings.get(path).length, dev: 1, ino: inode,
    ctimeMs: 1 });
  const lstatSettings = async path => {
    if (settings.has(path)) return sourceInfo(path);
    if (missing.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return directoryInfo();
  };
  const openSettings = async path => ({ stat: async () => sourceInfo(path),
    read: async (buffer, offset, length, position) => {
      const source = settings.get(path).subarray(position, position + length);
      source.copy(buffer, offset); return { bytesRead: source.length };
    }, close: async () => {} });
  const measured = await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] });
  assert.equal(measured.current, true);
  settings.set(settingsPath, Buffer.from("{ }")); inode += 1;
  const changed = await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] });
  assert.equal(changed.current, true);
  assert.notEqual(changed.localCustomizationDigest, measured.localCustomizationDigest);
  settings.delete(settingsPath); missing.add(settingsPath);
  const deleted = await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] });
  assert.equal(deleted.current, true);
  assert.notEqual(deleted.localCustomizationDigest, changed.localCustomizationDigest);
  settings.set(settingsPath, Buffer.from("{}")); missing.delete(settingsPath);
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config, {
    lstat: async path => path === settingsPath
      ? { ...sourceInfo(path), isSymbolicLink: () => true }
      : lstatSettings(path), open: openSettings, readdir: async () => [],
  }), { current: false });
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config, {
    lstat: async path => path === settingsPath
      ? { ...sourceInfo(path), mode: 0o100466 }
      : lstatSettings(path), open: openSettings, readdir: async () => [],
  }), { current: false });
  let openedStats = 0;
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config, {
    lstat: lstatSettings, open: async path => path === settingsPath ? {
      stat: async () => ({ ...sourceInfo(path), ino: openedStats++ === 0 ? inode : inode + 1 }),
      read: async (buffer, offset, length, position) => {
        const source = settings.get(path).subarray(position, position + length);
        source.copy(buffer, offset); return { bytesRead: source.length };
      }, close: async () => {},
    } : openSettings(path), readdir: async () => [],
  }), { current: false });
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config, {
    lstat: lstatSettings, open: async path => {
      if (path === settingsPath) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return openSettings(path);
    }, readdir: async () => [],
  }), { current: false });
  settings.set(settingsPath, Buffer.alloc(262_145, 0x20));
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] }),
  { current: false });
  settings.set(settingsPath, Buffer.from('{"hooks":{}}'));
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] }),
  { current: false });
  settings.set(settingsPath, Buffer.from("{}"));
  const managedPath = "/etc/claude-code/managed-settings.json";
  missing.delete(managedPath); settings.set(managedPath, Buffer.from("{}"));
  const managed = await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] });
  assert.equal(managed.current, true);
  assert.notEqual(managed.localCustomizationDigest, deleted.localCustomizationDigest);
  settings.set(managedPath, Buffer.from('{"hooks":{"SessionStart":[]}}'));
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] }),
  { current: false });
  settings.delete(managedPath); missing.add(managedPath);
  const mcpPath = "/srv/tomverse/worktrees/claude-chore/.mcp.json";
  missing.delete(mcpPath);
  settings.set(mcpPath, Buffer.from('{"mcpServers":{"exec":{"command":"sh"}}}'));
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => [] }),
  { current: false });
  settings.delete(mcpPath); missing.add(mcpPath);
  missing.delete("/home/tommy/.claude-chore/plugins");
  assert.deepEqual(await inspectAmuxV22ReadOnlyLocalCustomizations(config,
    { lstat: lstatSettings, open: openSettings, readdir: async () => ["command.js"] }),
  { current: false });
});

test("launcher measurement rejects artifacts and unobservable remote managed policy", async () => {
  const config = { worker: "claude-chore", binaryPath: "/usr/bin/claude",
    worktreePath: "/srv/tomverse/worktrees/claude-chore", homePath: "/home/tommy",
    claudeConfigDir: "/home/tommy/.claude-chore" };
  const bytes = new Map([["/usr/bin/node", Buffer.from("node")],
    ["/opt/tomverse-amux-v22/task-sidecar.mjs", Buffer.from("sidecar")],
    ["/usr/bin/claude", Buffer.from("claude")]]);
  const fileInfo = (path, change = {}) => ({ isSymbolicLink: () => false,
    isDirectory: () => false, isFile: () => true, uid: 0, mode: 0o100555,
    nlink: 1, size: bytes.get(path).length, dev: 1, ino: [...bytes.keys()].indexOf(path) + 1,
    ctimeMs: 1, ...change });
  const directoryInfo = () => ({ isSymbolicLink: () => false,
    isDirectory: () => true, isFile: () => false, uid: 0, mode: 0o40755,
    nlink: 1, size: 0, dev: 1, ino: 20, ctimeMs: 1 });
  const knownSources = new Set([
    "/home/tommy/.claude-chore/settings.json", "/home/tommy/.claude-chore/.claude.json",
    "/home/tommy/.claude-chore.json", "/home/tommy/.claude.json",
    "/srv/tomverse/worktrees/claude-chore/.claude/settings.json",
    "/srv/tomverse/worktrees/claude-chore/.claude/settings.local.json",
    "/srv/tomverse/worktrees/claude-chore/.mcp.json",
    "/home/tommy/.claude-chore/remote-settings.json",
    "/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-mcp.json",
    "/etc/claude-code/managed-CLAUDE.md",
    ...["commands", "agents", "skills", "hooks", "plugins"].flatMap(name => [
      `/home/tommy/.claude-chore/${name}`,
      `/srv/tomverse/worktrees/claude-chore/.claude/${name}`,
    ]),
  ]);
  const lstat = async (path, change = {}) => {
    if (bytes.has(path)) return fileInfo(path, change);
    if (knownSources.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return directoryInfo();
  };
  const open = async path => ({ stat: async () => lstat(path),
    read: async (buffer, _offset, length, position) => {
      const source = bytes.get(path).subarray(position, position + length);
      source.copy(buffer); return { bytesRead: source.length };
    }, close: async () => {} });
  const measured = await inspectAmuxV22ReadOnlyLauncherConfig(config, profileConfigDigest,
    { uid: 1000, lstat, open, readdir: async () => [] });
  assert.deepEqual(measured, { current: false });
  for (const change of [{ isSymbolicLink: () => true }, { mode: 0o100575 }]) {
    const rejected = await inspectAmuxV22ReadOnlyLauncherConfig(config, profileConfigDigest,
      { uid: 1000, lstat: path => path === config.binaryPath ? lstat(path, change) : lstat(path),
        open });
    assert.deepEqual(rejected, { current: false });
  }
});

test("read-only CLI argv exposes only fixed inspect tools before provider launch", () => {
  const args = amuxV22ReadOnlyClaudeArgs({ role: "investigate",
    modelId: retry.modelId, budgetMicrousd: 3_400_000, readOnlyRetry: retry });
  assert.deepEqual(args, ["-p", "--output-format", "json", "--no-session-persistence",
    "--no-chrome", "--strict-mcp-config", "--restricted", "--permission-prompts", "none",
    "--permission-mode", "dontAsk", "--model", retry.modelId, "--max-turns", "8",
    "--max-budget-usd", "3.400000", "--tools", "Glob,Grep,Read",
    "--allowedTools", "Glob,Grep,Read"]);
  assert.equal(args.some(value => /Bash|Edit|Write|MCP|WebFetch|WebSearch/.test(value)), false);
  assert.throws(() => amuxV22ReadOnlyClaudeArgs({ role: "investigate",
    modelId: retry.modelId, budgetMicrousd: 3_400_001, readOnlyRetry: retry }));
});
