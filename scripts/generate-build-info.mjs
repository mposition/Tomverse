// Runs once as an npm `prebuild` step (before `next build`). Captures the
// one piece of build metadata Railway does not expose as an environment
// variable -- when this artifact was built -- plus a git-derived fallback
// commit/branch for local or non-Railway builds. Everything else
// (commitSha, environment, deploymentId) is read live from process.env at
// request time in lib/buildInfo.ts, matching the existing
// sentry.server.config.ts / sentry.edge.config.ts precedent -- this script
// never needs to run again after a build, and must never run at runtime.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "generated",
  "build-info.generated.json"
);

const runGit = (args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const buildInfo = {
  buildTimestamp: new Date().toISOString(),
  gitCommitShaFallback: runGit(["rev-parse", "HEAD"]),
  gitBranchFallback: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

console.log(
  `[generate-build-info] wrote ${outputPath} (commit fallback: ${
    buildInfo.gitCommitShaFallback ?? "unavailable"
  })`
);
