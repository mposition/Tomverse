/** Local Ubuntu S0: stage the installed CLI executables and invoke only
 * --version inside the empty-egress namespace. No model request or auth file. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { createAmuxV4EgressProxy } from "../lib/amux/ideaLocalEgressProxy.ts";
import { amuxV4VerifiedSandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";

let phase = "setup";
const listen = (server, path) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(path, () => { server.off("error", reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));

async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function runVersion(socketDirectory, mount, command) {
  const args = await amuxV4VerifiedSandboxArgs(socketDirectory, command, mount);
  const child = spawn("bwrap", args, { cwd: "/tmp", shell: false,
    env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let size = 0;
  let diagnostic = "";
  child.stderr.on("data", (bytes) => {
    diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 512);
  });
  child.stdout.on("data", (bytes) => {
    size += bytes.length;
    if (size > 2_048) child.kill("SIGKILL");
    else chunks.push(bytes);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) {
      const safeDiagnostic = diagnostic.replace(/[^A-Za-z0-9 _.,:/-]/g, "?").slice(0, 160);
      throw new Error(`isolated CLI version probe exited ${code}: ${safeDiagnostic}`);
    }
    assert.ok(size > 0 && size <= 2_048, "CLI version output was missing or oversized");
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    clearTimeout(timer);
    for (const bytes of chunks) bytes.fill(0);
  }
}

async function main() {
  assert.equal(process.platform, "linux", "run the bundled probe inside Ubuntu");
  const stageDirectory = await mkdtemp("/tmp/amux-v4-cli-s0-");
  let socketDirectory;
  let socketPath;
  const proxy = createAmuxV4EgressProxy([]);
  const staged = [];
  let listening = false;
  let runFailure;
  try {
    socketDirectory = await mkdtemp("/tmp/amux-v4-cli-s0-socket-");
    socketPath = join(socketDirectory, "proxy.sock");
    await chmod(stageDirectory, 0o700);
    await chmod(socketDirectory, 0o700);
    await listen(proxy, socketPath);
    listening = true;
    await chmod(socketPath, 0o600);
    for (const kind of ["codex", "claude"]) {
      phase = `stage_${kind}`;
      const source = await realpath(join(homedir(), ".local", "bin", kind));
      const path = join(stageDirectory, kind);
      staged.push(path);
      await copyFile(source, path);
      await chmod(path, 0o500);
      phase = `version_${kind}`;
      const version = await runVersion(socketDirectory,
        { path, sha256: await digest(path) }, [`/run/amux-cli/${kind}`, "--version"]);
      assert.match(version, kind === "codex" ? /^codex-cli [0-9]/ : /^[0-9]+\.[0-9]+\.[0-9]+/);
    }
    phase = "complete";
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    let cleanupFailure;
    const cleanup = async (step) => {
      try { await step(); } catch (error) { cleanupFailure ??= error; }
    };
    const unlinkIfPresent = async (path) => {
      try { await unlink(path); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
    if (listening) await cleanup(() => close(proxy));
    if (socketPath) await cleanup(() => unlinkIfPresent(socketPath));
    if (socketDirectory) await cleanup(() => rmdir(socketDirectory));
    for (const path of staged) await cleanup(() => unlinkIfPresent(path));
    await cleanup(() => rmdir(stageDirectory));
    if (cleanupFailure) {
      if (runFailure) throw new AggregateError([runFailure, cleanupFailure],
        "AMUX CLI S0 failed and cleanup failed");
      throw cleanupFailure;
    }
  }
  process.stdout.write("AMUX_V4_CLI_BINARY_S0_PASS\n");
}
main().catch((error) => {
  process.stderr.write(`AMUX_V4_CLI_BINARY_S0_FAIL:${phase}:${error?.message ?? "error"}\n`);
  process.exitCode = 1;
});
