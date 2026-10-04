import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { SUGGESTION_TRANSITIONS, SUGGESTION_STATES } from "@/lib/supportTriageCore";

// SupportTriageSuggestion invariants (docs/policy/support-triage.md §1, §2, §6).
//
// What needs a database: the state machine, the lease and the display stamp
// live in the guard trigger and the CHECK constraints of migration
// 20261004010000_support_triage_suggestion. Some fixtures move a lease into
// the past; the trigger forbids exactly that, so they disable it for one
// statement and re-enable it at once.

const DIGEST = "a".repeat(64);
const FEEDBACK = "fb-triage-1";

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-triage-" } } });
};

const withGuardDisabled = async (sql: string) => {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "SupportTriageSuggestion" DISABLE TRIGGER "SupportTriageSuggestion_guard"`
  );
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SupportTriageSuggestion" ENABLE TRIGGER "SupportTriageSuggestion_guard"`
    );
  }
};

const create = (id = "s1", digest = DIGEST) =>
  prisma.supportTriageSuggestion.create({ data: { id, feedbackId: FEEDBACK, inputDigest: digest } });

const update = (id: string, data: Record<string, unknown>) =>
  prisma.supportTriageSuggestion.update({ where: { id }, data });

const claim = (id: string, token = "token-1") => update(id, { state: "claimed", claimToken: token });

const expireLease = (id: string) =>
  withGuardDisabled(
    `UPDATE "SupportTriageSuggestion" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = '${id}'`
  );

const toReady = async (id: string) => {
  await claim(id);
  return update(id, { state: "ready", lane: "bug_verified", keywordFlags: ["money"] });
};

beforeEach(async () => {
  await reset();
  await prisma.feedback.create({ data: { id: FEEDBACK, type: "bug", message: "triage fixture" } });
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a suggestion is born pending, unclaimed and unqueued", async () => {
  const row = await create();
  assert.equal(row.state, "pending");
  assert.equal(row.attemptCount, 0);
  assert.equal(row.ownerQueueState, "not_queued");
  assert.deepEqual(row.keywordFlags, []);
  for (const data of [
    { state: "ready" },
    { claimToken: "t" },
    { lane: "other" },
    { attemptCount: 1 },
    { ownerQueueState: "displayed", displayedAt: new Date() },
    { keywordFlags: ["money"] },
  ]) {
    await assert.rejects(
      prisma.supportTriageSuggestion.create({
        data: { id: "bad", feedbackId: FEEDBACK, inputDigest: "b".repeat(64), ...data },
      }),
      /inserted pending and unclaimed/,
      Object.keys(data).join(",")
    );
  }
});

test("one row per report and input digest", async () => {
  await create("s1");
  await assert.rejects(create("s2"), /Unique constraint|unique/i);
  await create("s3", "c".repeat(64));
});

test("claiming stamps a five-minute lease from the database clock", async () => {
  await create();
  const claimed = await claim("s1");
  assert.equal(claimed.state, "claimed");
  assert.ok(claimed.leaseExpiresAt);
  const seconds = (claimed.leaseExpiresAt.getTime() - claimed.updatedAt.getTime()) / 1_000;
  assert.equal(seconds, 300);
  // Clearing the token without a state change is refused by the trigger.
  await assert.rejects(update("s1", { state: "claimed", claimToken: null }), /change only with the state/);
});

test("only an expired lease is reclaimed, the token is cleared and the attempt counted", async () => {
  await create();
  await claim("s1");
  await assert.rejects(update("s1", { state: "pending" }), /lease has not expired/);
  await expireLease("s1");
  const back = await update("s1", { state: "pending" });
  assert.equal(back.claimToken, null);
  assert.equal(back.leaseExpiresAt, null);
  assert.equal(back.attemptCount, 1);
});

test("a fourth reclaim is refused; the row must fail as retry_exhausted", async () => {
  await create();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await claim("s1", `t${attempt}`);
    await expireLease("s1");
    assert.equal((await update("s1", { state: "pending" })).attemptCount, attempt);
  }
  await claim("s1", "t4");
  await expireLease("s1");
  await assert.rejects(update("s1", { state: "pending" }), /attemptCount_check|check constraint/);
  const failed = await update("s1", { state: "failed", failureCode: "retry_exhausted" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.claimToken, null);
});

test("a result written with a stale token matches nothing", async () => {
  await create();
  await claim("s1", "old");
  await expireLease("s1");
  await update("s1", { state: "pending" });
  await claim("s1", "new");
  const stale = await prisma.supportTriageSuggestion.updateMany({
    where: { id: "s1", state: "claimed", claimToken: "old" },
    data: { state: "ready", lane: "other" },
  });
  assert.equal(stale.count, 0);
});

test("becoming ready needs a lane and is the only time lane and flags are written", async () => {
  await create();
  await claim("s1");
  await assert.rejects(update("s1", { state: "ready" }), /lane_present_check|check constraint/);
  const ready = await update("s1", { state: "ready", lane: "trust_safety_human", keywordFlags: ["account_privacy"] });
  assert.equal(ready.lane, "trust_safety_human");
  assert.equal(ready.claimToken, null);
  await assert.rejects(update("s1", { lane: "other" }), /written only on becoming ready/);
  await assert.rejects(update("s1", { keywordFlags: [] }), /written only on becoming ready/);
});

test("lanes and flags are closed lists; there is no separate account lane", async () => {
  await create();
  await claim("s1");
  await assert.rejects(update("s1", { state: "ready", lane: "account_privacy_human" }), /lane_check|check constraint/);
  await assert.rejects(
    update("s1", { state: "ready", lane: "other", keywordFlags: ["refund_please"] }),
    /keywordFlags_check|check constraint/
  );
});

test("only the core table's transitions are allowed, and terminal rows never change", async () => {
  const allowed = new Set(SUGGESTION_TRANSITIONS.map(([a, b]) => `${a}->${b}`));
  // pending cannot jump to ready or accepted.
  await create("p");
  for (const to of ["ready", "accepted", "rejected", "failed"]) {
    assert.ok(!allowed.has(`pending->${to}`));
    await assert.rejects(update("p", { state: to, lane: "other", failureCode: to === "failed" ? "internal_error" : null }));
  }
  await toReady("p");
  await update("p", { state: "accepted" });
  for (const to of SUGGESTION_STATES) {
    if (to === "accepted") continue;
    await assert.rejects(update("p", { state: to }), /is terminal/, to);
  }
  await assert.rejects(update("p", { lane: "other" }), /is terminal/);
});

test("display is reached once, from not_queued on a ready row, and stamped by the database", async () => {
  await create();
  await assert.rejects(update("s1", { ownerQueueState: "displayed" }), /only once, while ready/);
  // Not in the same write that makes the row ready.
  await claim("s1");
  await assert.rejects(
    update("s1", { state: "ready", lane: "other", ownerQueueState: "displayed" }),
    /only once, while ready/
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await create();
  await toReady("s1");
  const shown = await update("s1", { ownerQueueState: "displayed" });
  assert.ok(shown.displayedAt);
  await assert.rejects(update("s1", { displayedAt: new Date(0) }), /written by the database/);
  await assert.rejects(update("s1", { ownerQueueState: "not_queued" }), /only once, while ready/);
});

test("the report, input digest and creation time are immutable; the claim fields move only with the state", async () => {
  await create();
  await prisma.feedback.create({ data: { id: "fb-triage-2", type: "bug", message: "other" } });
  for (const data of [{ feedbackId: "fb-triage-2" }, { inputDigest: "d".repeat(64) }, { createdAt: new Date(0) }]) {
    await assert.rejects(update("s1", data), /immutable/, Object.keys(data).join(","));
  }
  await claim("s1");
  await assert.rejects(update("s1", { claimToken: "swap" }), /change only with the state/);
  await assert.rejects(update("s1", { attemptCount: 2 }), /change only with the state/);
});

test("deleting the report deletes its suggestions", async () => {
  await create();
  await prisma.feedback.delete({ where: { id: FEEDBACK } });
  assert.equal(await prisma.supportTriageSuggestion.count(), 0);
});

test("the guard function has no EXCEPTION handler and pins its search path", async () => {
  const rows = await prisma.$queryRawUnsafe<{ handler: boolean; config: string[] | null }[]>(
    `SELECT prosrc ILIKE '%EXCEPTION WHEN%' AS handler, proconfig AS config
       FROM pg_proc WHERE proname = 'support_triage_suggestion_guard'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handler, false);
  assert.deepEqual(rows[0].config, ["search_path=pg_catalog, pg_temp"]);
});

test("a not-yet-ready suggestion can expire without a lane", async () => {
  await create("p");
  assert.equal((await update("p", { state: "expired" })).state, "expired");
  await create("c", "e".repeat(64));
  await claim("c");
  const expired = await update("c", { state: "expired" });
  assert.equal(expired.lane, null);
  assert.equal(expired.claimToken, null);
});

test("flags hold no NULL element and no repeat", async () => {
  await create();
  await claim("s1");
  await assert.rejects(
    update("s1", { state: "ready", lane: "other", keywordFlags: ["money", "money"] }),
    /distinct, non-null codes/
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "SupportTriageSuggestion" SET "state" = 'ready', "lane" = 'other', "keywordFlags" = ARRAY['money', NULL]::TEXT[] WHERE id = 's1'`
    ),
    /distinct, non-null codes/
  );
});

test("no suggestion is created for a deleted account's report", async () => {
  await prisma.feedback.create({ data: { id: "fb-triage-deleted", type: "bug", message: "[deleted account]" } });
  await assert.rejects(
    prisma.supportTriageSuggestion.create({ data: { id: "x", feedbackId: "fb-triage-deleted", inputDigest: DIGEST } }),
    /deleted account/
  );
});

test("a report's id cannot be changed under its suggestions", async () => {
  await create();
  await assert.rejects(prisma.feedback.update({ where: { id: FEEDBACK }, data: { id: "fb-triage-renamed" } }));
});
