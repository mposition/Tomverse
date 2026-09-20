import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { createMarketingChannel } from "@/lib/marketingStore";
import {
  MARKETING_POST_APPROVE_ACTION,
  MARKETING_POST_MARK_REUSABLE_ACTION,
  loadApprovedTemplate,
} from "@/lib/marketingTemplates";
import { prisma } from "@/lib/prisma";

// Proving a template, against a real audit chain.
//
// Contract: docs/policy/marketing-automation.md O4, and the S1 plan's NB2 and
// r4 amendment 5. A template is the only route to a post published without a
// person looking at it, so what makes something a template is not a flag but
// two human audit entries that still verify. This suite builds those chains by
// hand: the entries are written through the real writer, because a fixture that
// inserted rows directly would prove the loader agrees with the fixture rather
// than with the chain.
//
// In production no template resolves during S1 -- nothing writes either action,
// and the routes that will are S2. The valid case here is built by the test.

const AUDIT_SECRET = "marketing-templates-db-secret-0007";
const DIGEST = "d".repeat(64);
const OTHER_DIGEST = "e".repeat(64);

const operator = {
  user: { id: "marketing-approver", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "AdminAuditLog" RESTART IDENTITY CASCADE`,
  );

const historyEntry = (type: string, extra: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  type,
  ...extra,
});

const auditRow = ({
  action,
  targetId,
  metadata,
  system = false,
}: {
  action: string;
  targetId: string;
  metadata: Prisma.InputJsonObject;
  system?: boolean;
}) =>
  system
    ? prisma.$transaction((tx) =>
        writeSystemAuditLog({
          tx,
          systemActor: "marketing-publisher",
          action,
          targetType: "MarketingPost",
          targetId,
          summary: "Written by an agent rather than a person.",
          metadata,
        }),
      )
    : writeAdminAuditLog({
        session: operator,
        request: new Request("https://tomverse.app/api/admin/marketing/approve"),
        action,
        targetType: "MarketingPost",
        targetId,
        summary: "Approved for publication.",
        metadata,
      });

async function channel() {
  const row = await createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  return prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode" },
  });
}

/** A post carried to `approved`, the way the status whitelist requires. */
async function approvedPost(channelId: string, digest = DIGEST) {
  const draft = await prisma.marketingPost.create({
    data: {
      channelId,
      locale: "en",
      kind: "social",
      logicalKey: `template-${Math.random().toString(36).slice(2)}`,
      envelope: {
        channel: "linkedin",
        accountSlug: "linkedin-1",
        locale: "en",
        renderedText: "Three answers to one question, side by side.",
        claimIds: [],
        assets: [],
        finalUrl: null,
        scheduledAt: null,
        disclosureFlags: ["advertising"],
      },
      envelopeDigest: digest,
      rendererVersion: "r1",
      claimIds: [],
      assetIds: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot: {
        priceRows: [],
        catalogue: null,
        modelRegistryRows: [],
        evidenceDigests: [],
      },
      guardDecision: "approval_required",
      guardCodes: [],
      guardRuleIds: [],
      status: "drafted",
      mode: "approval",
      history: [historyEntry("draft", { envelopeDigest: digest })],
      historyVersion: 0,
    },
  });

  await prisma.marketingPost.update({
    where: { id: draft.id },
    data: { status: "pending_approval" },
  });

  const approvalId = await auditRow({
    action: MARKETING_POST_APPROVE_ACTION,
    targetId: draft.id,
    metadata: { actorHadMarketingWrite: true, digest },
  });

  return prisma.marketingPost.update({
    where: { id: draft.id },
    data: {
      status: "approved",
      approvalAuditLogId: approvalId,
      approvedAt: new Date(),
      approvedDigest: digest,
    },
  });
}

/** Mark an approved post reusable, which is the second human decision. */
async function markReusable(
  postId: string,
  {
    digest = DIGEST,
    historyVersion = 0,
    system = false,
  }: { digest?: string; historyVersion?: number; system?: boolean } = {},
) {
  await auditRow({
    action: MARKETING_POST_MARK_REUSABLE_ACTION,
    targetId: postId,
    metadata: { actorHadMarketingWrite: true, digest, historyVersion },
    system,
  });
  return prisma.marketingPost.update({
    where: { id: postId },
    data: { reusableAsTemplate: true },
  });
}

let previousAuditKey: string | undefined;

beforeEach(async () => {
  previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
  await reset();
});

after(async () => {
  if (previousAuditKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousAuditKey;
  await reset();
  await prisma.$disconnect();
});

test("a post approved and then marked reusable is a template", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id);

  const result = await loadApprovedTemplate(prisma, post.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.template.id, post.id);
  assert.equal(result.template.envelopeDigest, DIGEST);
  assert.ok(
    result.template.markedReusableAt.getTime() >
      result.template.approvedAt.getTime(),
    "the marking is the later of the two decisions",
  );
});

test("an approved post that nobody marked reusable is not a template", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);

  // The flag alone is not the decision: this is what the second audit entry is
  // for, and setting the column without one has to fail.
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { reusableAsTemplate: true },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_missing",
  });
});

test("a marking by an agent is not a human decision", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id, { system: true });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_not_evidence",
  });
});

test("a marking of different content is not a marking of this content", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id, { digest: OTHER_DIGEST });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_not_evidence",
  });
});

test("an edit after the approval breaks the template until it is approved again", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id);

  // Any edit changes the digest, and the approval named the old one.
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { envelopeDigest: OTHER_DIGEST },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "content_changed_since_approval",
  });
});

test("an edit recorded after the marking breaks it too", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id, { historyVersion: 0 });

  // The digest is untouched here, so this is the other half of the pair: the
  // history says the words moved even though the digest says they did not, and
  // the two answers are not allowed to disagree.
  //
  // The edit names the audit row that authorised it, and that row's `createdAt`
  // is the database's -- which is what places the edit after the marking, since
  // the entry's own `at` is written by whoever appended it.
  const editId = await auditRow({
    action: "marketing_post.edit",
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true },
  });
  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        historyEntry("edit_revision", {
          envelopeDigest: DIGEST,
          previousEnvelopeDigest: OTHER_DIGEST,
          byAuditLogId: editId,
        }),
      ],
      historyVersion: 1,
    },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "edited_since_marking",
  });
});

test("an entry at the marking's own version is not an edit since the marking", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);

  // One append before the marking, and the marking records the version it saw.
  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        historyEntry("guard_result", {
          decision: "approval_required",
          codes: [],
          ruleIds: [],
        }),
      ],
      historyVersion: 1,
    },
  });
  await markReusable(post.id, { historyVersion: 1 });

  const result = await loadApprovedTemplate(prisma, post.id);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("a tampered audit entry stops proving anything", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id);
  assert.equal((await loadApprovedTemplate(prisma, post.id)).ok, true);

  // The chain is append-only, so this is the one thing a test has to do the
  // hard way: rewrite the row's summary underneath its hash. The trigger
  // refuses an UPDATE, so the row is replaced through the same door an attacker
  // would have to use, with the triggers off for the length of the edit.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_is_append_only"`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AdminAuditLog" SET "summary" = 'Something else entirely' WHERE "action" = $1`,
      MARKETING_POST_APPROVE_ACTION,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_is_append_only"`,
    );
  }

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "approval_not_evidence",
  });
});

test("a post that is not approved, purged or deleted is not a template", async () => {
  const row = await channel();

  const draftOnly = await prisma.marketingPost.create({
    data: {
      channelId: row.id,
      locale: "en",
      kind: "social",
      logicalKey: `template-draft-${Math.random().toString(36).slice(2)}`,
      envelope: {
        channel: "linkedin",
        accountSlug: "linkedin-1",
        locale: "en",
        renderedText: "A draft nobody approved.",
        claimIds: [],
        assets: [],
        finalUrl: null,
        scheduledAt: null,
        disclosureFlags: ["advertising"],
      },
      envelopeDigest: DIGEST,
      rendererVersion: "r1",
      claimIds: [],
      assetIds: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot: {
        priceRows: [],
        catalogue: null,
        modelRegistryRows: [],
        evidenceDigests: [],
      },
      guardDecision: "approval_required",
      guardCodes: [],
      guardRuleIds: [],
      status: "drafted",
      mode: "approval",
      history: [historyEntry("draft", { envelopeDigest: DIGEST })],
      historyVersion: 0,
    },
  });
  await prisma.marketingPost.update({
    where: { id: draftOnly.id },
    data: { reusableAsTemplate: true },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, draftOnly.id), {
    ok: false,
    refusal: "post_state_unusable",
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, "no-such-post"), {
    ok: false,
    refusal: "post_missing",
  });
});

test("a purged or deleted post is not a template, even when both audit rows stand", async () => {
  // §12.2 purges the envelope at 24 months. The audit chain survives it, so
  // without these two checks a template would keep resolving after the words
  // it approved had been removed.
  const row = await channel();

  const purged = await approvedPost(row.id);
  await markReusable(purged.id);
  await prisma.marketingPost.update({
    where: { id: purged.id },
    data: { contentPurgedAt: new Date() },
  });
  assert.deepEqual(await loadApprovedTemplate(prisma, purged.id), {
    ok: false,
    refusal: "content_purged",
  });

  const deleted = await approvedPost(row.id);
  await markReusable(deleted.id);
  await prisma.marketingPost.update({
    where: { id: deleted.id },
    data: { deletedAt: new Date() },
  });
  assert.deepEqual(await loadApprovedTemplate(prisma, deleted.id), {
    ok: false,
    refusal: "post_deleted",
  });
});

test("an approved post with no approval row on it proves nothing", async () => {
  // Fail-closed: `approvalAuditLogId` is nullable, so a row that reached
  // `approved` without one must not resolve.
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id);
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { approvalAuditLogId: null },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "approval_missing",
  });
});

test("a marking that predates its approval is a decision about content that did not exist", async () => {
  // r4 amendment 5 names this explicitly. Built by marking first and then
  // re-approving, which is the order an attacker would have available: the
  // marking is real, human and chain-valid, and it is still not a decision
  // about the approval that followed it.
  const row = await channel();
  const post = await approvedPost(row.id);
  await markReusable(post.id);

  const laterApproval = await auditRow({
    action: MARKETING_POST_APPROVE_ACTION,
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true, digest: DIGEST },
  });
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { approvalAuditLogId: laterApproval, approvedAt: new Date() },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_precedes_approval",
  });
});

test("a marking that does not say which version it saw cannot bound the edit scan", async () => {
  // The other clause of r4 amendment 5. Without `historyVersion` there is no
  // answer to "edited since the marking", and guessing one would mean choosing
  // between scanning nothing and scanning everything.
  const row = await channel();
  const post = await approvedPost(row.id);

  await auditRow({
    action: MARKETING_POST_MARK_REUSABLE_ACTION,
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true, digest: DIGEST },
  });
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { reusableAsTemplate: true },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_version_missing",
  });
});

test("a non-integer version is not a version", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);

  await auditRow({
    action: MARKETING_POST_MARK_REUSABLE_ACTION,
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true, digest: DIGEST, historyVersion: 0.5 },
  });
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { reusableAsTemplate: true },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "marking_version_missing",
  });
});

test("a marking that overstates the version it saw cannot hide a later edit", async () => {
  // The forgery the index scan allowed. Mark at version zero but record `1`,
  // then append an `edit_revision` at index 1 that leaves the digest alone.
  // The post's version and the marking's now both read 1, `slice(2)` looks at
  // nothing, and the digest comparison sees no change -- so every check the
  // module had agreed the template stood.
  //
  // The entry's own `at` is written here, by this test, the way any caller
  // writes it -- so it is set *before* the marking, which is what an attacker
  // with access to that field would do. The audit row the edit names is the
  // thing that cannot be backdated.
  const row = await channel();
  const post = await approvedPost(row.id);

  await auditRow({
    action: MARKETING_POST_MARK_REUSABLE_ACTION,
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true, digest: DIGEST, historyVersion: 1 },
  });
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: { reusableAsTemplate: true },
  });

  const editId = await auditRow({
    action: "marketing_post.edit",
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true },
  });
  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        {
          ...historyEntry("edit_revision", {
            envelopeDigest: DIGEST,
            previousEnvelopeDigest: DIGEST,
            byAuditLogId: editId,
          }),
          at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      historyVersion: 1,
    },
  });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "edited_since_marking",
  });
});

test("an edit that names no audit row cannot be placed at all", async () => {
  // `byAuditLogId` is nullable, and an edit without one has no time this
  // module can trust. "Cannot be shown to precede the marking" is the same
  // answer as "did not": the cost is that a person approves the post.
  const row = await channel();
  const post = await approvedPost(row.id);

  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        historyEntry("edit_revision", {
          envelopeDigest: DIGEST,
          previousEnvelopeDigest: OTHER_DIGEST,
          byAuditLogId: null,
        }),
      ],
      historyVersion: 1,
    },
  });
  await markReusable(post.id, { historyVersion: 1 });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "edit_not_datable",
  });
});

test("an edit naming an audit row that is not there cannot be placed either", async () => {
  const row = await channel();
  const post = await approvedPost(row.id);

  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        historyEntry("edit_revision", {
          envelopeDigest: DIGEST,
          previousEnvelopeDigest: OTHER_DIGEST,
          byAuditLogId: "audit-row-that-was-never-written",
        }),
      ],
      historyVersion: 1,
    },
  });
  await markReusable(post.id, { historyVersion: 1 });

  assert.deepEqual(await loadApprovedTemplate(prisma, post.id), {
    ok: false,
    refusal: "edit_not_datable",
  });
});

test("an edit before the marking does not break the template", async () => {
  // The other direction, so the scan is not simply refusing everything: a post
  // edited, then approved, then marked, is a template. The edit's audit row is
  // written before the marking's, which is the order that makes it earlier.
  const row = await channel();
  const post = await approvedPost(row.id);

  const editId = await auditRow({
    action: "marketing_post.edit",
    targetId: post.id,
    metadata: { actorHadMarketingWrite: true },
  });
  const history = post.history as Prisma.InputJsonValue[];
  await prisma.marketingPost.update({
    where: { id: post.id },
    data: {
      history: [
        ...history,
        {
          ...historyEntry("edit_revision", {
            envelopeDigest: DIGEST,
            previousEnvelopeDigest: OTHER_DIGEST,
            byAuditLogId: editId,
          }),
          // Written in the future by the caller, and it changes nothing: the
          // audit row is what the decision reads.
          at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      historyVersion: 1,
    },
  });
  await markReusable(post.id, { historyVersion: 1 });

  const result = await loadApprovedTemplate(prisma, post.id);
  assert.equal(result.ok, true, JSON.stringify(result));
});
