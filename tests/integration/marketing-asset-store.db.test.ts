import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_ASSET_ACTIONS, MARKETING_ASSET_NO_DECISION } from "@/lib/marketingAssetCore";
import {
  confirmMarketingAssetUpload,
  decideMarketingAsset,
  readApprovedMarketingAssetLocation,
  readMarketingAssetsForConsole,
  submitMarketingAsset,
} from "@/lib/marketingAssetStore";
import type { MarketingAssetSubmission } from "@/lib/marketingAssetSubmission";
import { resolveMarketingAsset } from "@/lib/marketingAssets";
import { readMarketingAssetRegistry } from "@/lib/marketingFactResolution";
import { runMarketingTransaction, type MarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

// The media asset store (operator decision 2026-10-31): the media CLI submits
// and uploads, a person approves or retires, and only an approved file reaches
// the registry the Guard reads. The database checks each decision against the
// person's own audit row, so these run against a real audit chain.

// Assembled rather than spelled out: a test value is not a credential.
const AUDIT_CHAIN_TEST_VALUE = ["marketing", "asset", "db", "audit", "0001"].join("-");
let previousAuditKey: string | undefined;
before(() => {
  previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_CHAIN_TEST_VALUE;
});
const reset = () => resetTestFixture(prisma, `TRUNCATE TABLE "MarketingAsset", "AdminAuditLog" RESTART IDENTITY CASCADE`);
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
  if (previousAuditKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousAuditKey;
});

const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

const tx = <T>(fn: (client: MarketingTransaction) => Promise<T>) => runMarketingTransaction(prisma, fn);
const refusedBy = (message: string) => (error: unknown) => error instanceof Error && error.message.includes(message);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

const SHA = "b".repeat(64);
const ID = "media-20261031-compare";

const submission = (overrides: Partial<MarketingAssetSubmission> = {}): MarketingAssetSubmission => ({
  asset: {
    id: ID,
    provenance: "capture",
    allowedChannels: ["youtube", "instagram"],
    alt: { en: "Three answers side by side in Tomverse.", ko: "Tomverse에서 세 답변을 나란히 봅니다." },
    claimIds: [],
    validUntil: "2099-01-31",
    disclosure: { youtube: "none", instagram: "none" },
    depictsProductInterface: true,
  },
  kind: "video",
  contentType: "video/mp4",
  bytes: 12_000_000,
  sha256: SHA,
  durationSeconds: 45,
  ...overrides,
});

type Row = { status: string; decisionAuditLogId: string | null; registryVersion: number | null; uploadedAt: Date | null };
const row = async (id = ID): Promise<Row> =>
  (
    await prisma.$queryRawUnsafe<Row[]>(
      `SELECT "status", "decisionAuditLogId", "registryVersion", "uploadedAt" FROM "MarketingAsset" WHERE "id" = $1`,
      id,
    )
  )[0];

/** A person's audit row, as `runMarketingAdminMutation` writes it. */
const humanAudit = (
  client: Prisma.TransactionClient,
  decision: "approved" | "retired",
  recorded: { previous: string | null; sha256?: string; targetId?: string },
) =>
  writeAdminAuditLog({
    session: operator,
    request: new Request("https://tomverse.app/api/admin/marketing/assets/x/decision"),
    action: MARKETING_ASSET_ACTIONS[decision],
    targetType: "MarketingAsset",
    targetId: recorded.targetId ?? ID,
    summary: "Asset decision.",
    metadata: {
      actorHadMarketingWrite: true,
      previousDecisionAuditLogId: recorded.previous ?? MARKETING_ASSET_NO_DECISION,
      ...(recorded.sha256 ? { sha256: recorded.sha256 } : {}),
    },
    tx: client,
  });

const decide = async (decision: "approved" | "retired", sha256 = SHA) => {
  const expected = (await row()).decisionAuditLogId;
  return tx(async (client) => {
    const auditLogId = await humanAudit(client, decision, { previous: expected, sha256 });
    return decideMarketingAsset(client, { assetId: ID, decision, expectedDecisionAuditLogId: expected, auditLogId });
  });
};

const submitAndUpload = async () => {
  await tx((client) => submitMarketingAsset(client, submission()));
  await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
};

test("a submission is stored with its object key and the media agent's audit row, and a resend is read back", async () => {
  const first = await tx((client) => submitMarketingAsset(client, submission()));
  assert.deepEqual(first, { assetId: ID, r2Key: `marketing-assets/${ID}/original.mp4`, existing: false });
  const again = await tx((client) => submitMarketingAsset(client, submission()));
  assert.equal(again.existing, true);
  assert.equal(again.r2Key, first.r2Key);

  const audits = await prisma.adminAuditLog.findMany({ where: { targetType: "MarketingAsset" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "marketing_asset.submitted");

  // An id names one file.
  await assert.rejects(tx((client) => submitMarketingAsset(client, submission({ sha256: "c".repeat(64) }))), code("asset_id_taken"));
  assert.equal((await row()).status, "submitted");
});

test("nothing is approved before its file is uploaded, and the upload is recorded once at the announced size", async () => {
  await tx((client) => submitMarketingAsset(client, submission()));
  await assert.rejects(decide("approved"), code("asset_not_uploaded"));

  await assert.rejects(
    tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 1 })),
    code("asset_size_mismatch"),
  );
  const first = await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
  const second = await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
  assert.equal(second.uploadedAt, first.uploadedAt);
  // An uploaded submission is not reopened by a resend.
  await assert.rejects(tx((client) => submitMarketingAsset(client, submission())), code("asset_already_uploaded"));
});

test("an approval is a person's, about exactly these bytes; then the file is in the registry and the publisher can find it", async () => {
  await submitAndUpload();
  assert.equal(await readApprovedMarketingAssetLocation(prisma, ID), null);

  // Other bytes than the row's: the guard refuses.
  await assert.rejects(decide("approved", "d".repeat(64)), refusedBy("marketing_asset_decision_not_a_person"));
  // A system actor's audit row is not a person's.
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await writeSystemAuditLog({
        tx: client,
        systemActor: "marketing-generator",
        action: "marketing_asset.submitted",
        targetType: "MarketingAsset",
        targetId: ID,
        summary: "Not a decision.",
        metadata: {},
      });
      return decideMarketingAsset(client, { assetId: ID, decision: "approved", expectedDecisionAuditLogId: null, auditLogId });
    }),
    refusedBy("marketing_asset_decision_not_a_person"),
  );

  const before = await readMarketingAssetRegistry(prisma);
  const approved = await decide("approved");
  assert.equal(approved.status, "approved");
  const stored = await row();
  assert.equal(stored.registryVersion, approved.registryVersion);

  assert.deepEqual(await readApprovedMarketingAssetLocation(prisma, ID), {
    r2Key: `marketing-assets/${ID}/original.mp4`,
    kind: "video",
    contentType: "video/mp4",
    bytes: 12_000_000,
    provenance: "capture",
  });

  const registry = await readMarketingAssetRegistry(prisma);
  assert.ok(registry && before);
  assert.ok(registry.version > before.version, "the registry version moves with an approval");
  const resolved = resolveMarketingAsset({ id: ID, channel: "youtube", locale: "ko", on: new Date(), registry });
  assert.equal(resolved.ok, true);
  const offChannel = resolveMarketingAsset({ id: ID, channel: "x", locale: "en", on: new Date(), registry });
  assert.deepEqual(offChannel, { ok: false, refusal: "channel_not_allowed" });

  // Without a client, the registry is the hand-kept file alone.
  const fileOnly = await readMarketingAssetRegistry();
  assert.equal(fileOnly?.assets.some((asset) => asset.id === ID), false);
});

test("a retirement takes the file out of the registry and the publisher's reach, and a stale page cannot decide", async () => {
  await submitAndUpload();
  await decide("approved");
  const approvedVersion = (await readMarketingAssetRegistry(prisma))!.version;

  // A decision made against the submission the page showed, after the approval.
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "retired", { previous: null });
      return decideMarketingAsset(client, { assetId: ID, decision: "retired", expectedDecisionAuditLogId: null, auditLogId });
    }),
    code("asset_decision_conflict"),
  );

  await decide("retired");
  assert.equal(await readApprovedMarketingAssetLocation(prisma, ID), null);
  const registry = (await readMarketingAssetRegistry(prisma))!;
  assert.equal(registry.assets.some((asset) => asset.id === ID), false);
  assert.ok(registry.version > approvedVersion, "a retirement moves the registry version too");
  // Retired is final for a file; a new file is a new asset.
  await assert.rejects(decide("approved"), code("asset_transition_invalid"));

  const listed = await readMarketingAssetsForConsole(prisma, 100);
  assert.equal(listed.rows[0].status, "retired");
});

test("the database refuses what the store never sends: a changed file, an AI picture of the product, a deletion", async () => {
  await tx((client) => submitMarketingAsset(client, submission()));
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingAsset" SET "sha256" = $1 WHERE "id" = $2`, "e".repeat(64), ID),
    refusedBy("marketing_asset_submission_is_immutable"),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingAsset" SET "provenance" = 'ai_generated' WHERE "id" = $1`, ID),
    (error: unknown) => error instanceof Error && /MarketingAsset_(interface|disclosure)_check|immutable/u.test(error.message),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`DELETE FROM "MarketingAsset" WHERE "id" = $1`, ID),
    refusedBy("marketing_asset_is_never_deleted"),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingAsset" ("id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds",
         "validUntil", "depictsProductInterface", "r2Key", "contentType", "bytes", "sha256", "durationSeconds",
         "status", "updatedAt")
       VALUES ('media-ai-ui', 'image', 'ai_generated', ARRAY['x'], '{"x":"platform_label"}', '{"en":"A screen."}', ARRAY[]::TEXT[],
         '2099-01-01', true, 'marketing-assets/media-ai-ui/original.png', 'image/png', 10, $1, NULL, 'submitted', now())`,
      SHA,
    ),
    refusedBy("MarketingAsset_interface_check"),
  );
});
