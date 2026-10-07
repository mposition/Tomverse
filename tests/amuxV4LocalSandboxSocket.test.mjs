import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { chmod, link, mkdtemp, rmdir, symlink, truncate, unlink, writeFile } from "node:fs/promises";
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

    const cliDirectory = await mkdtemp("/tmp/amux-v4-cli-test-");
    const cliPath = join(cliDirectory, "codex");
    try {
      const bytes = Buffer.from("synthetic-cli-binary");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await chmod(cliDirectory, 0o700);
      await writeFile(cliPath, bytes, { mode: 0o500 });
      await chmod(cliPath, 0o500);
      const cliArgs = await amuxV4VerifiedSandboxArgs(directory,
        ["/run/amux-cli/codex", "--version"], { path: cliPath, sha256 });
      assert.ok(cliArgs.includes(cliPath));
    } finally {
      await unlink(cliPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await rmdir(cliDirectory);
    }

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
  const parentLink = `${directory}-link`;
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

    await link(path, linkPath);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path, sha256 }), TypeError);
    await unlink(linkPath);

    await symlink(path, linkPath);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path: linkPath, sha256 }), TypeError);
    await unlink(linkPath);

    await symlink(directory, parentLink);
    await assert.rejects(verifyAmuxV4StagedCliBinary({
      path: join(parentLink, "codex"), sha256,
    }), TypeError);
    await unlink(parentLink);

    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(0));
    await chmod(path, 0o500);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path, sha256 }), TypeError);
    await chmod(path, 0o600);
    await truncate(path, 512 * 1024 * 1024 + 1);
    await chmod(path, 0o500);
    await assert.rejects(verifyAmuxV4StagedCliBinary({ path, sha256 }), TypeError);
  } finally {
    await unlink(linkPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(parentLink).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});
