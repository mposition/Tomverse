import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { getAdminUsersPage, getFreshAdminUserStats } from "@/lib/adminUsers";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";

// Regression coverage for PR #72 (commit ed8228c, "Fix: Daily usage
// calculation defects"): admin user metrics used to be computed against a
// single shared UTC day boundary. lib/adminUsers.ts now derives each user's
// window from lib/userTimeZone.ts#getZonedDayWindow using their own
// settings.timeZone, so two users can disagree about which messages count
// as "today" for the same instant.

const resetAdminUsersData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "User",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetAdminUsersData);
after(async () => {
  await resetAdminUsersData();
  await prisma.$disconnect();
});

const createUser = async (label: string, timeZone: string) =>
  prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      settings: { create: { timeZone } },
    },
  });

const seedMessage = async (userId: string, createdAt: string) => {
  const conversation = await prisma.conversation.create({
    data: { userId, title: "QA" },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: "hi",
      createdAt: new Date(createdAt),
    },
  });
};

test("messagesToday uses each user's own local-day window, not a shared UTC boundary", async () => {
  // now = 2026-07-19T20:00Z. Local "today" windows relative to that instant:
  //   UTC                -> [2026-07-19T00:00Z, 2026-07-20T00:00Z)
  //   America/Los_Angeles -> [2026-07-19T07:00Z, 2026-07-20T07:00Z) (PDT, UTC-7)
  //   Australia/Brisbane  -> [2026-07-19T14:00Z, 2026-07-20T14:00Z) (UTC+10, no DST)
  const now = new Date("2026-07-19T20:00:00.000Z");

  const utcUser = await createUser("utc", "UTC");
  const laUser = await createUser("la", "America/Los_Angeles");
  const brisbaneUser = await createUser("bne", "Australia/Brisbane");

  // 10:00Z Jul 19 - inside UTC and LA windows, still "yesterday" in Brisbane.
  await seedMessage(utcUser.id, "2026-07-19T10:00:00.000Z");
  await seedMessage(laUser.id, "2026-07-19T10:00:00.000Z");
  await seedMessage(brisbaneUser.id, "2026-07-19T10:00:00.000Z");

  // 15:00Z Jul 19 - inside all three windows.
  await seedMessage(utcUser.id, "2026-07-19T15:00:00.000Z");
  await seedMessage(laUser.id, "2026-07-19T15:00:00.000Z");
  await seedMessage(brisbaneUser.id, "2026-07-19T15:00:00.000Z");

  // 01:00Z Jul 20 - already the next UTC day, but still inside the LA and
  // Brisbane windows.
  await seedMessage(laUser.id, "2026-07-20T01:00:00.000Z");
  await seedMessage(brisbaneUser.id, "2026-07-20T01:00:00.000Z");

  const { users } = await getAdminUsersPage({ take: 10, now });
  const byId = new Map(users.map((user) => [user.id, user]));

  assert.equal(byId.get(utcUser.id)?.messagesToday, 2);
  assert.equal(byId.get(laUser.id)?.messagesToday, 3);
  assert.equal(byId.get(brisbaneUser.id)?.messagesToday, 2);
  assert.equal(byId.get(utcUser.id)?.timeZone, "UTC");
  assert.equal(byId.get(laUser.id)?.timeZone, "America/Los_Angeles");
  assert.equal(byId.get(brisbaneUser.id)?.timeZone, "Australia/Brisbane");
});

test("creditsToday reads the ChatUsageBucket row keyed to the user's own local-day start", async () => {
  const now = new Date("2026-07-19T20:00:00.000Z");
  const brisbaneUser = await createUser("bne", "Australia/Brisbane");

  await prisma.chatUsageBucket.create({
    data: {
      key: getUserChatUsageKey(brisbaneUser.id),
      period: "day",
      periodStart: new Date("2026-07-19T14:00:00.000Z"),
      count: 7,
    },
  });
  // A bucket keyed to naive UTC midnight must be ignored for this user.
  await prisma.chatUsageBucket.create({
    data: {
      key: getUserChatUsageKey(brisbaneUser.id),
      period: "day",
      periodStart: new Date("2026-07-19T00:00:00.000Z"),
      count: 99,
    },
  });

  const { users } = await getAdminUsersPage({ take: 10, now });
  const row = users.find((user) => user.id === brisbaneUser.id);
  assert.equal(row?.creditsToday, 7);
});

test("getFreshAdminUserStats counts total accounts and plan segments from real rows", async () => {
  await createUser("free", "UTC");
  const pro = await createUser("pro", "UTC");
  await prisma.user.update({
    where: { id: pro.id },
    data: {
      plan: "Pro",
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionStatus: "active",
    },
  });

  const stats = await getFreshAdminUserStats(
    new Date("2026-07-19T20:00:00.000Z")
  );
  assert.equal(stats.totalAccounts, 2);
  assert.equal(stats.proUsers, 1);
  assert.equal(stats.activePaidSubscriptions, 1);
});
