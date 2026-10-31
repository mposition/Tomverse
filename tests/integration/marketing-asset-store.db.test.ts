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
import { POST as submitRoute } from "@/app/api/internal/marketing-assets/route";
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
// Assembled: a test value, not a credential.
const MEDIA_SECRET = ["media", "cli", "db", "test", "value", "0001", "padding"].join("-");
const R2_ENV = {
  MARKETING_MEDIA_SUBMIT_SECRET: MEDIA_SECRET,
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-access",
  R2_SECRET_ACCESS_KEY: ["test", "r2", "value"].join("-"),
  R2_BUCKET_NAME: "test-bucket",
} as const;
const previousEnv: Record<string, string | undefined> = {};
before(() => {
  for (const [name, value] of Object.entries(R2_ENV)) {
    previousEnv[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const name of Object.keys(R2_ENV)) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

/** The media CLI's request, through the route itself. */
const postSubmission = async (body: unknown) => {
  const response = await submitRoute(
    new Request("https://tomverse.app/api/internal/marketing-assets", {
      method: "POST",
      headers: { authorization: `Bearer ${MEDIA_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const assetCount = async () =>
  Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "MarketingAsset"`))[0].n);
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
  transcript: {
    en: "Ask three models at once and compare their answers side by side.",
    ko: "세 모델에 한 번에 묻고 답을 나란히 비교하세요.",
  },
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
  assert.deepEqual(first, {
    assetId: ID,
    r2Key: `marketing-assets/${ID}/original.mp4`,
    // The upload URL is signed for this key only; the kept copy is the server's.
    uploadKey: `marketing-assets/${ID}/upload.mp4`,
    existing: false,
  });
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
  await assert.rejects(decide("approved", "d".repeat(64)), code("asset_decision_mismatch"));
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
    code("asset_decision_mismatch"),
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
         "transcript", "status", "updatedAt")
       VALUES ('media-ai-ui', 'image', 'ai_generated', ARRAY['x'], '{"x":"platform_label"}', '{"en":"A screen."}', ARRAY[]::TEXT[],
         '2099-01-01', true, 'marketing-assets/media-ai-ui/original.png', 'image/png', 10, $1, NULL, '{}', 'submitted', now())`,
      SHA,
    ),
    refusedBy("MarketingAsset_interface_check"),
  );
});

test("what the video says passes the Guard before a row exists: a rejection writes nothing and names codes, not words", async () => {
  // A claim the registry does not have: the draft intake's Guard rejects it.
  const rejected = await postSubmission(
    submission({ asset: { ...submission().asset, claimIds: ["no.such.claim"] } }),
  );
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.code, "transcript_guard_rejected");
  assert.ok(Array.isArray(rejected.body.guardCodes) && (rejected.body.guardCodes as string[]).includes("claim_unknown"));
  assert.equal(JSON.stringify(rejected.body).includes("compare their answers"), false, "the words are not repeated back");
  assert.equal(await assetCount(), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "MarketingAsset" } }), 0);
});

test("a transcript the Guard passes is stored with the submission, and the upload URL is for the upload key", async () => {
  const accepted = await postSubmission(submission());
  assert.equal(accepted.status, 200);
  const result = accepted.body.result as { assetId: string; upload: { url: string } };
  assert.equal(result.assetId, ID);
  assert.match(result.upload.url, /\/upload\.mp4\?/u);
  const stored = await prisma.$queryRawUnsafe<Array<{ transcript: Record<string, string>; status: string }>>(
    `SELECT "transcript", "status" FROM "MarketingAsset" WHERE "id" = $1`,
    ID,
  );
  assert.equal(stored[0].status, "submitted");
  assert.deepEqual(stored[0].transcript, submission().transcript);

  // A different script under the same id is a different submission.
  const changed = await postSubmission(submission({ transcript: { en: "Another script entirely." } }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "asset_id_taken");

  // The words never change after the submission.
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingAsset" SET "transcript" = '{}' WHERE "id" = $1`, ID),
    refusedBy("marketing_asset_submission_is_immutable"),
  );
});

test("the database refuses a video with nothing said and a transcript past its length", async () => {
  const insert = (id: string, transcript: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingAsset" ("id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds",
         "validUntil", "depictsProductInterface", "r2Key", "contentType", "bytes", "sha256", "durationSeconds",
         "transcript", "status", "updatedAt")
       VALUES ($1, 'video', 'capture', ARRAY['x'], '{"x":"none"}', '{"en":"A screen."}', ARRAY[]::TEXT[],
         '2099-01-01', true, 'marketing-assets/' || $1 || '/original.mp4', 'video/mp4', 10, $2, 5,
         $3::jsonb, 'submitted', now())`,
      id,
      SHA,
      transcript,
    );
  await assert.rejects(insert("media-silent", "{}"), refusedBy("MarketingAsset_transcript_check"));
  await assert.rejects(
    insert("media-long", JSON.stringify({ en: "a".repeat(20_001) })),
    refusedBy("MarketingAsset_transcript_check"),
  );
  await assert.rejects(insert("media-locale", JSON.stringify({ fr: "Bonjour." })), refusedBy("MarketingAsset_transcript_check"));
});

test("an image that says nothing still has its declared claims judged, through its alt text", async () => {
  const image = submission({
    asset: { ...submission().asset, claimIds: ["no.such.claim"] },
    kind: "image",
    contentType: "image/png",
    bytes: 400_000,
    durationSeconds: null,
    transcript: undefined,
  });
  const rejected = await postSubmission(image);
  assert.equal(rejected.status, 422);
  assert.ok((rejected.body.guardCodes as string[]).includes("claim_unknown"));
  assert.equal(await assetCount(), 0);

  const plain = await postSubmission({ ...image, asset: { ...image.asset, claimIds: [] } });
  assert.equal(plain.status, 200);
  const stored = await prisma.$queryRawUnsafe<Array<{ transcript: Record<string, string> }>>(
    `SELECT "transcript" FROM "MarketingAsset" WHERE "id" = $1`,
    ID,
  );
  assert.deepEqual(stored[0].transcript, {});
});
