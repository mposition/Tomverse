import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  SCOUT_DAILY_CALL_CAP_SETTING_KEY,
  SCOUT_GENERATION_DAILY_CAP_SETTING_KEY,
  SCOUT_MODEL_SETTING_KEY,
  readScoutSettings,
  reserveScoutGenerations,
  scoutRecentCalls,
  scoutUsageToday,
  startScoutCall,
  writeScoutSettings,
} from "@/lib/productResearchScoutSettings";
import { issueScoutSignedInAccess } from "@/lib/productResearchScoutSignedIn";
import { invalidateSessionSecuritySnapshot } from "@/lib/sessionSecurity";
import { decode, encode } from "next-auth/jwt";

import { resetTestFixture } from "./resetTestFixture";

/**
 * The Scout's spending stop (docs/policy/product-research-agent.md §11, §13):
 * a call is reserved against the model and the daily cap as they are when the
 * reservation holds the ledger lock, not as the route read them earlier, so
 * an owner who turns the model off or lowers the cap stops every call after
 * the change.
 */
const reset = async () => {
  await resetTestFixture(prisma, `TRUNCATE TABLE "ProductResearchScoutLlmCall" RESTART IDENTITY CASCADE`);
  await prisma.appSetting.deleteMany({ where: { key: { in: [SCOUT_MODEL_SETTING_KEY, SCOUT_DAILY_CALL_CAP_SETTING_KEY, SCOUT_GENERATION_DAILY_CAP_SETTING_KEY] } } });
};
const noAudit = async () => {};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("lowering the cap stops the next reservation, though the caller read the old cap", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 2, generationDailyCap: 0 }, noAudit);
  const before = await readScoutSettings();
  assert.equal(before.dailyCallCap, 2);
  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "fixture-model" })));

  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1, generationDailyCap: 0 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "faq.en", modelId: "fixture-model" }), { refused: "daily_cap_reached" });
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 0, generationDailyCap: 0 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "faq.en", modelId: "fixture-model" }), { refused: "daily_cap_reached" });
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 1);
});

test("a reservation that must leave calls free is refused when only the last call is left", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 2, generationDailyCap: 0 }, noAudit);
  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "fixture-model" })));
  assert.deepEqual(
    await startScoutCall({ subject: "scenario.explore", modelId: "fixture-model", keepFree: 1 }),
    { refused: "daily_cap_reached" },
    "the scenario would leave nothing to judge its turn",
  );
  assert.ok("id" in (await startScoutCall({ subject: "faq.en", modelId: "fixture-model" })), "the last call still serves a judgement");
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 2);
});

test("turning the model off, or choosing another, refuses a reservation for the old one", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 10, generationDailyCap: 0 }, noAudit);
  await writeScoutSettings({ modelId: null, dailyCallCap: 10, generationDailyCap: 0 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "home.en", modelId: "fixture-model" }), { refused: "model_off" });

  await writeScoutSettings({ modelId: "other-model", dailyCallCap: 10, generationDailyCap: 0 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "home.en", modelId: "fixture-model" }), { refused: "model_off" });
  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "other-model" })));
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 1);
});

test("the cap still holds when reservations race for the last slot", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 3, generationDailyCap: 0 }, noAudit);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => startScoutCall({ subject: `page-${index}`, modelId: "fixture-model" })),
  );
  assert.equal(results.filter((result) => "id" in result).length, 3);
  assert.equal(results.filter((result) => "refused" in result && result.refused === "daily_cap_reached").length, 5);
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 3);
});

test("real generations come from their own cap, as many as it still allows, and do not touch the model-call cap", async () => {
  await reset();
  const asked = ["generated.pdf", "generated.docx", "generated.xlsx"];
  // The default is off: nothing is granted until an owner sets the cap.
  assert.deepEqual(await reserveScoutGenerations(asked, noAudit), []);

  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1, generationDailyCap: 2 }, noAudit);
  assert.deepEqual(await reserveScoutGenerations(asked, noAudit), ["generated.pdf", "generated.docx"]);
  assert.deepEqual(await reserveScoutGenerations(asked, noAudit), [], "the cap is spent for the UTC day");

  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "fixture-model" })), "permits do not use the model-call cap");
  const usage = await scoutUsageToday();
  assert.equal(usage.calls, 1);
  assert.equal(usage.generations, 2);
  assert.equal((await scoutRecentCalls(1)).length, 1, "the run view counts model calls");

  // An owner lowering the cap stops the next run; raising it opens only the difference.
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1, generationDailyCap: 3 }, noAudit);
  assert.deepEqual(await reserveScoutGenerations(asked, noAudit), ["generated.pdf"]);
});

test("no permit is granted when nothing would judge the result", async () => {
  await reset();
  await writeScoutSettings({ modelId: null, dailyCallCap: 10, generationDailyCap: 5 }, noAudit);
  assert.deepEqual(await reserveScoutGenerations(["generated.pdf"], noAudit), [], "the model is off");
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 0, generationDailyCap: 5 }, noAudit);
  assert.deepEqual(await reserveScoutGenerations(["generated.pdf"], noAudit), [], "the model-call cap is zero");
  assert.equal((await scoutUsageToday()).generations, 0);
});

test("the audit runs in the permits' transaction: a refused audit grants nothing", async () => {
  await reset();
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1, generationDailyCap: 5 }, noAudit);
  await assert.rejects(reserveScoutGenerations(["generated.pdf"], async () => {
    throw new Error("audit refused");
  }));
  assert.equal((await scoutUsageToday()).generations, 0);
});

test("the test account gets a short session a sign-in would honour; an administrator's account gets none", async () => {
  await reset();
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1, generationDailyCap: 1 }, noAudit);
  const saved = { NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, ADMIN_EMAILS: process.env.ADMIN_EMAILS, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
  const secret = "fixture-nextauth-secret-only-for-this-test";
  process.env.NEXTAUTH_SECRET = secret;
  process.env.NEXTAUTH_URL = "https://dev.tomverse.app";
  process.env.ADMIN_EMAILS = "";
  const email = `scout-test-${Date.now()}@example.invalid`;
  const user = await prisma.user.create({ data: { email, name: "Scout test" } });
  try {
    assert.deepEqual(await issueScoutSignedInAccess("nobody@example.invalid", []), { refused: "test_account_missing" });

    // An address stored in mixed case still names the account.
    await prisma.user.update({ where: { id: user.id }, data: { email: email.replace("scout", "Scout") } });
    assert.ok("session" in (await issueScoutSignedInAccess(email, [])));
    await prisma.user.update({ where: { id: user.id }, data: { email } });

    const now = new Date();
    const access = await issueScoutSignedInAccess(email, ["generated.pdf", "generated.image"], now);
    assert.ok("session" in access);
    assert.equal(access.session.name, "__Secure-next-auth.session-token");
    assert.deepEqual(access.permits, ["generated.pdf"]);
    assert.equal(Date.parse(access.session.expiresAt) - now.getTime(), 3_600_000);
    const token = await decode({ token: access.session.value, secret });
    assert.equal(token?.sub, user.id);
    assert.equal(token?.id, user.id);
    assert.equal(token?.email, email);
    assert.equal(token?.sessionIssuedAt, now.getTime());
    assert.ok(Number(token?.exp) - now.getTime() / 1000 <= 3_601, "an hour, not the seven days of a sign-in");
    // The real session callback honours it, and a revocation ends it like any other session.
    const resolve = async () =>
      (await authOptions.callbacks!.session!({ session: { user: {}, expires: access.session.expiresAt }, token: token! } as never)) as { user?: { id?: string } };
    assert.equal((await resolve()).user?.id, user.id);
    assert.equal(token?.absoluteExpiresAt, now.getTime() + 3_600_000);

    // However NextAuth re-encodes it, as it does on every session read, the hour is the end.
    const reissued = await encode({ secret, maxAge: 7 * 24 * 60 * 60, token: { ...token!, absoluteExpiresAt: Date.now() - 1 } });
    const late = await decode({ token: reissued, secret });
    assert.ok(Number(late?.exp) - Date.now() / 1000 > 6 * 24 * 60 * 60, "the token itself still has days left");
    const lateSession = (await authOptions.callbacks!.session!({ session: { user: {}, expires: access.session.expiresAt }, token: late! } as never)) as { user?: { id?: string } };
    assert.equal(lateSession.user?.id, undefined, "past its absolute end the session is gone");

    const audits = await prisma.adminAuditLog.findMany({ where: { action: "product_research.scout.test_session_issued", targetId: user.id } });
    const audit = audits.find((row) => (row.metadata as Record<string, unknown>).generationPermits === 1);
    assert.equal((audit?.metadata as Record<string, unknown>).systemActor, "product-research-scout");
    assert.equal(JSON.stringify(audits).includes(access.session.value), false, "the session is not in the audit rows");

    await prisma.user.update({ where: { id: user.id }, data: { sessionsRevokedAt: new Date(now.getTime() + 1_000) } });
    invalidateSessionSecuritySnapshot(user.id);
    assert.equal((await resolve()).user?.id, undefined, 'a revoked account loses the session');
    await prisma.user.update({ where: { id: user.id }, data: { sessionsRevokedAt: null } });

    process.env.ADMIN_EMAILS = email;
    assert.deepEqual(await issueScoutSignedInAccess(email, []), { refused: "test_account_is_admin" });
    process.env.ADMIN_EMAILS = "";

    await prisma.user.update({ where: { id: user.id }, data: { accountStatus: "suspended" } });
    assert.deepEqual(await issueScoutSignedInAccess(email, []), { refused: "test_account_inactive" });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("a daily memory reservation cannot be double-spent or replayed after a failed call", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 2, generationDailyCap: 0 }, noAudit);
  const day = new Date().toISOString().slice(0, 10);
  const input = { subject: "memory.continuation.fr", modelId: "fixture-model", onceOnUtcDay: day };
  const results = await Promise.all(Array.from({length: 6}, () => startScoutCall(input)));
  const grants = results.filter(x => "id" in x);
  assert.equal(grants.length, 1);
  assert.equal(results.filter(x => "refused" in x && x.refused === "already_sampled").length, 5);
  await prisma.productResearchScoutLlmCall.update({where: {id: grants[0]!.id}, data: {outcome: "failed"}});
  assert.deepEqual(await startScoutCall(input), {refused: "already_sampled"});
  assert.deepEqual(await startScoutCall({...input, subject: "memory.continuation.es", onceOnUtcDay: "2000-01-01"}), {refused: "day_changed"});
  assert.ok("id" in await startScoutCall({...input, subject: "home.en", onceOnUtcDay: day}));
  assert.deepEqual(await startScoutCall({...input, subject: "memory.continuation.ideas"}), {refused: "daily_cap_reached"});
});
