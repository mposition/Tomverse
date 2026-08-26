import { spawnSync } from "node:child_process";

/**
 * Runs the @ui-risk tier for ONE Playwright project.
 *
 * The tier is sharded by project because it outgrew the single step it used to
 * live in. That step's comment still described "44 tests over both Chromium
 * projects, measured 46s" long after the tier had passed it, and it began
 * timing out against a 10-minute budget while tests were still passing -- a
 * red check that said nothing about the product.
 *
 * Project is the right seam rather than a file shard: the two projects are
 * already independent browser configurations, the split is exactly even
 * because the tag selects the same tests in both, and a failure names the
 * viewport class it belongs to instead of an arbitrary shard number.
 *
 * Measured 2026-08-26 on the run that took the tier from 34 files to 51
 * (`--grep=@ui-risk --list`: 1,416 tests, 708 per project), against the
 * 25-minute job budget that covers install, build and test together:
 *
 *   desktop-chromium  18m51s test step, 20m15s job  (81% of budget)
 *   mobile-chromium   11m08s test step, 14m16s job  (57% of budget)
 *
 * So the seam has one move left in it. Desktop is the project to watch: the
 * two are not symmetric in cost even though they run the same test list, and
 * desktop has under five minutes of headroom. File-level sharding within a
 * project is the next step, and on this measurement it is due rather than
 * hypothetical -- do it before adding to the tier again, not after the first
 * timeout. Re-measure from the job's own step durations rather than a local
 * run: this container measured desktop at 13m56s, well under CI.
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
