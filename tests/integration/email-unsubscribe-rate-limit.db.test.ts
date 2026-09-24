import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { POST } from "@/app/api/unsubscribe/route";
import { prisma } from "@/lib/prisma";
import { createUnsubscribeToken, readUnsubscribeKeyring } from "@/lib/unsubscribeToken";

// Who the unsubscribe endpoint turns away, against a real database.
//
// Contract: docs/policy/email-notifications.md §11.3.
//
// The origin limit used to run before the token was read, so twenty valid
// one-click requests a minute from one address -- a corporate NAT, or one
// mailbox provider's fetcher acting for many recipients -- were enough to 429
// a real unsubscribe. A valid token can only switch something off, so it is now
// bounded per subject instead, and only requests that are not a valid token are
// charged to their origin.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatUsageBucket", "ConsentRecord", "SuppressionEntry", "EmailPreference",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-secret";
  process.env.EMAIL_UNSUBSCRIBE_KEY_VERSION = "v1";
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const SHARED_ORIGIN = "203.0.113.10";

// The limiter stores one count per calendar UTC minute. On 2026-09-24 the
// subject replay started at 09:42:59.377Z and its 31st request landed in the
// next minute, so that request was still under the limit and returned 200.
// Wait until the current minute can hold the whole loop.
const waitForUtcMinuteRoom = async (minimumMs: number) => {
  const remaining = 60_000 - (Date.now() % 60_000);
  if (remaining >= minimumMs) return;
  await new Promise((resolve) => setTimeout(resolve, remaining + 25));
};

const request = (token: string) =>
  new Request("http://localhost/api/unsubscribe", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-real-ip": SHARED_ORIGIN,
    },
    body: new URLSearchParams({ t: token }).toString(),
  });

const validTokenFor = async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.com` },
  });
  const keyring = readUnsubscribeKeyring(process.env);
  assert.ok(keyring);
  return createUnsubscribeToken({ userId: user.id, purpose: "newsletter" }, keyring);
};

test("many valid unsubscribes from one origin are all processed", async () => {
  // Past both the old per-origin limit (20) and its IP leg (60).
  const statuses: number[] = [];
  for (let index = 0; index < 65; index += 1) {
    const response = await POST(request(await validTokenFor()));
    statuses.push(response.status);
  }
  assert.deepEqual(
    statuses.filter((status) => status !== 200),
    [],
    "a valid token must not be refused because of where it came from"
  );
});

test("invalid tokens from one origin are still limited", async () => {
  await waitForUtcMinuteRoom(15_000);
  const statuses: number[] = [];
  for (let index = 0; index < 21; index += 1) {
    const response = await POST(request(`u1.v1.${randomUUID()}.garbage.tag`));
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(400));
  assert.equal(statuses[20], 429);
});

test("a valid token still gets through after its origin used up the invalid limit", async () => {
  await waitForUtcMinuteRoom(15_000);
  for (let index = 0; index < 20; index += 1) {
    await POST(request("not-a-token"));
  }
  assert.equal((await POST(request("not-a-token"))).status, 429);

  const response = await POST(request(await validTokenFor()));
  assert.equal(response.status, 200);
});

test("one valid token replayed without end is bounded per subject", async () => {
  await waitForUtcMinuteRoom(15_000);
  const token = await validTokenFor();
  const statuses: number[] = [];
  for (let index = 0; index < 31; index += 1) {
    statuses.push((await POST(request(token))).status);
  }
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses[30], 429);
});
