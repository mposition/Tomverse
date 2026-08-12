// Surveys API routes that leave `Cache-Control` unset.
//
// See scripts/report-api-cache-control-core.mjs for the measurement this rests
// on and for the two central fixes that were tried and are wrong.
//
//   npm run report:api-cache-control
//   npm run report:api-cache-control -- --json
//
// A report, not a gate. It never exits non-zero for a finding: the remedy is
// per-route, the routes it names have not been changed, and a check that fails
// on work nobody has scheduled only teaches people to skip checks.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  routesWithoutCacheControl,
  summarizeCacheControl,
} from "./report-api-cache-control-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = process.argv.includes("--json");

const files = execSync("git ls-files 'app/api/**/route.ts'", {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const routes = files.map((file) => ({
  file,
  source: readFileSync(join(root, file), "utf8"),
}));

const summary = summarizeCacheControl(routes);
const findings = routesWithoutCacheControl(routes);

if (json) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  console.log(
    `API routes: ${summary.total}\n` +
      `  authenticated:                 ${summary.authenticated}\n` +
      `  declaring a Cache-Control:     ${summary.declaring}\n` +
      `  authenticated GET, silent:     ${summary.silentAuthenticatedGets}\n`
  );
  if (findings.length === 0) {
    console.log("Every authenticated GET route names its own caching.");
  } else {
    console.log(
      "These answer a GET for a signed-in caller and send no cache directive,\n" +
        "so a shared cache may store and reuse the response heuristically:\n"
    );
    for (const finding of findings) {
      console.log(`  ${finding.file}  [${finding.methods.join(", ")}]`);
    }
    console.log(
      "\nThe remedy is per-route: set the header where the response is made.\n" +
        "Setting it in proxy.ts or in next.config's headers() overrides a route's\n" +
        "own value instead of defaulting behind it, which would turn\n" +
        "/api/public/proof-metrics from its deliberate s-maxage into no-store."
    );
  }
}
