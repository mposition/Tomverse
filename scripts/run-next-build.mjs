// `npm run build` -- `next build`, with one recovery the release path needs.
//
// Turbopack's persistent cache is restored between builds. When the restored
// copy is internally inconsistent Turbopack panics instead of rebuilding cold,
// and a deploy fails for a reason that has nothing to do with the commit. That
// happened to production on 2026-08-24 (Railway deployment 0d227e99, main
// d031bf3): the diff was a list of model ids and its tests, and the build died
// on a missing `.sst` segment inside the cache it had just restored.
//
// So exactly one failure mode is retried: the cache-restore signature, once,
// after deleting the cache. Everything else exits on the first attempt with
// the child's own status. See scripts/run-next-build-core.mjs for why the
// match is deliberately narrow.

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TURBOPACK_CACHE_DIR,
  isRecoverableTurbopackCacheFailure,
} from "./run-next-build-core.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const forwardedArgs = process.argv.slice(2);

/**
 * Run `next build`, streaming its output through unchanged while also keeping
 * a copy to match against. Streaming matters: a build whose log only appears
 * after it finishes is a build nobody can watch.
 */
const runBuild = () =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
        "build",
        ...forwardedArgs,
      ],
      { cwd: repoRoot, stdio: ["inherit", "pipe", "pipe"] }
    );

    let output = "";
    const capture = (stream, sink) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        sink.write(chunk);
      });
    };
    capture(child.stdout, process.stdout);
    capture(child.stderr, process.stderr);

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });

const exitFrom = ({ code, signal }) => {
  // A signalled child has no exit code. Report it as a failure rather than
  // letting `null` become a silent success.
  if (signal) {
    console.error(`[build] next build terminated by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
};

const first = await runBuild();
if (first.code === 0 && !first.signal) process.exit(0);

if (!isRecoverableTurbopackCacheFailure(first.output)) exitFrom(first);

const cachePath = join(repoRoot, TURBOPACK_CACHE_DIR);
console.error(
  `\n[build] Turbopack could not read its persisted cache.\n` +
    `[build] This is the cache being unreadable, not the commit being broken:\n` +
    `[build] removing ${TURBOPACK_CACHE_DIR} and rebuilding cold, once.\n` +
    `[build] If the rebuild also fails, the failure is real -- read it, not this note.\n`
);
await rm(cachePath, { recursive: true, force: true });

const second = await runBuild();
if (second.code === 0 && !second.signal) {
  console.error(
    `\n[build] Cold rebuild succeeded. The discarded cache was the only problem.\n`
  );
  process.exit(0);
}
exitFrom(second);
