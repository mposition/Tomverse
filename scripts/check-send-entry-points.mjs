// Fails when a file that is not on the allowlist can put a message on the wire.
//
// See scripts/check-send-entry-points-core.mjs for the rule, for why each
// allowlisted file is allowed, and for why this parses rather than greps.
//
//   npm run check:send-entry-points

import { fileURLToPath } from "node:url";

import {
  productionSourceFiles,
  SEND_ALLOWLIST,
  sendEntryPointViolations,
  staleAllowlistEntries,
} from "./check-send-entry-points-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const files = productionSourceFiles(root);

const violations = sendEntryPointViolations(files);

if (violations.length > 0) {
  console.error("Send entry point check failed.\n");
  console.error(
    "These files can reach the provider without going through the address\n" +
      "lock. A customer-facing send belongs in `sendWithAddressLock()`; an\n" +
      "operator alert belongs in a module that is on the allowlist, with the\n" +
      "reason written down beside it:\n"
  );
  for (const violation of violations) {
    console.error(`- ${violation.path}  (${violation.uses.join(", ")})`);
  }
  console.error(
    "\nIf this really is a send nothing may lock -- an operator alert, a probe,\n" +
      "a diagnostic -- add it to SEND_ALLOWLIST in\n" +
      "scripts/check-send-entry-points-core.mjs with the reason."
  );
  process.exit(1);
}

const stale = staleAllowlistEntries(files);
if (stale.length > 0) {
  console.warn(
    `Allowlisted but no longer sending (not a failure): ${stale.join(", ")}`
  );
}

console.log(
  `Send entry point check passed: ${files.length} production file(s) parsed, ` +
    `${Object.keys(SEND_ALLOWLIST).length} allowed to reach the provider.`
);
