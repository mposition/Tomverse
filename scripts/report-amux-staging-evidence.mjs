import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const run = (command, args, options = {}) => {
  let result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  // A Windows-created worktree has an absolute Windows gitdir pointer; WSL's
  // native git cannot resolve it, while git.exe can without altering state.
  if (command === "git" && result.status !== 0 && process.platform === "linux") {
    result = spawnSync("git.exe", args, {
      cwd: process.cwd(),
      encoding: options.encoding ?? "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed; no staging evidence was generated`);
  }
  return result.stdout;
};

const sourceSha = run("git", ["rev-parse", "HEAD"]).trim();
if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
  throw new Error("AMUX evidence requires an exact 40-character source SHA");
}

const diff = run("git", ["diff", "--binary", "HEAD", "--"], { encoding: "buffer" });
const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean)
  .sort();
const digest = createHash("sha256").update(sourceSha).update(diff);
for (const path of untracked) {
  digest.update("\0").update(path).update("\0").update(readFileSync(path));
}
const dirty = diff.length > 0 || untracked.length > 0;

const enumeratedTests = (packageName) => {
  const listing = run("cargo", ["test", "-p", packageName, "--locked", "--", "--list"]);
  const count = listing.match(/^([0-9]+) tests?, [0-9]+ benchmarks?$/m);
  if (!count) {
    throw new Error(`AMUX ${packageName} test count could not be parsed`);
  }
  return Number(count[1]);
};

console.log(JSON.stringify({
  sourceSha,
  clean: !dirty,
  sourceIdentity: dirty ? `sha256:${digest.digest("hex")}` : sourceSha,
  amuxCoreTestsEnumerated: enumeratedTests("amux-core"),
  orchestratorTestsEnumerated: enumeratedTests("tomverse-orchestrator"),
  dbIntegrationObserved: false,
  stagingDeployShaObserved: false,
  runtimeFlagsObserved: false,
}, null, 2));
