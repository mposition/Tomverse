import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxV4SandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";

test("AMUX v4 sandbox uses a fixed isolated namespace and no inherited environment", () => {
  const args = amuxV4SandboxArgs("/tmp/amux-v4-probe-AbC123",
    ["/usr/bin/node", "-e", "process.stdout.write('ok')"]);
  assert.deepEqual(args.slice(0, 6), ["--unshare-all", "--die-with-parent",
    "--new-session", "--cap-drop", "ALL", "--clearenv"]);
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
  assert.throws(() => amuxV4SandboxArgs(socket, ["/usr/bin/node"], mount), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex"],
    { path: "/home/tommy/.local/bin/codex", sha256: "a".repeat(64) }), TypeError);
  assert.throws(() => amuxV4SandboxArgs(socket, ["/run/amux-cli/codex"],
    { path, sha256: "not-a-digest" }), TypeError);
});
