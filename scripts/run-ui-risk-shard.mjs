import { spawnSync } from "node:child_process";

/**
 * Runs the @ui-risk tier for ONE Playwright project.
 *
 * The tier is sharded by project because it outgrew the single step it used to
 * live in. The step's comment still described "44 tests over both Chromium
 * projects, measured 46s"; it is now 488 tests over 15 files, and it began
 * timing out against a 10-minute budget while tests were still passing -- a
 * red check that said nothing about the product.
 *
 * Project is the right seam rather than a file shard: the two projects are
 * already independent browser configurations, the split is almost exactly even
 * (244 tests each), and a failure names the viewport class it belongs to
 * instead of an arbitrary shard number. File-level sharding is the next step
 * if one project alone outgrows its budget again.
 *
 * `npm run test:e2e:ui-risk` still runs both, so local use is unchanged.
 */

const PROJECTS = ["desktop-chromium", "mobile-chromium"];

const project = process.env.UI_RISK_PROJECT?.trim();
if (!project) {
  console.error(
    `UI_RISK_PROJECT is required and must be one of: ${PROJECTS.join(", ")}.`
  );
  process.exit(1);
}
if (!PROJECTS.includes(project)) {
  // Refused rather than passed through: Playwright treats an unknown project
  // as "no tests matched" and exits 0, so a typo in the workflow matrix would
  // report a green shard that ran nothing.
  console.error(
    `UI_RISK_PROJECT must be one of: ${PROJECTS.join(", ")}. Received "${project}".`
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    `--project=${project}`,
    "--grep=@ui-risk",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
