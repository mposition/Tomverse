// Fails when a file that is not on the allowlist can put a message on the wire.
//
// See scripts/check-send-entry-points-core.mjs for the rule and for why each
// allowlisted file is allowed.
//
//   npm run check:send-entry-points

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEND_ALLOWLIST,
  sendEntryPointViolations,
  staleAllowlistEntries,
} from "./check-send-entry-points-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The directories that hold server code. Tests and scripts are not senders. */
const ROOTS = ["lib", "app"];
const SKIP = new Set(["node_modules", ".next", "__tests__"]);

const walk = (directory) => {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    found.push({
      path: relative(root, full).split(sep).join("/"),
      source: readFileSync(full, "utf8"),
    });
  }
  return found;
};

const files = ROOTS.flatMap((directory) => walk(join(root, directory)));
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
  `Send entry point check passed: ${files.length} server file(s) scanned, ` +
    `${Object.keys(SEND_ALLOWLIST).length} allowed to reach the provider.`
);
