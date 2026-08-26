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

import {
  adminAuditIntegrityKeys,
  computeAdminAuditEntryHash,
} from "../lib/adminAuditIntegrityCore.ts";
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

/** The input the verifier builds today, from the row exactly as stored. */
const stored = {
  previousHash: row.previousHash,
  actorUserId: row.actorUserId,
  actorEmail: row.actorEmail,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  summary: row.summary,
  metadata: row.metadata || null,
  ipAddress: row.ipAddress,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
};

/**
 * Candidate reconstructions, each differing from `stored` in exactly one way.
 *
 * One difference at a time on purpose. Two would let a match name a pair of
 * changes when only one of them is real, and the whole value of a match here
 * is that it is specific enough to act on.
 */
const candidates = [{ label: "as stored (no change)", input: stored }];

const withField = (field, value, label) =>
  candidates.push({ label, input: { ...stored, [field]: value } });

// A nullable column that now carries a value, or carries one where the write
// path recorded nothing. `onDelete: SetNull` on the actor relation puts
// `actorUserId` in this list for real: deleting a user nulls it on every row
// that user wrote, with no application code involved.
for (const field of [
  "previousHash",
  "actorUserId",
  "actorEmail",
  "targetId",
  "ipAddress",
  "userAgent",
]) {
  if (stored[field] !== null) withField(field, null, `${field}: was null`);
  if (stored[field] !== "") withField(field, "", `${field}: was ""`);
}

// The sentinel `getTrustedClientIp()` returns when no trusted header resolves.
// Worth trying in both directions: a row could have been written before the
// sentinel existed, or normalised into it afterwards.
if (stored.ipAddress !== "unknown") {
  withField("ipAddress", "unknown", 'ipAddress: was "unknown"');
}

// Timestamp precision. `clock_timestamp()` is microsecond and the column is
// millisecond, so a row written through a path that rounded differently would
// carry a digest over a timestamp the column can no longer express.
const iso = stored.createdAt;
const secondPrecision = `${iso.slice(0, 19)}.000Z`;
if (secondPrecision !== iso) {
  withField("createdAt", secondPrecision, "createdAt: was second-precision");
}
withField("createdAt", `${iso.slice(0, 19)}Z`, "createdAt: was without milliseconds");

// Metadata, the field most likely to have gained shape over time: a key added
// to what the action records changes every later digest but should not touch
// an existing row -- unless something rewrote it.
if (stored.metadata && typeof stored.metadata === "object") {
  candidates.push({ label: "metadata: was null", input: { ...stored, metadata: null } });
  candidates.push({ label: "metadata: was {}", input: { ...stored, metadata: {} } });
  for (const key of Object.keys(stored.metadata)) {
    const rest = Object.fromEntries(
      Object.entries(stored.metadata).filter(([name]) => name !== key)
    );
    candidates.push({
      label: `metadata: had no "${key}"`,
      input: { ...stored, metadata: rest },
    });
    if (stored.metadata[key] !== null) {
      candidates.push({
        label: `metadata."${key}": was null`,
        input: { ...stored, metadata: { ...stored.metadata, [key]: null } },
      });
    }
    if (Array.isArray(stored.metadata[key])) {
      const reversed = [...stored.metadata[key]].reverse();
      candidates.push({
        label: `metadata."${key}": was in the reverse order`,
        input: { ...stored, metadata: { ...stored.metadata, [key]: reversed } },
      });
      candidates.push({
        label: `metadata."${key}": was empty`,
        input: { ...stored, metadata: { ...stored.metadata, [key]: [] } },
      });
    }
  }
}

const matches = [];
for (const candidate of candidates) {
  for (const [index, secret] of keys.entries()) {
    if (computeAdminAuditEntryHash(candidate.input, secret) === row.entryHash) {
      matches.push({ ...candidate, keyPosition: index + 1 });
    }
  }
}

const report = {
  auditId: row.id,
  action: row.action,
  createdAt: iso,
  keysTried: keys.length,
  candidatesTried: candidates.length,
  verifiesAsStored: matches.some((match) => match.label === candidates[0].label),
  matches: matches.map(({ label, keyPosition }) => ({ label, keyPosition })),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.verifiesAsStored) {
  console.log(`${row.id} verifies as stored. Nothing to diagnose.`);
} else if (matches.length === 0) {
  console.log(
    `${row.id} does not verify, and no single-field change reproduces its hash.\n` +
      `Tried ${candidates.length} reconstructions against ${keys.length} key(s).\n` +
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
