// Fails when a route's own Cache-Control would be silently replaced by the
// proxy default.
//
// See scripts/check-api-cache-control-core.mjs for the rule and
// lib/apiCacheControlPolicy.ts for why the default exists at all.
//
//   npm run check:api-cache-control

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { auditApiCaching } from "./check-api-cache-control-core.mjs";
import { API_ROUTES_CHOOSING_THEIR_OWN_CACHING } from "../lib/apiCacheControlPolicy.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

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

const problems = auditApiCaching({
  routes,
  exceptions: API_ROUTES_CHOOSING_THEIR_OWN_CACHING,
});

if (problems.length > 0) {
  console.error(
    `\n${problems.length} API caching problem(s):\n` +
      problems.map((problem) => `  - ${problem.message}`).join("\n") +
      "\n\nThe proxy sets `private, no-store` on /api/* because Next.js sets no\n" +
      "Cache-Control at all, and a response with none is heuristically cacheable\n" +
      "by a shared cache. A header set in middleware overrides the route's own,\n" +
      "so a route that deliberately caches has to be named in\n" +
      "lib/apiCacheControlPolicy.ts.\n"
  );
  process.exit(1);
}

console.log(
  `API cache-control check passed: ${files.length} route(s), ` +
    `${API_ROUTES_CHOOSING_THEIR_OWN_CACHING.length} choosing their own caching, ` +
    "every one of them listed."
);
