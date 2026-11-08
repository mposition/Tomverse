import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_ASSET_ACTIONS, MARKETING_ASSET_NO_DECISION } from "@/lib/marketingAssetCore";
import {
  confirmMarketingAssetUpload,
  decideMarketingAsset,
  readApprovedMarketingAssetChapters,
  readApprovedMarketingAssetLocation,
  readApprovedMarketingAssetMedia,
  readMarketingAssetsForConsole,
  submitMarketingAsset,
} from "@/lib/marketingAssetStore";
import type { MarketingAssetSubmission } from "@/lib/marketingAssetSubmission";
import { isAiOriginProvenance, resolveMarketingAsset } from "@/lib/marketingAssets";
import { readMarketingAssetRegistry, resolveMarketingFactsWithSnapshot } from "@/lib/marketingFactResolution";
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

test("a captured video with an AI presenter is stored, approved and published as AI-made; AI screens and presenter images are not", async () => {
  // Owner decision 2026-11-07: the product screens are captures, the only AI
  // part is the presenter. It may show the product; it is of AI origin.
  const presenter = submission({
    asset: {
      ...submission().asset,
      provenance: "capture_with_ai_presenter",
      disclosure: { youtube: "platform_label", instagram: "platform_label_and_caption" },
    },
  });
  const accepted = await postSubmission(presenter);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
  await decide("approved");

  const location = (await readApprovedMarketingAssetLocation(prisma, ID))!;
  assert.equal(location.provenance, "capture_with_ai_presenter");
  assert.equal(isAiOriginProvenance(location.provenance), true, "the publisher tells YouTube it is synthetic media");
  const registry = (await readMarketingAssetRegistry(prisma))!;
  const entry = registry.assets.find((asset) => asset.id === ID);
  assert.equal(entry?.depictsProductInterface, true, "the merged registry the Guard reads accepts the row");

  // What was submitted never changes, the provenance least of all.
  for (const provenance of ["capture", "ai_generated"]) {
    await assert.rejects(
      prisma.$executeRawUnsafe(`UPDATE "MarketingAsset" SET "provenance" = $1 WHERE "id" = $2`, provenance, ID),
      (error: unknown) => error instanceof Error && /immutable|MarketingAsset_interface_check/u.test(error.message),
    );
  }

  // The route refuses a presenter image before the database sees it.
  const image = await postSubmission(
    submission({
      asset: { ...presenter.asset, id: "media-20261107-presenter-image" },
      kind: "image",
      contentType: "image/png",
      bytes: 400_000,
      durationSeconds: null,
    }),
  );
  assert.equal(image.status, 400);
  assert.equal(image.body.code, "invalid_request");

  // And the database refuses what the store never sends.
  const insert = (id: string, kind: "image" | "video", provenance: string, disclosure: string, depicts: boolean) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingAsset" ("id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds",
         "validUntil", "depictsProductInterface", "r2Key", "contentType", "bytes", "sha256", "durationSeconds",
         "transcript", "status", "updatedAt")
       VALUES ($1, $2, $3, ARRAY['youtube'], $4::jsonb, '{"en":"A screen."}', ARRAY[]::TEXT[],
         '2099-01-01', $5, 'marketing-assets/' || $1 || CASE $2 WHEN 'image' THEN '/original.png' ELSE '/original.mp4' END,
         CASE $2 WHEN 'image' THEN 'image/png' ELSE 'video/mp4' END, 10, $6,
         CASE $2 WHEN 'image' THEN NULL ELSE 5 END,
         CASE $2 WHEN 'image' THEN '{}'::jsonb ELSE '{"en":"Hello."}'::jsonb END, 'submitted', now())`,
      id,
      kind,
      provenance,
      JSON.stringify({ youtube: disclosure }),
      depicts,
      SHA,
    );
  await assert.rejects(
    insert("media-presenter-image", "image", "capture_with_ai_presenter", "platform_label", false),
    refusedBy("MarketingAsset_presenter_check"),
  );
  await assert.rejects(
    insert("media-presenter-undisclosed", "video", "capture_with_ai_presenter", "none", true),
    refusedBy("MarketingAsset_disclosure_check"),
  );
  for (const provenance of ["ai_generated", "ai_modified"]) {
    await assert.rejects(
      insert(`media-${provenance.replace("_", "-")}-ui`, "video", provenance, "platform_label", true),
      refusedBy("MarketingAsset_interface_check"),
    );
  }
  // The same video disclosed is stored, as the route stored the first.
  await insert("media-presenter-direct", "video", "capture_with_ai_presenter", "platform_label", true);
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

test("a post may carry an asset only by declaring the asset's claims, which are then judged as the post's", async () => {
  // Stored and approved directly (the route's Guard would refuse an unknown
  // claim at submission): what matters here is the post's later judgement.
  await tx((client) => submitMarketingAsset(client, submission({ asset: { ...submission().asset, claimIds: ["no.such.claim"] } })));
  await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
  await decide("approved");

  const factsFor = (claimIds: string[]) =>
    tx(async (client) =>
      (
        await resolveMarketingFactsWithSnapshot(client, {
          claimIds,
          assetIds: [ID],
          channelId: "channel-1",
          channel: "youtube",
          locale: "en",
        })
      ).facts,
    );
  const undeclared = await factsFor([]);
  assert.deepEqual(
    undeclared.assets.map((asset) => [asset.assetId, asset.known]),
    [[ID, false]],
    "a post that does not declare the asset's claim cannot carry it",
  );
  const declared = await factsFor(["no.such.claim"]);
  assert.deepEqual(declared.assets.map((asset) => [asset.assetId, asset.known]), [[ID, true]]);
  // And the claim itself is judged with the post's: here, unknown.
  assert.deepEqual(declared.claims.map((claim) => [claim.claimId, claim.known]), [["no.such.claim", false]]);
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

test("a submission and a person's retirement at once both finish: the submission waits for the audit chain first", async () => {
  // An approved asset the retirement will move, and which the submission's
  // Guard reads FOR SHARE through the registry.
  await submitAndUpload();
  await decide("approved");
  const expected = (await row()).decisionAuditLogId;

  let releaseRetirement!: () => void;
  const retirementMayWrite = new Promise<void>((resolve) => {
    releaseRetirement = resolve;
  });
  let retirementHoldsChain!: () => void;
  const chainHeld = new Promise<void>((resolve) => {
    retirementHoldsChain = resolve;
  });
  // The person's retirement: the audit row (which takes the chain lock), then,
  // once the submission is under way, the asset row's update.
  const retirement = tx(async (client) => {
    const auditLogId = await humanAudit(client, "retired", { previous: expected });
    retirementHoldsChain();
    await retirementMayWrite;
    return decideMarketingAsset(client, { assetId: ID, decision: "retired", expectedDecisionAuditLogId: expected, auditLogId });
  });
  await chainHeld;
  const other = submission({ asset: { ...submission().asset, id: "media-20261031-second" } });
  const submitted = postSubmission(other);
  // Give the submission time to reach its first lock before the retirement writes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseRetirement();

  const [retired, answer] = await Promise.all([retirement, submitted]);
  assert.equal(retired.status, "retired");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal((await row("media-20261031-second")).status, "submitted");
});

// A long video's YouTube chapters (owner decision 2026-11-07).
const CHAPTERS = [
  { startSeconds: 0, title: { en: "What you will build", ko: "만들 것" } },
  { startSeconds: 42, title: { en: "Ask three models", ko: "세 모델에 묻기" } },
  { startSeconds: 128, title: { en: "Compare the answers", ko: "답 비교하기" } },
];
const tutorial = (chapters: unknown = CHAPTERS) =>
  submission({ durationSeconds: 300, chapters: chapters as MarketingAssetSubmission["chapters"] });

test("a video's chapters are stored with it, read back on a resend, listed for a person and reach the intake only once approved", async () => {
  const first = await postSubmission(tutorial());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // The same submission again is the same row; other chapters under the id are another file.
  assert.equal((await postSubmission(tutorial())).status, 200);
  const moved = await postSubmission(tutorial([CHAPTERS[0], { ...CHAPTERS[1], startSeconds: 50 }, CHAPTERS[2]]));
  assert.equal(moved.status, 409);
  assert.equal(moved.body.code, "asset_id_taken");

  const listed = await readMarketingAssetsForConsole(prisma, 10);
  assert.deepEqual(listed.rows[0].chapters, CHAPTERS);
  assert.equal((await readApprovedMarketingAssetChapters(prisma, [ID])).size, 0, "a submission is trusted for nothing");

  await tx((client) => confirmMarketingAssetUpload(client, { assetId: ID, bytes: 12_000_000 }));
  await decide("approved");
  assert.deepEqual((await readApprovedMarketingAssetChapters(prisma, [ID, "media-other"])).get(ID), CHAPTERS);
  const media = await readApprovedMarketingAssetMedia(prisma);
  assert.equal(media.kinds.get(ID), "video");
  assert.equal(media.longForm.has(ID), true);

  // Chapters are part of the submission: they never change, approved or not.
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingAsset" SET "chapters" = NULL WHERE "id" = $1`, ID),
    refusedBy("marketing_asset_submission_is_immutable"),
  );
});

test("a short without chapters is not long-form, and a video without chapters reads none", async () => {
  await submitAndUpload();
  await decide("approved");
  const media = await readApprovedMarketingAssetMedia(prisma);
  assert.equal(media.longForm.has(ID), false, "45 seconds and no chapters is a Short");
  assert.equal((await readApprovedMarketingAssetChapters(prisma, [ID])).size, 0);
});

test("the Guard reads chapter titles with the transcript: a title it rejects writes nothing", async () => {
  const rejected = await postSubmission(
    // Our bare host passes (owner 2026-11-08); a path makes it a destination, which the Guard refuses.
    tutorial([CHAPTERS[0], { ...CHAPTERS[1], title: { ...CHAPTERS[1].title, en: "Try it at tomverse.app/pricing" } }, CHAPTERS[2]]),
  );
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.code, "transcript_guard_rejected");
  assert.ok((rejected.body.guardCodes as string[]).includes("hygiene"), JSON.stringify(rejected.body));
  assert.equal(await assetCount(), 0);
});

test("the database refuses chapters YouTube would not show, on an image, or without a title per alt locale", async () => {
  const insert = (id: string, kind: "video" | "image", chapters: unknown, durationSeconds: number | null = 300) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingAsset" ("id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds",
         "validUntil", "depictsProductInterface", "r2Key", "contentType", "bytes", "sha256", "durationSeconds",
         "transcript", "chapters", "status", "updatedAt")
       VALUES ($1, $2, 'capture', ARRAY['youtube'], '{"youtube":"none"}', '{"en":"A screen.","ko":"화면."}', ARRAY[]::TEXT[],
         '2099-01-01', true, 'marketing-assets/' || $1 || CASE WHEN $2 = 'video' THEN '/original.mp4' ELSE '/original.png' END,
         CASE WHEN $2 = 'video' THEN 'video/mp4' ELSE 'image/png' END, 10, $3, $4::INTEGER,
         '{"en":"Words."}'::jsonb, $5::jsonb, 'submitted', now())`,
      id,
      kind,
      SHA,
      durationSeconds,
      JSON.stringify(chapters),
    );
  const check = refusedBy("MarketingAsset_chapters_check");
  // The store's own shape passes, at YouTube's exact boundaries.
  await insert("media-ok", "video", [CHAPTERS[0], { ...CHAPTERS[1], startSeconds: 10 }, { ...CHAPTERS[2], startSeconds: 20 }], 30);
  // The first not at 0; a nine-second section; the last nine seconds from the end; a start past the end.
  await assert.rejects(insert("media-first", "video", [{ ...CHAPTERS[0], startSeconds: 1 }, ...CHAPTERS.slice(1)]), check);
  await assert.rejects(insert("media-gap", "video", [CHAPTERS[0], { ...CHAPTERS[1], startSeconds: 9 }, CHAPTERS[2]]), check);
  await assert.rejects(insert("media-tail", "video", CHAPTERS, 137), check);
  await assert.rejects(insert("media-past", "video", CHAPTERS, 100), check);
  await assert.rejects(insert("media-order", "video", [CHAPTERS[0], CHAPTERS[2], CHAPTERS[1]]), check);
  // Fewer than three; not whole seconds; an extra field.
  await assert.rejects(insert("media-two", "video", CHAPTERS.slice(0, 2)), check);
  await assert.rejects(insert("media-half", "video", [CHAPTERS[0], { ...CHAPTERS[1], startSeconds: 42.5 }, CHAPTERS[2]]), check);
  await assert.rejects(insert("media-extra", "video", [{ ...CHAPTERS[0], endSeconds: 42 }, ...CHAPTERS.slice(1)]), check);
  // A title missing for an alt locale, in an unknown locale, too long, or with a line break.
  await assert.rejects(insert("media-noko", "video", [{ ...CHAPTERS[0], title: { en: "Intro" } }, ...CHAPTERS.slice(1)]), check);
  await assert.rejects(
    insert("media-fr", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, fr: "Intro" } }, ...CHAPTERS.slice(1)]),
    check,
  );
  await assert.rejects(
    insert("media-longtitle", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: "a".repeat(61) } }, ...CHAPTERS.slice(1)]),
    check,
  );
  await assert.rejects(
    insert("media-newline", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: "Intro\n00:05 Fake" } }, ...CHAPTERS.slice(1)]),
    check,
  );
  await assert.rejects(
    insert("media-hashtag", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: "Intro #Shorts" } }, ...CHAPTERS.slice(1)]),
    check,
  );
  // A line separator, a blank title, and one with something to trim.
  await assert.rejects(
    insert("media-separator", "video", [
      { ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: `Intro${String.fromCharCode(0x2028)}00:05 Fake` } },
      ...CHAPTERS.slice(1),
    ]),
    check,
  );
  await assert.rejects(insert("media-blank", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: "   " } }, ...CHAPTERS.slice(1)]), check);
  await assert.rejects(insert("media-padded", "video", [{ ...CHAPTERS[0], title: { ...CHAPTERS[0].title, en: " Intro" } }, ...CHAPTERS.slice(1)]), check);
  // Not a list at all, and chapters on an image (no length, so the function alone would answer NULL).
  await assert.rejects(insert("media-object", "video", { startSeconds: 0 }), check);
  await assert.rejects(insert("media-image", "image", CHAPTERS, null), check);
});
