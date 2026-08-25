import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import {
  isAssistantPackageImportEnabled,
  setAssistantPackageImportEnabled,
} from "@/lib/appSettings";
import { ASSISTANT_PACKAGE_IMPORT_FLAG_KEY } from "@/lib/assistantPackageImportAccess";
import { prisma } from "@/lib/prisma";

/**
 * The only way the import flag changes.
 *
 * docs/policy/assistant-package-import.md §12.2.1.
 *
 * The staging run turned this flag on with a hand-typed `UPDATE`, because
 * nothing else could: the key was registered as deliberately unwritable and
 * §G-1 -- "turning it on is in the audit log" -- was recorded `n/a` for a
 * round that had no control to use. What follows is what makes that item
 * answerable next time.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "AdminAuditLog", "AppSetting", "User" RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const OPS_EMAIL = `ops-${randomUUID()}@example.test`;

const adminSession = async (
  email: string,
  authenticatedAt: string | null = new Date().toISOString()
): Promise<Session> => {
  const user = await prisma.user.create({
    data: { email, lastLoginAt: new Date() },
  });
  return {
    user: {
      id: user.id,
      email: user.email,
      ...(authenticatedAt === null ? {} : { authenticatedAt }),
    },
    expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  };
};

/**
 * The environment the permission check reads.
 *
 * Restored around each test rather than set once: `hasAdminPermission` reads
 * `process.env` at call time, so a test that left it set would decide the
 * outcome of the next one.
 */
const withOpsAdmin = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = {
    admins: process.env.ADMIN_EMAILS,
    ops: process.env.ADMIN_OPS_EMAILS,
  };
  process.env.ADMIN_EMAILS = OPS_EMAIL;
  process.env.ADMIN_OPS_EMAILS = OPS_EMAIL;
  try {
    return await run();
  } finally {
    process.env.ADMIN_EMAILS = previous.admins;
    process.env.ADMIN_OPS_EMAILS = previous.ops;
  }
};

const auditRows = () =>
  prisma.adminAuditLog.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      action: true,
      actorEmail: true,
      summary: true,
      metadata: true,
      targetId: true,
    },
  });

test("enabling writes the flag and one audit row carrying both values", async () => {
  await withOpsAdmin(async () => {
    const session = await adminSession(OPS_EMAIL);
    const outcome = await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "staging verification signed off",
    });

    assert.equal(outcome.outcome, "changed");
    assert.equal(await isAssistantPackageImportEnabled(), true);

    const rows = await auditRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "assistantPackageImport.enabled");
    assert.equal(rows[0].actorEmail, OPS_EMAIL);
    assert.equal(rows[0].targetId, ASSISTANT_PACKAGE_IMPORT_FLAG_KEY);
    // The reason is the row's whole point: who and when without why does not
    // answer the question the row is kept for.
    assert.equal(rows[0].summary, "staging verification signed off");
    // Both sides, so the row says whether this call is what turned it on.
    assert.deepEqual(rows[0].metadata, { before: null, after: "true" });
  });
});

test("rollback is the same call, and is recorded as its own event", async () => {
  await withOpsAdmin(async () => {
    const session = await adminSession(OPS_EMAIL);
    await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "opening it",
    });
    const rolledBack = await setAssistantPackageImportEnabled({
      session,
      enabled: false,
      rationale: "reports of a defect",
    });

    assert.equal(rolledBack.outcome, "changed");
    assert.deepEqual(
      { before: rolledBack.before, after: rolledBack.after },
      { before: "true", after: "false" }
    );
    assert.equal(await isAssistantPackageImportEnabled(), false);

    const rows = await auditRows();
    assert.deepEqual(
      rows.map((row) => row.action),
      ["assistantPackageImport.enabled", "assistantPackageImport.disabled"]
    );
    // Without this the record says a feature was released and never says it
    // was withdrawn.
    assert.deepEqual(rows[1].metadata, { before: "true", after: "false" });
  });
});

test("pressing enable on something already enabled is still recorded", async () => {
  await withOpsAdmin(async () => {
    const session = await adminSession(OPS_EMAIL);
    await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "first",
    });
    const again = await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "second",
    });

    // Reported as a no-op, but the attempt is an event: somebody believed it
    // was off.
    assert.equal(again.outcome, "unchanged");
    assert.equal((await auditRows()).length, 2);
  });
});

test("an admin without ops:write cannot change it, and leaves no row", async () => {
  const previous = process.env.ADMIN_EMAILS;
  const previousOps = process.env.ADMIN_OPS_EMAILS;
  const email = `readonly-${randomUUID()}@example.test`;
  process.env.ADMIN_EMAILS = email;
  process.env.ADMIN_OPS_EMAILS = "";
  try {
    const session = await adminSession(email);
    const outcome = await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "trying",
    });
    assert.deepEqual(outcome, { outcome: "refused", reason: "not-authorized" });
    assert.equal(await isAssistantPackageImportEnabled(), false);
    assert.equal((await auditRows()).length, 0);
  } finally {
    process.env.ADMIN_EMAILS = previous;
    process.env.ADMIN_OPS_EMAILS = previousOps;
  }
});

test("a session that has aged out is asked to sign in again", async () => {
  await withOpsAdmin(async () => {
    // Older than the largest window the environment can configure, so this
    // does not drift with ADMIN_RECENT_AUTH_MINUTES.
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const session = await adminSession(OPS_EMAIL, stale);
    const outcome = await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "trying",
    });
    assert.deepEqual(outcome, {
      outcome: "refused",
      reason: "reauthentication-required",
    });
    assert.equal((await auditRows()).length, 0);
  });
});

test("a change with no reason is refused before anything is written", async () => {
  await withOpsAdmin(async () => {
    const session = await adminSession(OPS_EMAIL);
    const outcome = await setAssistantPackageImportEnabled({
      session,
      enabled: true,
      rationale: "   ",
    });
    assert.deepEqual(outcome, {
      outcome: "refused",
      reason: "rationale-required",
    });
    assert.equal(await isAssistantPackageImportEnabled(), false);
    assert.equal((await auditRows()).length, 0);
  });
});
