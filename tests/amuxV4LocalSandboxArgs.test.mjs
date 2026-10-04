import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxV4SandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";
import { planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";

test("AMUX v4 sandbox uses a fixed isolated namespace and no inherited environment", () => {
  const args = amuxV4SandboxArgs("/tmp/amux-v4-probe-AbC123",
    ["/usr/bin/node", "-e", "process.stdout.write('ok')"]);
  assert.deepEqual(args.slice(0, 5), ["--unshare-all", "--die-with-parent",
    "--cap-drop", "ALL", "--clearenv"]);
  assert.ok(args.includes("--ro-bind"));
  assert.ok(args.includes("/run/amux"));
  assert.ok(args.includes("--tmpfs"));
  assert.ok(args.includes("--clearenv"));
  assert.equal(args.filter((value) => value === "--setenv").length, 3);
  assert.equal(args.includes("DATABASE_URL"), false);
  assert.equal(args.includes("GITHUB_TOKEN"), false);
  assert.deepEqual(args.slice(-3), ["/usr/bin/node", "-e", "process.stdout.write('ok')"]);
});

test("AMUX v4 sandbox refuses a mount outside its private temporary directory", () => {
  for (const directory of ["/", "/tmp", "/tmp/../home", "/home/operator",
    "/tmp/amux-v4-test/../secrets", "/tmp/amux-v4-test\n--bind"]) {
    assert.throws(() => amuxV4SandboxArgs(directory, ["/usr/bin/node"]), TypeError);
  }
});

test("AMUX v4 sandbox refuses shell or path escape as the executable", () => {
  for (const executable of ["node", "/bin/sh", "/usr/bin/../bin/node",
    "/usr/bin/node\0x", "/home/operator/.local/bin/claude"]) {
    assert.throws(() => amuxV4SandboxArgs("/tmp/amux-v4-test-abc", [executable]),
      TypeError);
  }
  assert.throws(() => amuxV4SandboxArgs("/tmp/amux-v4-test-abc", []), TypeError);
  const sparseCommand = new Array(3);
  sparseCommand[0] = "/usr/bin/node";
  sparseCommand[2] = "x";
  assert.throws(() => amuxV4SandboxArgs("/tmp/amux-v4-test-abc",
    sparseCommand), TypeError);
  assert.throws(() => amuxV4SandboxArgs("/tmp/amux-v4-test-abc",
    ["/usr/bin/node", "x".repeat(8_193)]), TypeError);
});

test("AMUX v4 CLI requires a digest-pinned private staged executable", () => {
  const socket = "/tmp/amux-v4-socket-abc";
  const path = "/tmp/amux-v4-cli-stage-abc/codex";
  const mount = { path, sha256: "a".repeat(64) };
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex", "--version"]), TypeError);
  const args = amuxV4SandboxArgs(socket, ["/run/amux-cli/codex", "--version"], mount);
  const bindAt = args.findIndex((value, index) => value === "--ro-bind" && args[index + 1] === path);
  assert.ok(bindAt > 0);
  assert.equal(args[bindAt + 2], "/run/amux-cli/codex");
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/claude", "--version"], mount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex", "exec", "prompt"], mount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex", "--version", "extra"], mount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/usr/bin/node"], mount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex"],
    { path: "/home/tommy/.local/bin/codex", sha256: "a".repeat(64) }), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex"],
    { path, sha256: "not-a-digest" }), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex", "--version"],
    { get path() { return path; }, sha256: "a".repeat(64) }), TypeError);
});

test("AMUX v4 analysis mount accepts only exact planned argv and dedicated credential file", () => {
  const socket = "/tmp/amux-v4-socket-abc";
  const selection = { provider: "openai", modelId: "gpt-5.6-sol",
    reasoningEffort: "high" };
  const plan = planAmuxV4AnalysisCliInvocation(selection);
  const cliMount = { path: "/tmp/amux-v4-cli-stage-abc/codex",
    sha256: "a".repeat(64) };
  const analysisMount = { ...selection,
    authPath: "/home/tommy/.amux-cli-profiles/codex/auth.json" };
  const args = amuxV4SandboxArgs(socket, plan.command, cliMount, analysisMount);
  const bindAt = args.findIndex((value, index) => value === "--bind" &&
    args[index + 1] === "/home/tommy/.amux-cli-profiles/codex/auth.json");
  assert.ok(bindAt > 0);
  assert.equal(args[bindAt + 2], "/tmp/.codex/auth.json");
  assert.ok(args.includes("/run/amux-cli/model-catalog.json"));
  assert.equal(args.includes("/home/tommy/.amux-cli-profiles/codex"), false);
  assert.equal(args.includes("/home/tommy/.codex/auth.json"), false);
  assert.ok(args.includes("/etc/ssl/certs"));
  assert.ok(args.includes("CODEX_HOME"));
  assert.equal(args.includes("DATABASE_URL"), false);
  assert.equal(args.includes("GITHUB_TOKEN"), false);
  assert.throws(() => amuxV4SandboxArgs(socket,
    [...plan.command, "--dangerously-bypass-approvals-and-sandbox"],
    cliMount, analysisMount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, plan.command, cliMount,
    { ...analysisMount, authPath: "/home/tommy/.ssh/id_ed25519" }), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, plan.command, cliMount,
    { ...analysisMount, provider: "anthropic" }), TypeError);
});

test("Claude bare analysis mounts only its dedicated read-only API key", () => {
  const selection = { provider: "anthropic", modelId: "claude-opus-5-5",
    reasoningEffort: "high" };
  const plan = planAmuxV4AnalysisCliInvocation(selection);
  const args = amuxV4SandboxArgs("/tmp/amux-v4-socket-abc", plan.command,
    { path: "/tmp/amux-v4-cli-stage-abc/claude", sha256: "a".repeat(64) },
    { ...selection,
      authPath: "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key" });
  const bindAt = args.findIndex((value, index) => value === "--ro-bind" &&
    args[index + 1] === "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key");
  assert.ok(bindAt > 0);
  assert.equal(args[bindAt + 2], "/run/amux-cli/anthropic-api-key");
  assert.equal(args.includes("/home/tommy/.amux-cli-profiles/claude-api"), false);
  assert.ok(args.includes("CLAUDE_CONFIG_DIR"));
  assert.deepEqual(args.slice(args.indexOf("CLAUDE_CODE_MAX_RETRIES"),
    args.indexOf("CLAUDE_CODE_MAX_RETRIES") + 4),
  ["CLAUDE_CODE_MAX_RETRIES", "0", "--setenv", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
  assert.ok(args.includes("128000"));
  assert.equal(args.includes("/home/tommy/.claude/.credentials.json"), false);
  assert.equal(args.includes("ANTHROPIC_API_KEY"), false);
  assert.ok(plan.command.includes("--bare"));
});
