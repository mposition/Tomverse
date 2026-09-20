// Whether EmailDelivery(providerAccount, providerMessageId) can carry a unique
// index, asked of the real data before the migration that adds one.
//
//   npm run email:check-message-id-duplicates
//
// Read-only. It runs no writes and takes no flags: there is nothing here to
// apply. An index build fails on the first duplicate it meets, mid-deploy, so
// this is the question that has to be answered before the contraction
// migration reaches an environment (docs/policy/email-notifications.md).
//
// Prints counts only -- no address, no message id. The output is safe to paste.

import { emailDeliveryMessageIdDuplicates } from "../lib/emailDeliveryMessageIdDuplicates.ts";

const { prisma } = await import("../lib/prisma.ts");
try {
  const report = await emailDeliveryMessageIdDuplicates();
  console.log(JSON.stringify(report, null, 2));
  if (!report.safeToAddUnique) {
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
