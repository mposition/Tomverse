import { spawn } from "node:child_process";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { createAmuxV4EgressProxy } from "./ideaLocalEgressProxy.ts";
import { amuxV4VerifiedSandboxArgs } from "./ideaLocalSandboxArgs.mjs";

const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 65_536;
const DEADLINE_MS = 20_000;

const listen = (server, path) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(path, () => { server.off("error", reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));

/** A no-provider-call local worker slice. Only /usr/bin/node may run, the
 * network allowlist is empty, stdin/stdout are bounded, and the inherited
 * environment is discarded. Real CLI execution needs a separate reviewed
 * runner and owner activation; this helper cannot be switched to it. */
export async function runAmuxV4SyntheticAnalysis(command, input) {
  if (process.platform !== "linux" || !Array.isArray(command) ||
      command[0] !== "/usr/bin/node" ||
      !Buffer.isBuffer(input) || input.length === 0 ||
      input.length > MAX_INPUT_BYTES) {
    return { status: "refused" };
  }
  const directory = await mkdtemp("/tmp/amux-v4-synthetic-");
  const socketPath = join(directory, "proxy.sock");
  const proxy = createAmuxV4EgressProxy([]);
  let listening = false;
  let successfulOutput;
  let runFailure;
  try {
    await chmod(directory, 0o700);
    await listen(proxy, socketPath);
    listening = true;
    await chmod(socketPath, 0o600);
    const args = await amuxV4VerifiedSandboxArgs(directory, command);
    const child = spawn("bwrap", args, {
      cwd: "/tmp", env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    let timedOut = false;
    let tooLarge = false;
    const chunks = [];
    let outputBytes = 0;
    child.stdout.on("data", (bytes) => {
      outputBytes += bytes.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill("SIGKILL");
      } else { chunks.push(bytes); }
    });
    // Child diagnostics may contain input text. Drain but never retain them.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, DEADLINE_MS);
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      if (timedOut || tooLarge || exit.code !== 0 || exit.signal !== null) {
        for (const bytes of chunks) bytes.fill(0);
        return { status: timedOut ? "timeout" : tooLarge ? "output_limit" : "failed" };
      }
      const output = Buffer.concat(chunks);
      for (const bytes of chunks) bytes.fill(0);
      successfulOutput = output;
      return { status: "completed", output };
    } finally { clearTimeout(timer); }
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    let cleanupFailure;
    const cleanup = async (step) => {
      try { await step(); } catch (error) { cleanupFailure ??= error; }
    };
    if (listening) await cleanup(() => close(proxy));
    await cleanup(async () => {
      try { await unlink(socketPath); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
    await cleanup(() => rmdir(directory));
    if (cleanupFailure) {
      successfulOutput?.fill(0);
      if (runFailure) {
        throw new AggregateError([runFailure, cleanupFailure],
          "AMUX synthetic run and cleanup both failed");
      }
      throw cleanupFailure;
    }
  }
}
