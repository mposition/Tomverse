import assert from "node:assert/strict";
import test from "node:test";
import { Script, runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import { AMUX_V19_LOCAL_BRIDGE_SOURCE,
  planAmuxTrackedCheckoutSandbox,
  verifyAmuxPreparedCheckout,
  verifiedAmuxTrackedCheckoutSandbox } from "../lib/amux/ideaTrackedCheckoutSandbox.mjs";
import { AMUX_V19_CLAUDE_MAX_AUTH_PATH,
  verifyAmuxV19ClaudeMaxAuthSource } from
  "../lib/amux/ideaV19ClaudeMaxAuth.mjs";

const valid = {
  socketDirectory: "/tmp/amux-v4-proxy-1",
  cliMount: { path: "/tmp/amux-v4-cli-1/claude", sha256: "a".repeat(64) },
  authPath: AMUX_V19_CLAUDE_MAX_AUTH_PATH,
  checkoutDirectory: "/tmp/amux-v19-checkout-Ab12c3",
  modelId: "claude-opus-5-5", reasoningEffort: "high",
};

test("v19 sandbox mounts only scanned checkout and dedicated CLI materials", () => {
  const { args, cli } = planAmuxTrackedCheckoutSandbox(valid);
  assert.equal(cli.cwd, valid.checkoutDirectory);
  assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--setenv")),
    ["--chdir", valid.checkoutDirectory]);
  assert.ok(args.includes("--unshare-all"));
  assert.deepEqual(args.slice(args.indexOf("--", args.indexOf("--chdir"))),
    ["--", "/usr/bin/node", "-e", AMUX_V19_LOCAL_BRIDGE_SOURCE,
      "--", cli.binary, ...cli.args]);
  const binds = [];
  for (let i = 0; i < args.length - 2; i += 1)
    if (args[i] === "--ro-bind") binds.push([args[i + 1], args[i + 2]]);
  assert.ok(binds.some(([source, destination]) =>
    source === valid.checkoutDirectory && destination === valid.checkoutDirectory));
  assert.ok(binds.some(([source, destination]) =>
    source === valid.authPath && destination === "/run/amux-cli/claude-oauth-token"));
  assert.ok(!args.some((arg) => arg === "/run/amux-cli/anthropic-api-key"));
  assert.ok(!args.includes("--bind"));
  assert.ok(!args.includes("--share-net"));
  assert.ok(!args.some((arg) => typeof arg === "string" && arg.includes("/home/tommy/.codex")));
  assert.match(AMUX_V19_LOCAL_BRIDGE_SOURCE, /cwd = process\.cwd\(\)/);
  assert.doesNotMatch(AMUX_V19_LOCAL_BRIDGE_SOURCE, /cwd: "\/tmp"/);
  assert.doesNotThrow(() => new Script(AMUX_V19_LOCAL_BRIDGE_SOURCE));
});

test("v19 sandbox rejects checkout escape and foreign credential paths", () => {
  for (const input of [
    { ...valid, checkoutDirectory: "/home/tommy/source" },
    { ...valid, socketDirectory: "/tmp/other" },
    { ...valid, authPath: "/home/tommy/.codex/auth.json" },
    { ...valid, authPath: "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key" },
    { ...valid, cliMount: { ...valid.cliMount, path: "/tmp/other/claude" } },
  ]) assert.throws(() => planAmuxTrackedCheckoutSandbox(input));
});

test("v19 Max auth rejects the v4 API key before reading any credential", async () => {
  await assert.rejects(() => verifyAmuxV19ClaudeMaxAuthSource(
    "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key"),
  /invalid AMUX v19 Claude Max auth source/);
});

test("v19 bridge selects only the Max OAuth token for its child", () => {
  const cli = planAmuxTrackedCheckoutSandbox(valid).cli;
  const token = `sk-ant-oat01-${"a".repeat(32)}`;
  const server = new EventEmitter();
  server.listen = (_port, _host, callback) => callback();
  server.close = () => {};
  let childEnv;
  runInNewContext(AMUX_V19_LOCAL_BRIDGE_SOURCE, {
    Buffer,
    require: (name) => {
      if (name === "node:net") return { createServer: () => server };
      if (name === "node:child_process") return { spawn: (_binary, _args, options) => {
        childEnv = { ...options.env };
        return new EventEmitter();
      } };
      if (name === "node:fs") return { readFileSync: (path) => {
        assert.equal(path, "/run/amux-cli/claude-oauth-token");
        return Buffer.from(token);
      } };
      throw new Error("unexpected module");
    },
    process: {
      cwd: () => valid.checkoutDirectory,
      argv: ["/usr/bin/node", cli.binary, ...cli.args],
      env: { ANTHROPIC_API_KEY: "forbidden-api-key",
        ANTHROPIC_AUTH_TOKEN: "forbidden-auth-token" },
      stderr: { write: () => {} },
      exit: () => { throw new Error("bridge rejected valid command"); },
    },
  });
  assert.equal(childEnv.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("v19 bridge cannot launch with an Anthropic API key in the Max slot", () => {
  const cli = planAmuxTrackedCheckoutSandbox(valid).cli;
  const server = new EventEmitter();
  server.listen = (_port, _host, callback) => callback();
  server.close = () => {};
  let spawned = false;
  const bridgeProcess = {
    cwd: () => valid.checkoutDirectory,
    argv: ["/usr/bin/node", cli.binary, ...cli.args],
    env: {}, stderr: { write: () => {} },
    exit: () => { throw new Error("unexpected command rejection"); },
  };
  runInNewContext(AMUX_V19_LOCAL_BRIDGE_SOURCE, {
    Buffer,
    require: (name) => {
      if (name === "node:net") return { createServer: () => server };
      if (name === "node:child_process") return { spawn: () => {
        spawned = true;
        return new EventEmitter();
      } };
      if (name === "node:fs") return { readFileSync: () =>
        Buffer.from(`sk-ant-api03-${"a".repeat(32)}`) };
      throw new Error("unexpected module");
    },
    process: bridgeProcess,
  });
  assert.equal(spawned, false);
  assert.equal(bridgeProcess.exitCode, 2);
});

test("v19 host boundary refuses an unverified prepared checkout", async () => {
  await assert.rejects(() => verifiedAmuxTrackedCheckoutSandbox(valid, {
    directory: "/tmp/amux-v19-checkout-other1", files: [],
  }), /unsafe tracked checkout/);
});

test("v19 bridge rejects a command with a broader Read grant", () => {
  const cli = planAmuxTrackedCheckoutSandbox(valid).cli;
  const args = [...cli.args];
  args[args.indexOf("--allowedTools") + 1] = "Read,Grep,Glob";
  let rejected = false;
  try {
    runInNewContext(AMUX_V19_LOCAL_BRIDGE_SOURCE, {
      require: () => ({}),
      process: {
        cwd: () => valid.checkoutDirectory,
        argv: ["/usr/bin/node", cli.binary, ...args],
        stderr: { write: () => {} },
        exit: () => { rejected = true; throw new Error("rejected"); },
      },
    });
  } catch (error) {
    assert.equal(error.message, "rejected");
  }
  assert.equal(rejected, true);
});

test("v19 checkout verification rejects extra, missing, linked and writable files", {
  skip: process.platform !== "linux",
}, async (t) => {
  for (const scenario of ["valid", "internal_hardlink", "extra", "missing",
    "duplicate", "symlink", "hardlink", "writable"]) {
    await t.test(scenario, async () => {
      const directory = await mkdtemp("/tmp/amux-v19-checkout-");
      const outside = await mkdtemp("/tmp/amux-v19-test-");
      try {
        await chmod(directory, 0o700);
        await writeFile(`${directory}/source.txt`, "safe", { mode: 0o400 });
        const files = scenario === "missing" ? [] : ["source.txt"];
        if (scenario === "internal_hardlink") {
          await link(`${directory}/source.txt`, `${directory}/copy.txt`);
          files.push("copy.txt");
        } else if (scenario === "extra") {
          await writeFile(`${directory}/extra.txt`, "extra", { mode: 0o400 });
        } else if (scenario === "duplicate") {
          files.push("source.txt");
        } else if (scenario === "symlink") {
          await symlink("source.txt", `${directory}/link.txt`);
        } else if (scenario === "hardlink") {
          await link(`${directory}/source.txt`, `${outside}/alias.txt`);
        } else if (scenario === "writable") {
          await chmod(`${directory}/source.txt`, 0o600);
        }
        const check = () => verifyAmuxPreparedCheckout({ directory, files });
        if (scenario === "valid" || scenario === "internal_hardlink")
          await assert.doesNotReject(check);
        else await assert.rejects(check, /unsafe tracked checkout/);
      } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});
