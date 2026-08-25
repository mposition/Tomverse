import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";
import { verifyAdminAuditIntegrity } from "@/lib/adminAuditIntegrity";
import { prisma } from "@/lib/prisma";

// The audit chain across a key rotation (#883).
//
// Contract: docs/ops/admin-audit-key-epochs.md.
//
// What needs a database: the verifier walks real rows in real order and carries
// linkage between them. The property under test is what happens to entries
// *written under a key that is no longer the current one*, which only exists as
// a relationship between stored rows and the environment.

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AdminAuditLog", "User" RESTART IDENTITY CASCADE`
  );

const ACTOR_ID = "admin-actor-1";
const LEGACY = "legacy-secret";
const V1 = "first-secret";
const V2 = "second-secret";

const envKeys = [
  "ADMIN_AUDIT_INTEGRITY_KEYS",
  "ADMIN_AUDIT_INTEGRITY_KEY_VERSION",
  "ADMIN_AUDIT_INTEGRITY_KEY",
  "NEXTAUTH_SECRET",
] as const;

const setEnv = (values: Partial<Record<(typeof envKeys)[number], string>>) => {
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
};

beforeEach(async () => {
  await reset();
  await prisma.user.create({
    data: { id: ACTOR_ID, email: "owner@example.test" },
  });
});

after(async () => {
  for (const key of envKeys) delete process.env[key];
  await prisma.$disconnect();
});

let sequence = 0;

/**
 * One correctly-signed chain entry.
 *
 * Written through the same hash function the writer uses rather than through
 * `writeAdminAuditLog`, so a test can place an entry in a specific epoch
 * without reconfiguring the environment between writes.
 */
const chainEntry = async (input: {
  epoch: string | null;
  secret: string;
  previousHash: string | null;
  /** Corrupt the stored summary after hashing, to stand for a forged row. */
  tamper?: boolean;
}) => {
  sequence += 1;
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, sequence));
  const summary = `Entry ${sequence}`;
  const fields = {
    previousHash: input.previousHash,
    actorUserId: ACTOR_ID,
    actorEmail: "owner@example.test",
    action: "app_settings.update_completed",
    targetType: "AppSetting",
    targetId: "guestDefaultModelId",
    summary,
    metadata: null,
    ipAddress: null,
    userAgent: null,
    createdAt: createdAt.toISOString(),
  };
  const entryHash = computeAdminAuditEntryHash(fields, input.secret);
  const row = await prisma.adminAuditLog.create({
    data: {
      actorUserId: ACTOR_ID,
      actorEmail: "owner@example.test",
      action: fields.action,
      targetType: fields.targetType,
      targetId: fields.targetId,
      summary: input.tamper ? `${summary} (altered)` : summary,
      ipAddress: null,
      userAgent: null,
      previousHash: input.previousHash,
      entryHash,
      keyEpoch: input.epoch,
      createdAt,
    },
    select: { id: true, entryHash: true },
  });
  return { id: row.id, entryHash: row.entryHash as string };
};

test("rows across two epochs both verify when both keys are present", async () => {
  // The acceptance criterion #883 names first: a rotation must leave the chain
  // verifiable. Before epochs, the v1 rows would all have failed the moment the
  // key moved to v2.
  const first = await chainEntry({ epoch: "v1", secret: V1, previousHash: null });
  await chainEntry({ epoch: "v2", secret: V2, previousHash: first.entryHash });

  setEnv({
    ADMIN_AUDIT_INTEGRITY_KEYS: `v1:${V1},v2:${V2}`,
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v2",
  });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.verifiedEntries, 2);
  assert.equal(report.unverifiableEntries, 0);
  assert.equal(report.firstInvalidId, null);
});

test("an epoch whose key is gone is unverifiable, and never a pass", async () => {
  // The escape hatch this closes: if a missing key reported valid, anybody who
  // could edit the environment could turn "these rows were altered" into
  // "these rows predate the current key".
  const first = await chainEntry({ epoch: "v1", secret: V1, previousHash: null });
  await chainEntry({ epoch: "v2", secret: V2, previousHash: first.entryHash });

  setEnv({
    ADMIN_AUDIT_INTEGRITY_KEYS: `v2:${V2}`,
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v2",
  });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.unverifiableEntries, 1);
  assert.equal(report.verifiedEntries, 1);
  assert.match(report.message, /could not be checked/i);
  // And it is reported by epoch, so an operator knows which key to find.
  const v1 = report.byEpoch.find((entry) => entry.epoch === "v1");
  assert.ok(v1);
  assert.equal(v1.verifiable, false);
  assert.equal(v1.entries, 1);
});

test("a lost key does not hide the epochs after it", async () => {
  // The verifier walks past unverifiable rows carrying their hash forward.
  // Stopping instead would make one missing key look like the chain going dark.
  const first = await chainEntry({ epoch: "v1", secret: V1, previousHash: null });
  const second = await chainEntry({
    epoch: "v2",
    secret: V2,
    previousHash: first.entryHash,
  });
  await chainEntry({ epoch: "v2", secret: V2, previousHash: second.entryHash });

  setEnv({ ADMIN_AUDIT_INTEGRITY_KEYS: `v2:${V2}` });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.verifiedEntries, 2, "both v2 rows must still be checked");
  assert.equal(report.unverifiableEntries, 1);
  assert.equal(report.valid, true);
});

test("a tampered row fails in the older epoch", async () => {
  const first = await chainEntry({
    epoch: "v1",
    secret: V1,
    previousHash: null,
    tamper: true,
  });
  await chainEntry({ epoch: "v2", secret: V2, previousHash: first.entryHash });

  setEnv({ ADMIN_AUDIT_INTEGRITY_KEYS: `v1:${V1},v2:${V2}` });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.firstInvalidId, first.id);
  assert.equal(report.firstInvalidIsOldest, true);
});

test("a tampered row fails in the newer epoch too", async () => {
  // Both epochs are really checked. A verifier that only ever exercised the
  // active key would pass rows it had not read.
  const first = await chainEntry({ epoch: "v1", secret: V1, previousHash: null });
  const second = await chainEntry({
    epoch: "v2",
    secret: V2,
    previousHash: first.entryHash,
    tamper: true,
  });

  setEnv({ ADMIN_AUDIT_INTEGRITY_KEYS: `v1:${V1},v2:${V2}` });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.firstInvalidId, second.id);
  assert.equal(report.firstInvalidIsOldest, false);
});

test("pre-epoch rows keep verifying under the legacy key", async () => {
  // Every row that exists when this ships carries NULL. If they stopped
  // verifying on deploy, the change would have caused the outage it prevents.
  const first = await chainEntry({ epoch: null, secret: LEGACY, previousHash: null });
  await chainEntry({ epoch: null, secret: LEGACY, previousHash: first.entryHash });

  setEnv({ ADMIN_AUDIT_INTEGRITY_KEY: LEGACY });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.verifiedEntries, 2);
  assert.deepEqual(
    report.byEpoch.map((entry) => entry.epoch),
    [null]
  );
});

test("the pre-epoch chain survives the first rotation", async () => {
  // The migration path an operator actually walks: rows exist with no epoch,
  // then a keyring is introduced and new rows carry v1. Both must verify.
  const legacy = await chainEntry({
    epoch: null,
    secret: LEGACY,
    previousHash: null,
  });
  await chainEntry({ epoch: "v1", secret: V1, previousHash: legacy.entryHash });

  setEnv({
    ADMIN_AUDIT_INTEGRITY_KEY: LEGACY,
    ADMIN_AUDIT_INTEGRITY_KEYS: `v1:${V1}`,
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v1",
  });

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.verifiedEntries, 2);
  assert.equal(report.unverifiableEntries, 0);
});

test("no key at all reports unconfigured rather than valid", async () => {
  await chainEntry({ epoch: null, secret: LEGACY, previousHash: null });
  setEnv({});

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.configured, false);
  assert.equal(report.valid, false);
});
