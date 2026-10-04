// Whether EmailDelivery(providerAccount, providerMessageId) holds a duplicate,
// asked of the real data before the migration that makes the pair unique.
//
//   npm run email:check-message-id-duplicates
//
// Read-only. It runs no writes and takes no flags: there is nothing here to
// apply. An index build fails on the first duplicate it meets, mid-deploy, so
// this is the question that has to be answered before the contraction
// migration reaches an environment (docs/policy/email-notifications.md).
//
// It is a reason to stop, never a permission to go. The reading is taken at one
// moment and the migration runs at another, and no lock is held in between.
// The index build is what decides. The migration holding it is its own file,
// touching one table, so a failure there leaves everything else untouched.
//
// Prints counts only -- no address, no message id. The output is safe to paste.

import { emailDeliveryMessageIdDuplicates } from "../lib/emailDeliveryMessageIdDuplicates.ts";

const { prisma } = await import("../lib/prisma.ts");
try {
  const report = await emailDeliveryMessageIdDuplicates();
  console.log(JSON.stringify(report, null, 2));
  if (report.noDuplicatesAtReadTime) {
    console.log(
      `\nNo duplicate at the moment of this read. ${report.totalRows} rows in ` +
        "EmailDelivery. The index build takes a SHARE lock on that table for " +
        "as long as it runs: reads continue, and writes -- mail being enqueued, " +
        "deliveries being marked sent -- wait behind it. That wait is what this " +
        "count is for, and it is worth judging before the deploy rather than " +
        "during it. The ACCESS EXCLUSIVE locks in the two migrations that " +
        "follow are on catalogue edits that take no measurable time, and this " +
        "count says nothing about them."
    );
  } else {
    console.error(
      "\nThe unique index cannot be created yet: the rows above share a " +
        "message id within one account. Decide what each duplicate means " +
        "before the migration runs -- it will fail on the first one."
    );
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
