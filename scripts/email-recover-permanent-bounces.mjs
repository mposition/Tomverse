// Record the hard bounces that were handled as soft ones before Resend's
// `Permanent` bounce type was read as hard (docs/policy/email-notifications.md
// v18 item 7).
//
//   npm run email:recover-permanent-bounces             # dry run: report only
//   npm run email:recover-permanent-bounces -- --apply  # write the missing causes
//
// Reads the raw provider events still on file (ninety days). Each missing
// hard bounce is written with the key the corrected handler uses
// (webhook:<event row id>), so running it again, or after the handler has
// already recorded an event, writes nothing twice.
//
// Prints counts only -- no address, no message id.

import { recoverPermanentBounces } from "../lib/emailPermanentBounceRecovery.ts";

const apply = process.argv.includes("--apply");

const { prisma } = await import("../lib/prisma.ts");
try {
  const report = await recoverPermanentBounces({ apply });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
