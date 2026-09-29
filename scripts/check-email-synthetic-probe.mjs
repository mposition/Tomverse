#!/usr/bin/env node
/**
 * Invariant 10: run the unsubscribe path end to end and report what it did.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.1
 * (invariant 10) and section 12 (S10a, before activation).
 *
 * Unlike every other `check:` script in this repository, this one **writes** --
 * it unsubscribes the probe account and puts it back. That is why it is off by
 * default, why it refuses an address that is not under a reserved name, and why
 * it is not in the PR gate: it needs a deployment to call and an account to
 * call about, and a gate that skipped itself would report a green tick for a
 * check that never ran.
 *
 * Run it against staging before activating the release-notes product, and
 * against production once the product is on.
 *
 * ## Where to run it
 *
 * The local PC's PowerShell, inside a clone, with `npm ci` done. It needs
 * `EMAIL_SYNTHETIC_PROBE_ENABLED`, `EMAIL_SYNTHETIC_PROBE_ADDRESS`,
 * `EMAIL_UNSUBSCRIBE_KEYS`, `PUBLIC_APP_URL` and `DATABASE_URL` for the
 * environment under test. Those are that environment's credentials, so this is
 * not a check anybody runs by accident.
 *
 * Exit codes: 0 passed, 1 failed, 2 refused before it ran.
 */

import process from "node:process";

const main = async () => {
  const { runSyntheticUnsubscribeProbe, PROBE_PURPOSE } = await import(
    "../lib/emailSyntheticProbe.ts"
  );
  const { PROBE_STEPS } = await import("../lib/emailSyntheticProbeCore.ts");

  const verdict = await runSyntheticUnsubscribeProbe(process.env);

  if (!verdict.ran) {
    // Exit 2, not 0 and not 1. A refusal is neither a pass nor a failure of the
    // thing under test, and an operator who is told "ok" for a check that never
    // ran has been told the opposite of the truth.
    console.error(`Invariant 10 probe refused: ${verdict.refusal}`);
    console.error(`  ${verdict.remedy}`);
    process.exitCode = 2;
    return;
  }

  if (verdict.passed) {
    console.log(
      `Invariant 10 probe passed: ${PROBE_STEPS.length} step(s) on the live unsubscribe endpoint, ` +
        `${PROBE_PURPOSE} turned off and restored, and every row written belongs to the probe subject.`
    );
    console.log(
      "  It does not claim nothing else changed anywhere while it ran; nothing could."
    );
    return;
  }

  console.error("Invariant 10 probe failed:");
  for (const problem of verdict.problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
};

await main();
