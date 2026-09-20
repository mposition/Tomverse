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
// The index build is what decides; the migration is written to survive its own
// failure with the existing index intact.
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
        "EmailDelivery: the index build holds an ACCESS EXCLUSIVE lock on the " +
        "table for its duration, so if that count makes the lock unacceptable, " +
        "build the index CONCURRENTLY by hand first -- the migration accepts a " +
        "correct pre-built index and refuses a wrong one."
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
