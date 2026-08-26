// Read-only diagnosis: which stored field on one audit row stopped matching
// the hash that was signed over it.
//
//   npm run diagnose:admin-audit-entry -- <auditId>
//   npm run diagnose:admin-audit-entry -- <auditId> --json
//
// A failing entry says only that some byte of its content is not what was
// signed. That is the same answer for a forged row, a column an unrelated
// action rewrote, and a value the application itself later normalised -- and
// an operator cannot act on an answer that covers all three.
//
// So instead of asking whether the row matches, this asks *what would have to
// be different for it to match*. It re-derives the hash under one single-field
// variation at a time and reports the ones that reproduce the stored digest.
// A match names the changed field outright: the row was signed with this value
// and now carries that one.
//
// The 2026-08-26 case is what it was written for. staging reported 115 of 116
// entries verified with the failure at the chain's first row, which rules a
// key change out -- the same key opens the 109 entries after it. Between
// 2026-08-16, when that row verified, and 2026-08-21, when it did not,
// something rewrote it. docs/ops/admin-audit-key-epochs.md carries the story.
//
// ## What it does not do
//
// It does not write. Not to the row, not to the chain, not to a report table.
// Re-hashing a broken entry under the current key would make the checker pass
// by editing the thing being checked, which ends the chain's usefulness in the
// same motion.
//
// And it never prints a key, an index into the key list that is not already
// public, or any value derived from one. The output names fields and their
// stored contents -- all of which the admin console already shows -- and says
// which key position opened the row, the same thing the integrity panel does.
//
// Requires DATABASE_URL and whatever ADMIN_AUDIT_INTEGRITY_* the environment
// signs with. Run it where those already are; do not copy them anywhere.
//
// Most operators should not need this. The same diagnosis is a button in the
// Admin Console beside the failing entry, which runs where the database and
// the keys already live and needs nothing installed. This exists for a chain
// reached from a shell -- a restore under test, an environment with no console.

import {
  diagnoseAdminAuditEntry,
  storedAdminAuditHashInput,
} from "../lib/adminAuditEntryDiagnosis.ts";
import { adminAuditIntegrityKeys } from "../lib/adminAuditIntegrityCore.ts";
import { prisma } from "../lib/prisma.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const auditId = args.find((arg) => !arg.startsWith("--"));

if (!auditId) {
  console.error("Usage: npm run diagnose:admin-audit-entry -- <auditId> [--json]");
  process.exit(2);
}
if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required. Point it at a read-only role.");
  process.exit(2);
}

const keys = adminAuditIntegrityKeys(process.env);
if (keys.length === 0) {
  console.error(
    "No verification key: set ADMIN_AUDIT_INTEGRITY_KEY (or NEXTAUTH_SECRET)."
  );
  process.exit(2);
}

const row = await prisma.adminAuditLog.findUnique({ where: { id: auditId } });
if (!row) {
  console.error(`No audit entry ${auditId}.`);
  process.exit(1);
}
if (!row.entryHash) {
  console.error(
    `Audit entry ${auditId} predates the hash chain -- there is nothing to reproduce.`
  );
  process.exit(1);
}

// The candidate set lives in lib/ so this and the Admin Console endpoint
// cannot drift into answering the same question two ways.
const diagnosis = diagnoseAdminAuditEntry(
  storedAdminAuditHashInput(row),
  row.entryHash,
  keys
);
const { matches, candidatesTried, verifiesAsStored } = diagnosis;

const report = {
  auditId: row.id,
  action: row.action,
  createdAt: row.createdAt.toISOString(),
  ...diagnosis,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (verifiesAsStored) {
  console.log(`${row.id} verifies as stored. Nothing to diagnose.`);
} else if (matches.length === 0) {
  console.log(
    `${row.id} does not verify, and no single-field change reproduces its hash.\n` +
      `Tried ${candidatesTried} reconstructions against ${keys.length} key(s).\n` +
      `More than one field differs, a field this script does not vary does, or\n` +
      `the key it was signed with is not in this environment.`
  );
} else {
  console.log(`${row.id} does not verify as stored, but does under:`);
  for (const match of matches) {
    console.log(`  - ${match.label}  (key ${match.keyPosition})`);
  }
  console.log(
    `\nThat names what changed since it was signed. Do not re-hash the row:\n` +
      `rewriting an audit entry to satisfy its own checker ends what the chain proves.`
  );
}

await prisma.$disconnect();
