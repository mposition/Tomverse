import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";

import { AMUX_V19_LOCAL_BRIDGE_SOURCE,
  planAmuxTrackedCheckoutSandbox,
  verifiedAmuxTrackedCheckoutSandbox } from "../lib/amux/ideaTrackedCheckoutSandbox.mjs";

const valid = {
  socketDirectory: "/tmp/amux-v4-proxy-1",
  cliMount: { path: "/tmp/amux-v4-cli-1/claude", sha256: "a".repeat(64) },
  authPath: "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key",
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
    source === valid.authPath && destination === "/run/amux-cli/anthropic-api-key"));
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
    { ...valid, cliMount: { ...valid.cliMount, path: "/tmp/other/claude" } },
  ]) assert.throws(() => planAmuxTrackedCheckoutSandbox(input));
});

test("v19 host boundary refuses an unverified prepared checkout", async () => {
  await assert.rejects(() => verifiedAmuxTrackedCheckoutSandbox(valid, {
    directory: "/tmp/amux-v19-checkout-other1", files: [],
  }), /unsafe tracked checkout/);
});
