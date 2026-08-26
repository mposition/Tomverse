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
 * 81% is not headroom, so the workflow now passes `--shard=i/N` through to
 * Playwright and runs each project in two shards -- the file-level split the
 * earlier version of this comment named as the next step. This script needed
 * no change for it: everything after the project flag is forwarded verbatim,
 * which is what `process.argv.slice(2)` below is for.
 *
 * Two shards, not more, and measured rather than assumed. `--shard` divides
 * by test count and not by work; e2e.yml records a three-way split where the
 * counts matched and the work did not, because skips are not spread evenly.
 * Desktop's two shards ran 7m38s (349 passed, 20 skipped) and 6m51s (306
 * passed, 33 skipped) against 13m56s unsharded on the same machine -- a 53/47
 * split, so the slowest shard is ~55% of the whole. That puts desktop's CI
 * test step near 10m and its job near half the budget. A third shard would
 * buy less than this one did and cost another runner.
 *
 * Desktop is still the project to watch: the two are not symmetric in cost
 * even though the tag selects the same list in both. Re-measure from the
 * job's own step durations rather than a local run -- this container measured
 * desktop at 13m56s where CI measured 18m51s.
 *
 * `npm run test:e2e:ui-risk` still runs both projects unsharded, so local use
 * is unchanged.
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
