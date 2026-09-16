// Runs the operator's installed Railway CLI against .railway/railway.ts.
//
// The CLI is not a dependency here on purpose: the npm package @railway/cli
// downloads its binary with tar 6, which carries critical advisories, and
// pinning it would put that into this public repository's dependency graph for
// a tool only an operator runs. Install or upgrade it yourself
// (docs.railway.com/cli#installing-the-cli).
//
// What this wrapper adds over typing `railway` directly:
//
// 1. A version floor. The TypeScript SDK refuses to evaluate under a CLI older
//    than 5.42.1, and says so only after the plan has started.
// 2. `process.env._`. The SDK finds "the CLI running me" through it; POSIX
//    shells set it and PowerShell does not. Without it the SDK spawns a bare
//    `railway`, which on Windows is an npm .cmd shim it cannot execute, and it
//    fails with the version error even when the CLI is new enough.
//
// RAILWAY_CLI_BIN overrides the lookup with an explicit executable path.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM_CLI_VERSION = [5, 42, 1];
const here = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";

const findCli = () => {
  if (process.env.RAILWAY_CLI_BIN) return process.env.RAILWAY_CLI_BIN;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const native = join(directory, windows ? "railway.exe" : "railway");
    if (existsSync(native)) return native;
    // An npm global install puts a .cmd shim on PATH and the binary beside it.
    const npmBinary = join(
      directory,
      "node_modules",
      "@railway",
      "cli",
      "bin",
      windows ? "railway.exe" : "railway"
    );
    if (windows && existsSync(join(directory, "railway.cmd")) && existsSync(npmBinary)) {
      return npmBinary;
    }
  }
  return null;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const cli = findCli();
if (!cli) {
  fail(
    "Railway CLI not found. Install it (docs.railway.com/cli#installing-the-cli), " +
      "or set RAILWAY_CLI_BIN to the executable."
  );
}
if (!existsSync(join(here, "node_modules", "railway"))) {
  fail("The Railway SDK is not installed. Run `npm run railway:iac:install` from the repository root.");
}

let versionText = "";
try {
  versionText = execFileSync(cli, ["--version"], { encoding: "utf8" });
} catch (error) {
  fail(
    `Could not run ${cli} --version (${error.message.split("\n")[0]}). ` +
      "RAILWAY_CLI_BIN must name the executable itself, not a .cmd shim."
  );
}
const version = versionText.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
const differing = version?.findIndex((part, index) => part !== MINIMUM_CLI_VERSION[index]);
const tooOld =
  !version || (differing !== -1 && version[differing] < MINIMUM_CLI_VERSION[differing]);
if (tooOld) {
  fail(
    `Railway CLI ${versionText.trim() || "(unknown version)"} at ${cli} is older than ` +
      `${MINIMUM_CLI_VERSION.join(".")}, which the IaC SDK requires. Upgrade it ` +
      "(`railway upgrade`, or reinstall), then run this again."
  );
}

const result = spawnSync(cli, process.argv.slice(2), {
  cwd: here,
  stdio: "inherit",
  env: { ...process.env, _: cli },
});

if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);
