import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { hashExportTicketToken } from "@/lib/accountDataExportTicketCore";
import {
  issueAccountDataExportTicket,
  purgeExpiredAccountDataExportRequests,
  recordAccountDataExportDelivery,
  redeemAccountDataExportTicket,
} from "@/lib/accountDataExportTickets";

// The claims that only a real database can settle: that a ticket is spent
// exactly once under concurrency, that the stored row is not a download link,
// and that a refused redemption leaves a trail.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "AccountDataExportRequest", "User" RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });

const request = (ip = "203.0.113.7") =>
  new Request("https://tomverse.app/api/user/account/export", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "user-agent": "TestAgent/1.0" },
  });

test("the issued token is returned once and never stored", async () => {
  const user = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: user.id, request: request() });

  const rows = await prisma.accountDataExportRequest.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1);

  const [row] = rows;
  assert.notEqual(row.tokenHash, ticket.token);
  assert.equal(
    row.tokenHash,
    hashExportTicketToken(ticket.token, process.env.NEXTAUTH_SECRET ?? "")
  );
  // A copy of this table must not yield a working link.
  assert.equal(JSON.stringify(row).includes(ticket.token), false);
  assert.equal(row.status, "issued");
  assert.equal(row.consumedAt, null);
});

// The request context is kept as a hash, not as an address: the audit answers
// "was this the usual place" without becoming a location history.
test("the request context is recorded hashed, never in the clear", async () => {
  const user = await createUser();
  await issueAccountDataExportTicket({ userId: user.id, request: request("198.51.100.24") });

  const row = await prisma.accountDataExportRequest.findFirstOrThrow({
    where: { userId: user.id },
  });
  const serialised = JSON.stringify(row);
  assert.equal(serialised.includes("198.51.100.24"), false);
  assert.equal(serialised.includes("TestAgent/1.0"), false);
  assert.match(row.issuedIpHash, /^[0-9a-f]{64}$/);
  assert.match(row.issuedUserAgentHash, /^[0-9a-f]{64}$/);
});

test("a ticket redeems once and is refused thereafter", async () => {
  const user = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: user.id, request: request() });

  const first = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: user.id,
    request: request(),
  });
  assert.equal(first.ok, true);

  const second = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: user.id,
    request: request(),
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "already_used");
});

// The reason the claim is one conditional UPDATE rather than a read then a
// write. Two tabs opening the same link must produce one download and one
// refusal, not two downloads.
test("concurrent redemptions of the same ticket produce exactly one download", async () => {
  const user = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: user.id, request: request() });

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      redeemAccountDataExportTicket({
        token: ticket.token,
        userId: user.id,
        request: request(),
      })
    )
  );

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 7);

  const row = await prisma.accountDataExportRequest.findFirstOrThrow({
    where: { userId: user.id },
  });
  assert.equal(row.status, "downloaded");
  assert.notEqual(row.consumedAt, null);
});

// The case the ticket exists for: the link reached somebody else, who is signed
// in as themselves.
test("another account cannot redeem the ticket, and the attempt is recorded", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: owner.id, request: request() });

  const refused = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: stranger.id,
    request: request("192.0.2.99"),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "wrong_user");

  const row = await prisma.accountDataExportRequest.findFirstOrThrow({
    where: { userId: owner.id },
  });
  assert.equal(row.refusalReason, "wrong_user");
  assert.equal(row.status, "refused");
  // Still spendable by its owner: a stranger presenting it must not be able to
  // burn somebody else's link.
  assert.equal(row.consumedAt, null);

  const byOwner = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: owner.id,
    request: request(),
  });
  assert.equal(byOwner.ok, true);
});

test("an expired ticket is refused", async () => {
  const user = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: user.id, request: request() });
  await prisma.accountDataExportRequest.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  const refused = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: user.id,
    request: request(),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "expired");
});

test("an unknown token is refused and writes no row", async () => {
  const user = await createUser();
  const refused = await redeemAccountDataExportTicket({
    token: "not-a-real-token",
    userId: user.id,
    request: request(),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "unknown_token");
  assert.equal(await prisma.accountDataExportRequest.count(), 0);
});

test("the delivery record holds counts, never the data", async () => {
  const user = await createUser();
  const ticket = await issueAccountDataExportTicket({ userId: user.id, request: request() });
  const redemption = await redeemAccountDataExportTicket({
    token: ticket.token,
    userId: user.id,
    request: request(),
  });
  assert.equal(redemption.ok, true);
  if (!redemption.ok) return;

  await recordAccountDataExportDelivery({
    ticketId: redemption.ticketId,
    exportSchemaVersion: 1,
    includedDomainCount: 9,
    filteredDomainCount: 8,
    byteLength: 4_096,
  });

  const row = await prisma.accountDataExportRequest.findUniqueOrThrow({
    where: { id: redemption.ticketId },
  });
  assert.equal(row.exportSchemaVersion, 1);
  assert.equal(row.includedDomainCount, 9);
  assert.equal(row.byteLength, 4_096);
});

// The audit outlives the ticket by design. A trail covering only the last five
// minutes is the same as having none.
test("the retention sweep keeps recent audit rows and drops rows past ninety days", async () => {
  const user = await createUser();
  await issueAccountDataExportTicket({ userId: user.id, request: request() });
  const old = await issueAccountDataExportTicket({ userId: user.id, request: request() });
  await prisma.accountDataExportRequest.updateMany({
    where: { tokenHash: hashExportTicketToken(old.token, process.env.NEXTAUTH_SECRET ?? "") },
    data: { createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000) },
  });

  const purged = await purgeExpiredAccountDataExportRequests();
  assert.equal(purged, 1);

  const remaining = await prisma.accountDataExportRequest.findMany({
    where: { userId: user.id },
  });
  assert.equal(remaining.length, 1);
  // Expired but recent: still an audit record, even though the link is dead.
  assert.equal(remaining[0].status, "issued");
});

test("deleting the account takes its export audit trail with it", async () => {
  const user = await createUser();
  await issueAccountDataExportTicket({ userId: user.id, request: request() });
  assert.equal(await prisma.accountDataExportRequest.count(), 1);

  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.accountDataExportRequest.count(), 0);
});
