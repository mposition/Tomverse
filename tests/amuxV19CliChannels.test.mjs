import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

import { AMUX_IDEA_ANALYSIS_PROVIDERS, AMUX_SUBSCRIPTION_AUTH_PROFILES } from
  "../lib/amux/ideaAnalysisChannelCore.ts";
import { planAmuxV4EgressTarget } from "../lib/amux/ideaLocalEgressCore.ts";
import { AMUX_V19_CLI_CHANNEL_PROVIDERS, amuxV19ChannelAdmits,
  amuxV19ChannelBridgeSource, amuxV19ChannelCommand, amuxV19CliChannel,
  planAmuxV19ChannelSandbox } from "../lib/amux/ideaV19CliChannels.mjs";

const directory = "/tmp/amux-v19-checkout-Ab12Cd";
const staged = (name) => `/tmp/amux-v4-cli-Zx9Yw8/${name}`;

test("one execution profile per subscription channel, with the server's sign-in profile", () => {
  assert.deepEqual([...AMUX_V19_CLI_CHANNEL_PROVIDERS].sort(),
    [...AMUX_IDEA_ANALYSIS_PROVIDERS].sort());
  for (const provider of AMUX_IDEA_ANALYSIS_PROVIDERS) {
    const channel = amuxV19CliChannel(provider);
    assert.equal(channel.provider, provider);
    assert.equal(channel.authProfile, AMUX_SUBSCRIPTION_AUTH_PROFILES[provider]);
    assert.ok(["served", "requested"].includes(channel.modelAttestation));
  }
  assert.equal(amuxV19CliChannel("gemini"), null);
  assert.equal(amuxV19CliChannel("__proto__"), null);
});

test("every measured egress host is a valid exact CONNECT target", () => {
  for (const provider of ["openai", "github-copilot", "cursor"]) {
    const { egressHosts } = amuxV19CliChannel(provider);
    assert.ok(egressHosts.length >= 1 && egressHosts.length <= 4, provider);
    for (const host of egressHosts) {
      assert.deepEqual(planAmuxV4EgressTarget({ method: "CONNECT",
        authority: `${host}:443`, approvedHosts: egressHosts }),
      { decision: "target_approved", host });
    }
  }
  assert.deepEqual(amuxV19CliChannel("github-copilot").egressHosts,
    ["api.github.com", "api.individual.githubcopilot.com"]);
  assert.deepEqual(amuxV19CliChannel("cursor").egressHosts,
    ["api2.cursor.sh", "agentn.global.api5.cursor.sh"]);
  assert.deepEqual(amuxV19CliChannel("openai").egressHosts, ["chatgpt.com"]);
});

test("Claude keeps its approved tuple; other channels admit a named model and a supported effort", () => {
  assert.equal(amuxV19ChannelAdmits({ provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high" }), true);
  for (const change of [{ modelId: "claude-sonnet-5" }, { reasoningEffort: "low" }]) {
    assert.equal(amuxV19ChannelAdmits({ provider: "anthropic",
      modelId: "claude-opus-5-5", reasoningEffort: "high", ...change }), false);
  }
  assert.equal(amuxV19ChannelAdmits({ provider: "github-copilot",
    modelId: "claude-sonnet-4.5", reasoningEffort: "max" }), true);
  assert.equal(amuxV19ChannelAdmits({ provider: "github-copilot",
    modelId: "gpt-5-mini", reasoningEffort: "ultra" }), false);
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.equal(amuxV19ChannelAdmits({ provider: "cursor",
      modelId: "gpt-5.6-sol-high", reasoningEffort: effort }), true);
  }
  // Codex stays closed until the owner decides how its shell may run.
  assert.equal(amuxV19CliChannel("openai").launchable, false);
  assert.equal(amuxV19ChannelAdmits({ provider: "openai",
    modelId: "gpt-6-luna", reasoningEffort: "low" }), false);
  for (const modelId of ["-p", "--model", "a b", "x{cwd}", "", "é"]) {
    assert.equal(amuxV19ChannelAdmits({ provider: "cursor", modelId,
      reasoningEffort: "high" }), false, modelId);
  }
  assert.equal(amuxV19ChannelAdmits({ provider: "cursor", modelId: "auto",
    reasoningEffort: "extreme" }), false);
});

test("each channel's command is read-only and takes the prompt on stdin", () => {
  assert.deepEqual(amuxV19ChannelCommand({ provider: "github-copilot", directory,
    modelId: "gpt-5-mini", reasoningEffort: "low" }), ["/run/amux-cli/copilot",
    "--output-format", "json", "--model", "gpt-5-mini", "--reasoning-effort", "low",
    "--available-tools", "view", "glob", "grep", "--allow-all-tools",
    "--no-ask-user", "--no-custom-instructions", "--no-auto-update",
    "--no-color", "--disable-builtin-mcps"]);
  assert.deepEqual(amuxV19ChannelCommand({ provider: "cursor", directory,
    modelId: "auto", reasoningEffort: "high" }), ["/run/amux-cli/cursor/node",
    "/run/amux-cli/cursor/index.js", "-p", "--output-format", "stream-json",
    "--mode", "ask", "--trust", "--workspace", directory, "--model", "auto"]);
  assert.deepEqual(amuxV19ChannelCommand({ provider: "openai", directory,
    modelId: "gpt-6-luna", reasoningEffort: "high" }), [
    "/run/amux-cli/codex/bin/codex", "exec", "--json", "--sandbox", "read-only",
    "--skip-git-repo-check", "--ephemeral", "-m", "gpt-6-luna",
    "-c", "model_reasoning_effort=\"high\"", "-"]);
  for (const input of [
    { provider: "anthropic", directory, modelId: "claude-opus-5-5", reasoningEffort: "high" },
    { provider: "cursor", directory: "/tmp/elsewhere", modelId: "auto", reasoningEffort: "high" },
    { provider: "cursor", directory: `${directory}/..`, modelId: "auto", reasoningEffort: "high" },
    { provider: "github-copilot", directory, modelId: "gpt-5-mini", reasoningEffort: "ultra" },
  ]) assert.throws(() => amuxV19ChannelCommand(input), TypeError);
});

test("the channel sandbox mounts only read-only copies and its own bridge", () => {
  for (const [provider, authFile, authTarget] of [
    ["github-copilot", "/tmp/amux-v19-auth-Qw3Er5/auth-token", "/run/amux-cli/auth-token"],
    ["cursor", "/tmp/amux-v19-auth-Qw3Er5/auth.json", "/tmp/.config/cursor/auth.json"],
    ["openai", "/tmp/amux-v19-auth-Qw3Er5/auth.json", "/tmp/.codex/auth.json"],
  ]) {
    const channel = amuxV19CliChannel(provider);
    const effort = provider === "cursor" ? "ultra" : "high";
    const { args, command } = planAmuxV19ChannelSandbox({ provider,
      socketDirectory: "/tmp/amux-v4-socket-Ab1", installPath: staged(channel.staged),
      authFile, checkoutDirectory: directory, modelId: "model-x", reasoningEffort: effort });
    assert.deepEqual(args.slice(0, 5), ["--unshare-all", "--die-with-parent",
      "--cap-drop", "ALL", "--clearenv"]);
    assert.equal(args.includes("--bind"), false, "nothing in the sandbox is writable on the host");
    const at = (flag, source) => args.findIndex((arg, index) =>
      arg === flag && args[index + 1] === source);
    assert.equal(args[at("--ro-bind", staged(channel.staged)) + 2], channel.mount);
    assert.equal(args[at("--ro-bind", authFile) + 2], authTarget);
    assert.equal(args[at("--ro-bind", directory) + 2], directory);
    assert.equal(args[at("--ro-bind", "/tmp/amux-v4-socket-Ab1") + 2], "/run/amux");
    assert.equal(args[args.indexOf("--chdir") + 1], directory);
    const tail = args.slice(args.lastIndexOf("--"));
    assert.deepEqual(tail, ["--", "model-x", provider === "cursor" ? "-" : effort]);
    assert.equal(args[args.indexOf("-e") + 1], amuxV19ChannelBridgeSource(provider));
    assert.ok(command.every((part) => !part.includes("{")));
    if (provider === "openai") {
      assert.equal(args[args.indexOf("CODEX_HOME") + 1], "/tmp/.codex");
    }
  }
  const valid = { provider: "cursor", socketDirectory: "/tmp/amux-v4-socket-Ab1",
    installPath: staged("cursor"), authFile: "/tmp/amux-v19-auth-Qw3Er5/auth.json",
    checkoutDirectory: directory, modelId: "auto", reasoningEffort: "high" };
  for (const change of [{ provider: "anthropic" }, { socketDirectory: "/tmp/other" },
    { installPath: staged("codex") }, { installPath: "/home/tommy/cursor" },
    { authFile: "/home/tommy/.config/cursor/auth.json" },
    { authFile: "/tmp/amux-v19-auth-Qw3Er5/auth-token" },
    { provider: "github-copilot", installPath: staged("copilot") },
    { checkoutDirectory: "/tmp/amux-v19-checkout-x" }]) {
    assert.throws(() => planAmuxV19ChannelSandbox({ ...valid, ...change }), TypeError,
      JSON.stringify(change));
  }
});

test("the bridge is valid JavaScript and refuses a cwd that is not a checkout", () => {
  for (const provider of ["openai", "github-copilot", "cursor"]) {
    const source = amuxV19ChannelBridgeSource(provider);
    assert.match(source, /bridge_command_invalid/);
    assert.equal(source.includes("COPILOT_GITHUB_TOKEN"), provider === "github-copilot");
    const run = spawnSync(process.execPath, ["-e", source, "--", "auto", "high"],
      { cwd: tmpdir(), encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 2, `${provider}: ${run.stderr}`);
    assert.equal(run.stderr.trim(), "bridge_command_invalid");
  }
  assert.throws(() => amuxV19ChannelBridgeSource("anthropic"), TypeError);
});
