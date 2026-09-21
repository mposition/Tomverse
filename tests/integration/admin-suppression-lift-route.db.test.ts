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
// carrying the caller's own `causeSetDigest` is that the server refuses before it
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
let causeSetDigest: (typeof import("@/lib/emailSuppression"))["causeSetDigest"];

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ recordSuppression, causeSetDigest } = (await import(
    mod("lib/emailSuppression.ts")
  )) as typeof import("@/lib/emailSuppression"));
  route = (await import(
    mod("app/api/admin/email-suppressions/route.ts")
  )) as RouteModule;
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog", "AdminActionApproval", "SuppressionCause",
      "SuppressionEntry", "AppSetting", "User"
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

/** The digest of a selector's live causes, as its console row would carry. */
const liveDigest = (emailAddress: string) =>
  prisma.suppressionCause
    .findMany({
      where: {
        emailAddress,
        releasedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    })
    .then((rows) => causeSetDigest(rows.map((row) => row.id)));

/**
 * The suppression state a request could change, for comparing before and after.
 *
 * Rows rather than counts. A count of released causes and a count of release
 * audit entries leaves out the entry being deleted, a cause gaining a field, an
 * audit entry written under some other action, and an approval changing its
 * status -- and it does not survive a case that starts with a cause already
 * released, which the dead-handle test does. The comparison is a diff of the
 * rows themselves, and it does not need updating when something new becomes
 * writable.
 */
const suppressionState = async () => ({
  causes: await prisma.suppressionCause.findMany({ orderBy: { id: "asc" } }),
  entries: await prisma.suppressionEntry.findMany({ orderBy: { id: "asc" } }),
  audit: await prisma.adminAuditLog.findMany({
    orderBy: { id: "asc" },
    select: { id: true, action: true, targetType: true, targetId: true },
  }),
  approvals: await prisma.adminActionApproval.findMany({ orderBy: { id: "asc" } }),
});

/**
 * Named for what it checks rather than for "nothing happened", because
 * something does: a remove request consumes its rate limit before it looks at
 * any cause, so the usage bucket moves on a refused request as much as on an
 * accepted one. That is deliberate -- a refusal an attacker can retry for free
 * is not a refusal -- and it is out of this assertion's scope rather than
 * missing from it.
 */
const noSuppressionMutation = async (
  before: Awaited<ReturnType<typeof suppressionState>>
) => {
  assert.deepEqual(
    await suppressionState(),
    before,
    "a refused request changed suppression state"
  );
  assert.deepEqual(unexpectedHostCalls, []);
};

test("a lift releases what the caller listed", async () => {
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `lift-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);
  const digest = await liveDigest(emailAddress);

  const response = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: digest,
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

  // The audit entry is the only record of why mail to this address was
  // re-enabled (§13.7), and it commits with the release rather than after it.
  // Its target is the cause set, named by the digest the caller sent.
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "email_suppression.removed" },
  });
  assert.equal(audit.targetType, "SuppressionCauseSet");
  assert.equal(audit.targetId, digest);
  const released = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress },
  });
  assert.deepEqual(
    (released.releaseEvidence as { releaseAuditLogId: string }).releaseAuditLogId,
    audit.id
  );
  assert.deepEqual(
    (audit.metadata as { releasedCauseIds: string[]; remainingCauseIds: string[] })
      .releasedCauseIds,
    [handle.id]
  );
  assert.deepEqual(
    (audit.metadata as { remainingCauseIds: string[] }).remainingCauseIds,
    []
  );
});

test("a partial lift is audited as what it released, not as the row it came from", async () => {
  // The defect this shape prevents is a lie in an immutable record. The row's
  // handle is its newest cause; the release matrix does not release by that. An
  // address holding a `manual` and a later `privacy_request` releases the
  // manual and keeps the privacy request -- and the handle *is* the privacy
  // request, so naming it as the audit target writes an entry that reads as
  // though the legal record had been removed.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `mixed-${randomUUID()}@example.test`;
  await suppress(emailAddress);
  await recordSuppression({
    emailAddress,
    reason: "privacy_request",
    source: "admin",
    sourceEventKey: `test:${randomUUID()}`,
  });

  const privacy = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "privacy_request" },
    select: { id: true },
  });
  const manual = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "manual" },
    select: { id: true },
  });
  const digest = await liveDigest(emailAddress);

  const response = await post({
    action: "remove",
    id: privacy.id,
    causeSetDigest: digest,
    reason: "The manual hold was added by mistake during the migration.",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    removed: boolean;
    released: Array<{ reason: string }>;
    remaining: Array<{ reason: string }>;
  };
  assert.equal(body.removed, false, "a cause remains, so the selector is not clear");
  assert.deepEqual(body.released.map((cause) => cause.reason), ["manual"]);
  assert.deepEqual(body.remaining.map((cause) => cause.reason), ["privacy_request"]);

  // The privacy request is untouched, which is the fact the audit entry has to
  // agree with.
  assert.equal(
    (await prisma.suppressionCause.findUniqueOrThrow({ where: { id: privacy.id } }))
      .releasedAt,
    null
  );

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "email_suppression.removed" },
  });
  assert.equal(audit.targetType, "SuppressionCauseSet");
  assert.equal(audit.targetId, digest);
  // Every field, because the claim is that this entry alone says what happened.
  assert.deepEqual(audit.metadata, {
    reason: "The manual hold was added by mistake during the migration.",
    emailAddress,
    scope: "global",
    purposeKey: "*",
    // The handle is recorded as the row the operator acted from, not as what
    // was removed.
    viaCauseId: privacy.id,
    causeSetDigest: digest,
    releasedCauseIds: [manual.id],
    releasedReasons: ["manual"],
    remainingCauseIds: [privacy.id],
    remainingReasons: ["privacy_request"],
    evidenceKind: "admin",
    approvalId: null,
    authorizationAuditLogId: null,
  });
});

test("a hard bounce lift is authorised, and the entry names the authorisation", async () => {
  // §13.3 calls a hard bounce permanent, so lifting one is not an ordinary
  // remove: it goes through the approval path. With one administrator on the
  // account that resolves to the sole-admin branch, and either way the audit
  // entry has to name *which* authorisation allowed it -- "a second
  // administrator approved it somewhere" is not a record anybody can follow.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `bounced-${randomUUID()}@example.test`;
  await recordSuppression({
    emailAddress,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceEventKey: `test:${randomUUID()}`,
  });
  const handle = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "hard_bounce" },
    select: { id: true },
  });
  const digest = await liveDigest(emailAddress);

  const response = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: digest,
    reason: "The mailbox was recreated by the provider and now accepts mail.",
  });
  assert.equal(response.status, 200);

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "email_suppression.removed" },
  });
  assert.equal(audit.targetType, "SuppressionCauseSet");
  assert.equal(audit.targetId, digest);
  const metadata = audit.metadata as {
    evidenceKind: string;
    approvalId: string | null;
    authorizationAuditLogId: string | null;
    releasedReasons: string[];
  };
  assert.deepEqual(metadata.releasedReasons, ["hard_bounce"]);
  // Exactly the sole-admin branch, because this file configures one
  // administrator. Accepting either branch would let the test pass in a
  // configuration it never runs in and say nothing about the one it does.
  assert.equal(metadata.evidenceKind, "sole_admin");
  assert.equal(metadata.approvalId, null);
  assert.ok(
    metadata.authorizationAuditLogId,
    "the entry does not name the authorisation that allowed it"
  );
  // And the authorisation it names is a real entry, not a string.
  assert.ok(
    await prisma.adminAuditLog.findUnique({
      where: { id: metadata.authorizationAuditLogId! },
    })
  );
});

test("with two administrators the first request approves nothing and releases nothing", async () => {
  // The two-person rule for a permanent reason, from the side this change owns:
  // the request is refused, nothing is released, and the approval that is
  // recorded is bound to **the cause set** rather than to the row handle.
  //
  // What this does not cover, stated rather than implied: the second
  // administrator reviewing that approval and the requester's retry succeeding.
  // The approval row belongs to its requester (`requestedById: actorId` in
  // `claimApproval`), so the second half runs through the approval-review
  // surface rather than through this endpoint, and it is
  // `lib/adminApproval.ts`'s contract rather than this one's.
  const second = "suppression-second@tomverse.test";
  const configuredAdmins = process.env.ADMIN_EMAILS;
  const configuredOwners = process.env.ADMIN_OWNER_EMAILS;
  process.env.ADMIN_EMAILS = `${configuredAdmins},${second}`;
  process.env.ADMIN_OWNER_EMAILS = `${configuredOwners},${second}`;
  try {
    await signInAsOwner();
    await prisma.user.create({ data: { email: second, lastLoginAt: new Date() } });
    await setAuthority("causes");
    const emailAddress = `two-admin-${randomUUID()}@example.test`;
    await recordSuppression({
      emailAddress,
      reason: "hard_bounce",
      source: "provider_webhook",
      sourceEventKey: `test:${randomUUID()}`,
    });
    const handle = await prisma.suppressionCause.findFirstOrThrow({
      where: { emailAddress, reason: "hard_bounce" },
      select: { id: true },
    });
    const digest = await liveDigest(emailAddress);

    const before = await suppressionState();
    const response = await post({
      action: "remove",
      id: handle.id,
      causeSetDigest: digest,
      reason: "The mailbox was recreated by the provider and now accepts mail.",
    });

    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; approvalId: string };
    assert.equal(body.code, "ADMIN_APPROVAL_REQUIRED");

    // Nothing released, and no release audit entry. The approval row and the
    // request entry that go with it are expected new rows, so this compares
    // what the change is responsible for rather than the whole table.
    const after = await suppressionState();
    assert.deepEqual(after.causes, before.causes);
    assert.deepEqual(after.entries, before.entries);
    assert.equal(
      after.audit.filter((row) => row.action === "email_suppression.removed").length,
      0
    );

    const approval = await prisma.adminActionApproval.findUniqueOrThrow({
      where: { id: body.approvalId },
    });
    assert.equal(approval.action, "email_suppression.remove");
    assert.equal(approval.targetType, "SuppressionCauseSet");
    assert.equal(approval.targetId, digest);
    // The payload names the set, not the row the operator clicked, so a cause
    // arriving after the request cannot be covered by that approval.
    assert.deepEqual(approval.payload, {
      viaCauseId: handle.id,
      causeSetDigest: digest,
    });
  } finally {
    process.env.ADMIN_EMAILS = configuredAdmins;
    process.env.ADMIN_OWNER_EMAILS = configuredOwners;
  }
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
  const seen = await liveDigest(emailAddress);

  await recordSuppression({
    emailAddress,
    reason: "unsubscribe",
    source: "unsubscribe_link",
    sourceEventKey: `test:${randomUUID()}`,
  });

  const before = await suppressionState();
  const response = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "approval_stale");
  await noSuppressionMutation(before);
});

test("a handle that is no longer active is stale, and one that never existed is not found", async () => {
  // Two different sentences, because they are two different situations. Before
  // this they were both "not found", which told an operator whose page had gone
  // stale that their suppression had vanished.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `dead-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);
  const seen = await liveDigest(emailAddress);

  await prisma.suppressionCause.update({
    where: { id: handle.id },
    data: { releasedAt: new Date(), releaseKind: "admin" },
  });

  // A diff rather than a count: this selector already has a released cause, so
  // "nothing is released" is false before the request is made.
  const before = await suppressionState();
  const stale = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "approval_stale");
  await noSuppressionMutation(before);

  const missing = await post({
    action: "remove",
    id: "no-such-cause-id",
    causeSetDigest: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });
  assert.equal(missing.status, 404);
  await noSuppressionMutation(before);
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
  const seen = await liveDigest(emailAddress);
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress, releasedAt: null },
    }),
    51
  );

  const response = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: seen,
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
  const seen = await liveDigest(emailAddress);

  await setAuthority("entry");

  const before = await suppressionState();
  const response = await post({
    action: "remove",
    id: handle.id,
    causeSetDigest: seen,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { code: string; error: string };
  assert.equal(body.code, "authority_changed");
  assert.match(body.error, /causes/);
  await noSuppressionMutation(before);
});

test("the request has to carry the causes it saw", async () => {
  // Without them the approval is granted against a set the server read for
  // itself, which is approved by definition.
  await signInAsOwner();
  await setAuthority("causes");
  const emailAddress = `bare-${randomUUID()}@example.test`;
  const handle = await suppress(emailAddress);

  const before = await suppressionState();
  const response = await post({
    action: "remove",
    id: handle.id,
    reason: "The mailbox was restored and the owner asked us to resume.",
  });

  assert.equal(response.status, 400);
  await noSuppressionMutation(before);
});
