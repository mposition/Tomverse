import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { chmod, mkdtemp, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { amuxV4VerifiedSandboxArgs,
  verifyAmuxV4SandboxSocket, verifyAmuxV4StagedCliBinary } from "../lib/amux/ideaLocalSandboxArgs.mjs";

test("AMUX v4 socket preflight accepts only a private real Unix socket", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp("/tmp/amux-v4-socket-test-");
  const socketPath = join(directory, "proxy.sock");
  const server = createServer();
  try {
    await chmod(directory, 0o700);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await verifyAmuxV4SandboxSocket(directory);
    const args = await amuxV4VerifiedSandboxArgs(directory, ["/usr/bin/node"]);
    assert.ok(args.includes("--clearenv"));

    await chmod(socketPath, 0o660);
    await assert.rejects(verifyAmuxV4SandboxSocket(directory), TypeError);
    await assert.rejects(amuxV4VerifiedSandboxArgs(directory,
      ["/usr/bin/node"]), TypeError);
    await chmod(socketPath, 0o600);

    await chmod(directory, 0o750);
    await assert.rejects(verifyAmuxV4SandboxSocket(directory), TypeError);
    await chmod(directory, 0o700);

    const linkPath = `${directory}-link`;
    await symlink(directory, linkPath);
    try {
      await assert.rejects(verifyAmuxV4SandboxSocket(linkPath), TypeError);
    } finally {
      await unlink(linkPath);
    }

    await new Promise((resolve) => server.close(resolve));
    await writeFile(socketPath, "not a socket", { mode: 0o600 });
    await assert.rejects(verifyAmuxV4SandboxSocket(directory), TypeError);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});

test("AMUX v4 staged CLI preflight refuses changed bytes, loose modes and symlinks", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp("/tmp/amux-v4-cli-test-");
  const path = join(directory, "codex");
  const linkPath = join(directory, "claude");
  const bytes = Buffer.from("synthetic-cli-binary");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    await chmod(directory, 0o700);
    await writeFile(path, bytes, { mode: 0o500 });
    await chmod(path, 0o500);
    await verifyAmuxV4StagedCliBinary({ path, sha256 });
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path, sha256: "0".repeat(64) }),
      /digest changed/);

    await chmod(path, 0o600);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path, sha256 }), TypeError);
    await chmod(path, 0o500);

    await symlink(path, linkPath);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path: linkPath, sha256 }), TypeError);
  } finally {
    await unlink(linkPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});
