// Move suppression decisions from entries to causes (deploy B's switch).
//
//   npm run email:suppression-cutover                      # dry run: report only
//   npm run email:suppression-cutover -- --repair          # dry run, with repair
//   npm run email:suppression-cutover -- --apply           # switch if safe
//   npm run email:suppression-cutover -- --apply --repair  # repair, then switch
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.
//
// Run only after deploy B is live on every instance: an older build reads
// entries whatever the setting says. Everything happens in one transaction
// under the exclusive suppression fence, so the comparison is the state the
// switch applies to. The switch is refused while any selector's causes would
// allow mail its entry stops. `--repair` adds the entry's own reason as a cause
// for those selectors first; it never releases a cause. A dry run with
// `--repair` still writes the repair causes -- repair is additive and safe to
// keep -- but does not switch.
//
// Prints counts only -- no address, no selector.

import { runSuppressionCutover } from "../lib/emailSuppressionCutover.ts";

const apply = process.argv.includes("--apply");
const repair = process.argv.includes("--repair");

const { prisma } = await import("../lib/prisma.ts");
try {
  const report = await runSuppressionCutover({ apply, repair });
  const summary = {
    mode: apply ? "apply" : "dry_run",
    repair,
    authorityBefore: report.authorityBefore,
    authorityAfter: report.authorityAfter,
    entries: report.entries,
    activeCauses: report.activeCauses,
    unsafeMismatches: report.unsafe.length,
    unsafeByClassification: report.unsafe.reduce((acc, finding) => {
      acc[finding.classification] = (acc[finding.classification] ?? 0) + 1;
      return acc;
    }, {}),
    stricterThanEntry: report.stricter,
    repairedCauses: report.repairedCauses,
    switched: report.switched,
    refusal: report.refusal,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (apply && !report.switched && report.authorityBefore !== "causes") {
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
