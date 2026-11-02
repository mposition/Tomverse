import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, mock, test } from "node:test";

// The stored GA4 User-ID against PostgreSQL (docs/policy/marketing-automation.md
// §10.2, migration 20261102100000_ga4_user_id): created once per account even
// when first requests race, only an analytics id can be stored, withdrawal and
// account deletion each name the stored id to GA4 and leave no row, and the
// lock account deletion takes keeps a racing creation from slipping past the
// read that names the id.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces the GA4 request module
// for every importer: nothing here reaches Google.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const requested: Array<{ analyticsUserId: string; trigger: string }> = [];
mock.module(mod("lib/ga4UserDeletion.ts"), {
  namedExports: {
    requestGa4UserIdDeletion: async (analyticsUserId: string, trigger: string) => {
      requested.push({ analyticsUserId, trigger });
      return { status: "submitted", deletionRequestTime: null };
    },
  },
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let ga4: typeof import("@/lib/ga4UserId");
let deleteTomverseAccount: (typeof import("@/lib/accountDeletion"))["deleteTomverseAccount"];

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ga4 = (await import(mod("lib/ga4UserId.ts"))) as typeof import("@/lib/ga4UserId");
  ({ deleteTomverseAccount } = (await import(
    mod("lib/accountDeletion.ts")
  )) as typeof import("@/lib/accountDeletion"));
});

const reset = async () => {
  const { resetTestFixture } = await import("./resetTestFixture");
  await resetTestFixture(prisma, 'TRUNCATE TABLE "Ga4UserId", "User" RESTART IDENTITY CASCADE');
};

beforeEach(async () => {
  requested.length = 0;
  await reset();
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });

const rows = (userId: string) => prisma.ga4UserId.findMany({ where: { userId } });

test("concurrent first requests create one id and all of them get it", async () => {
  const user = await createUser();
  const ids = await Promise.all(Array.from({ length: 6 }, () => ga4.ensureGa4UserId(user.id)));
  assert.equal(new Set(ids).size, 1);
  assert.match(String(ids[0]), /^[0-9a-f]{32}$/);
  const stored = await rows(user.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].analyticsUserId, ids[0]);
  assert.equal(await ga4.ensureGa4UserId(user.id), ids[0], "stable afterwards");
});

test("the account's export tells the person their id exists, and no one else's", async () => {
  const user = await createUser();
  const id = await ga4.ensureGa4UserId(user.id);
  const other = await createUser();
  await ga4.ensureGa4UserId(other.id);
  const { buildAccountDataExport } = (await import(
    mod("lib/accountDataExport.ts")
  )) as typeof import("@/lib/accountDataExport");
  const exported = await buildAccountDataExport(user.id);
  assert.ok(exported.manifest.includedDomains.includes("analytics_user_id"));
  const rows = exported.data.analytics_user_id as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].analyticsUserId, id);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["analyticsUserId", "createdAt"]);
});

test("only an analytics id can be stored: never an account id or an email", async () => {
  const user = await createUser();
  for (const value of [user.id, "someone@example.com", "0123456789ABCDEF0123456789ABCDEF"]) {
    await assert.rejects(
      prisma.ga4UserId.create({ data: { userId: user.id, analyticsUserId: value } }),
      (error: unknown) => /Ga4UserId_analyticsUserId_check|check constraint/i.test(String(error)),
      value
    );
  }
  assert.equal((await rows(user.id)).length, 0);
});

test("withdrawal names the stored id, leaves no row, and the next consent gets a new id", async () => {
  const user = await createUser();
  const first = await ga4.ensureGa4UserId(user.id);

  assert.deepEqual(await ga4.withdrawGa4UserId(user.id), { withdrawn: true });
  assert.deepEqual(requested, [{ analyticsUserId: first, trigger: "consent_withdrawal" }]);
  assert.equal((await rows(user.id)).length, 0);

  assert.deepEqual(await ga4.withdrawGa4UserId(user.id), { withdrawn: false });
  assert.equal(requested.length, 1, "nothing stored, nothing asked");

  const second = await ga4.ensureGa4UserId(user.id);
  assert.match(String(second), /^[0-9a-f]{32}$/);
  assert.notEqual(second, first);
});

test("account deletion names the stored id after the commit and the row goes with the account", async () => {
  const user = await createUser();
  const id = await ga4.ensureGa4UserId(user.id);
  assert.ok(id);
  const bystander = await createUser();
  const bystanderId = await ga4.ensureGa4UserId(bystander.id);

  const result = await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(result.deleted, true);
  assert.deepEqual(requested, [{ analyticsUserId: id, trigger: "account_deletion" }]);
  assert.equal(await prisma.ga4UserId.count({ where: { analyticsUserId: id } }), 0);
  assert.equal(
    (await rows(bystander.id))[0]?.analyticsUserId,
    bystanderId,
    "another account's id is untouched"
  );
});

test("an account that never consented is deleted without asking GA4 anything", async () => {
  const user = await createUser();
  assert.equal((await deleteTomverseAccount(user.id, { cancelSubscription: false })).deleted, true);
  assert.deepEqual(requested, []);
});

test("a creation racing the deletion's lock waits for it and then fails, so no unnamed id survives", async () => {
  const user = await createUser();
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolveLock) => {
    locked = resolveLock;
  });
  let release!: () => void;
  const held = new Promise<void>((resolveHold) => {
    release = resolveHold;
  });

  // What account deletion does, with the gap between the lock and the delete
  // held open on purpose.
  const deletion = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      const before = await tx.ga4UserId.findUnique({ where: { userId: user.id } });
      locked();
      await held;
      await tx.user.delete({ where: { id: user.id } });
      return before;
    },
    { timeout: 20_000, maxWait: 10_000 }
  );
  await lockTaken;

  let settled = false;
  const creation = ga4.ensureGa4UserId(user.id).then(
    () => "created",
    () => "failed"
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(settled, false, "the insert waits on the locked User row");

  release();
  assert.equal(await deletion, null, "nothing was stored when the deletion read");
  assert.equal(await creation, "failed", "and nothing could be created after it");
  assert.equal(await prisma.ga4UserId.count(), 0);
});
