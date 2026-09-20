import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { SUPPRESSION_READ_AUTHORITY_KEY } from "@/lib/emailSuppressionAuthorityCore";

// The suppression lift endpoint, driven end to end against a real PostgreSQL.
//
// Contract: docs/policy/email-notifications.md v25, §13.7.
//
// The library tests beside this one prove what `liftSuppressionCauses()` does
// when it is called correctly. What they cannot prove is the part deploy C-1
// actually changed: **which requests reach it at all.** The whole point of
// carrying `causeIds` in from the caller is that the server refuses before it
// writes anything, and a refusal that only exists inside the library is a
// refusal an operator never meets.
//
// Four answers are pinned here, because each is a different thing going wrong
// and each used to be indistinguishable from "not found":
//
//   - the caller's set no longer matches -> 409, nothing written;
//   - the handle resolved but is no longer active -> 409, nothing written;
//   - the handle never existed -> 404;
//   - the read authority went back to entries -> 409, nothing written.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces next-auth for every
// module that imports it.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.ADMIN_EMAILS = "suppression-owner@tomverse.test";
process.env.ADMIN_OWNER_EMAILS = "suppression-owner@tomverse.test";
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "suppression-lift-audit-test-key";

// --- session seam ----------------------------------------------------------
let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

// Nothing here may reach the network.
let unexpectedHostCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  unexpectedHostCalls.push(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url)
  );
  return new Response(null, { status: 204 });
}) as typeof fetch;

type RouteModule = {
  POST: (request: Request) => Promise<Response>;
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: RouteModule;
let recordSuppression: (typeof import("@/lib/emailSuppression"))["recordSuppression"];

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ recordSuppression } = (await import(
    mod("lib/emailSuppression.ts")
  )) as typeof import("@/lib/emailSuppression"));
  route = (await import(
    mod("app/api/admin/email-suppressions/route.ts")
  )) as RouteModule;
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog", "SuppressionCause", "SuppressionEntry", "AppSetting",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  unexpectedHostCalls = [];
  sessionOverride = null;
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const setAuthority = (value: "entry" | "causes") =>
  prisma.appSetting.upsert({
    where: { key: SUPPRESSION_READ_AUTHORITY_KEY },
    create: { key: SUPPRESSION_READ_AUTHORITY_KEY, value },
    update: { value },
  });

const signInAsOwner = async () => {
  const user = await prisma.user.create({
    data: { email: "suppression-owner@tomverse.test", lastLoginAt: new Date() },
  });
  sessionOverride = {
    user: {
      id: user.id,
      email: user.email,
      name: "Suppression Owner",
      authenticatedAt: new Date().toISOString(),
    },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const post = (body: unknown) =>
  route.POST(
    new Request("https://tomverse.test/api/admin/email-suppressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

/** A `manual` cause, which the release matrix lets one administrator lift. */
const suppress = async (emailAddress: string, extra: Record<string, unknown> = {}) => {
  await recordSuppression({
    emailAddress,
    reason: "manual",
    source: "admin",
    sourceEventKey: `test:${randomUUID()}`,
    ...extra,
  });
  return prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, releasedAt: null },
    orderBy: { id: "desc" },
    select: { id: true },
  });
};

const activeCauseIds = (emailAddress: string) =>
  prisma.suppressionCause
    .findMany({
      where: { emailAddress, releasedAt: null },
      select: { id: true },
    })
    .then((rows) => rows.map((row) => row.id));

/** Nothing was released and nothing was audited. */
const nothingHappened = async (emailAddress: string) => {
  const released = await prisma.suppressionCause.count({
    where: { emailAddress, releasedAt: { not: null } },
  });
  assert.equal(released, 0, "a cause was released by a refused request");
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: "email_suppression.removed" } }),
    0,
    "a refused request wrote a release audit entry"
  );
  assert.deepEqual(unexpectedHostCalls, []);
};

test("a lift releases what the caller listed", async () => {
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `lift-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);

  const response = await post({
    action: "remove",
    id: handle.id,
    causeIds: await activeCauseIds(emailAddress),
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { removed: boolean; providerListUnchanged: boolean };
  assert.equal(body.removed, true);
  // Said in the response because the opposite assumption is the expensive one:
  // our list is not the provider's (§5.3.1).
  assert.equal(body.providerListUnchanged, true);
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress, releasedAt: null },
    }),
    0
  );
});

test("a cause added after the listing refuses the lift instead of being released with it", async () => {
  // The defect this endpoint's shape exists to prevent: an operator lifts an
  // address for the soft bounce they can see, and an unsubscribe that arrived
  // while the page sat open goes with it -- so we resume mailing somebody who
  // asked us to stop.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `stale-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);
  const seen = await activeCauseIds(emailAddress);

  await recordSuppression({
    emailAddress,
    reason: "unsubscribe",
    source: "unsubscribe_link",
    sourceEventKey: `test:${randomUUID()}`,
  });

  const response = await post({
    action: "remove",
    id: handle.id,
    causeIds: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "approval_stale");
  await nothingHappened(emailAddress);
});

test("a handle that is no longer active is stale, and one that never existed is not found", async () => {
  // Two different sentences, because they are two different situations. Before
  // this they were both "not found", which told an operator whose page had gone
  // stale that their suppression had vanished.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `dead-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);
  const seen = await activeCauseIds(emailAddress);

  await prisma.suppressionCause.update({
    where: { id: handle.id },
    data: { releasedAt: new Date(), releaseKind: "admin" },
  });

  const stale = await post({
    action: "remove",
    id: handle.id,
    causeIds: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "approval_stale");

  const missing = await post({
    action: "remove",
    id: "no-such-cause-id",
    causeIds: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });
  assert.equal(missing.status, 404);
});

test("a selector with more causes than any cap can still be lifted", async () => {
  // `SuppressionCause` is append-only and a provider retrying a soft bounce
  // adds a row each time, so nothing bounds how many a selector holds. A cap on
  // the request's `causeIds` would make such a selector visible and permanently
  // unliftable: send them all and the schema refuses, send fewer and the set
  // does not match.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `crowded-${randomUUID()}@example.test`;
  let handle = { id: "" };
  for (let index = 0; index < 51; index += 1) {
    handle = await suppress(emailAddress);
  }
  const seen = await activeCauseIds(emailAddress);
  assert.equal(seen.length, 51);

  const response = await post({
    action: "remove",
    id: handle.id,
    causeIds: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 200);
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress, releasedAt: null },
    }),
    0
  );
});

test("the entry authority refuses the lift and says which of the two it is", async () => {
  // This build's console hands out cause ids, which the entry path cannot
  // resolve. Answering 404 would read as "that suppression is gone" when what
  // happened is that the setting went back below this deploy's rollback floor.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `authority-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);
  const seen = await activeCauseIds(emailAddress);

  await setAuthority("entry");

  const response = await post({
    action: "remove",
    id: handle.id,
    causeIds: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { code: string; error: string };
  assert.equal(body.code, "authority_changed");
  assert.match(body.error, /causes/);
  await nothingHappened(emailAddress);
});

test("the request has to carry the causes it saw", async () => {
  // Without them the approval is granted against a set the server read for
  // itself, which is approved by definition.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `bare-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);

  const response = await post({
    action: "remove",
    id: handle.id,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 400);
  await nothingHappened(emailAddress);
});
