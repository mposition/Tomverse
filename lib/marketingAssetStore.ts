/**
 * The media asset store's one writer (operator decision 2026-10-31).
 * `npm run check:protected-table-writers` refuses a write to `MarketingAsset`
 * anywhere else.
 *
 * Two kinds of writer, and the database tells them apart:
 * - the media CLI submits a file and confirms its upload, under the
 *   `marketing-generator` system actor -- a submission is shown to a person and
 *   trusted for nothing;
 * - a person approves or retires it inside `runMarketingAdminMutation`, whose
 *   human audit row the write guard checks: the action, the row, the previous
 *   decision it was made against and, for an approval, the exact bytes.
 *
 * Only approved rows reach the registry the Guard and the generator read
 * (`readApprovedMarketingAssetRows`) and the publisher's object lookup
 * (`readApprovedMarketingAssetLocation`).
 *
 * Raw SQL rather than the generated delegate: the table's rules live in the
 * database, and these statements say exactly which columns each step may move.
 */

import "server-only";

import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_ASSET_ACTIONS,
  MarketingAssetRefusedError,
  marketingAssetR2Key,
  type MarketingAssetKind,
  type MarketingAssetStatus,
} from "@/lib/marketingAssetCore";
import type { MarketingAssetSubmission } from "@/lib/marketingAssetSubmission";
import type { MarketingAsset } from "@/lib/marketingAssets";
import type { MarketingTransaction } from "@/lib/marketingStore";

type AssetReader = Pick<Prisma.TransactionClient, "$queryRaw">;

type AssetRow = {
  id: string;
  kind: MarketingAssetKind;
  provenance: MarketingAsset["provenance"];
  allowedChannels: string[];
  disclosure: Record<string, string>;
  alt: Record<string, string>;
  claimIds: string[];
  validUntil: string;
  depictsProductInterface: boolean;
  r2Key: string;
  contentType: string;
  bytes: number;
  sha256: string;
  durationSeconds: number | null;
  status: MarketingAssetStatus;
  uploadedAt: Date | null;
  registryVersion: number | null;
  decisionAuditLogId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

const ROW_COLUMNS = Prisma.sql`
  "id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds",
  to_char("validUntil", 'YYYY-MM-DD') AS "validUntil", "depictsProductInterface",
  "r2Key", "contentType", "bytes", "sha256", "durationSeconds", "status", "uploadedAt",
  "registryVersion", "decisionAuditLogId", "decidedAt", "createdAt"`;

/** A row as the registry entry it stands for. */
const registryEntry = (row: AssetRow): MarketingAsset =>
  ({
    id: row.id,
    provenance: row.provenance,
    allowedChannels: [...row.allowedChannels],
    alt: { ...row.alt },
    claimIds: [...row.claimIds],
    validUntil: row.validUntil,
    disclosure: { ...row.disclosure },
    depictsProductInterface: row.depictsProductInterface,
  }) as MarketingAsset;

/** A value with object keys sorted, so jsonb (which reorders keys) compares equal to what was sent. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;

const sameSubmission = (row: AssetRow, submission: MarketingAssetSubmission, r2Key: string): boolean =>
  JSON.stringify(canonical(registryEntry(row))) === JSON.stringify(canonical(submission.asset)) &&
  row.kind === submission.kind &&
  row.contentType === submission.contentType &&
  row.bytes === submission.bytes &&
  row.sha256 === submission.sha256 &&
  row.durationSeconds === submission.durationSeconds &&
  row.r2Key === r2Key;

const readRow = async (db: AssetReader, id: string, lock: "share" | "update" | null): Promise<AssetRow | null> => {
  const rows = await db.$queryRaw<AssetRow[]>(Prisma.sql`
    SELECT ${ROW_COLUMNS} FROM "MarketingAsset" WHERE "id" = ${id}
    ${lock === "update" ? Prisma.sql`FOR UPDATE` : lock === "share" ? Prisma.sql`FOR SHARE` : Prisma.empty}
  `);
  return rows[0] ?? null;
};

/**
 * Announce a file. The row is a submission with the object key it must be
 * uploaded to; the caller signs an upload URL for that key after this commits.
 *
 * The same submission sent again -- an answer lost on the way back -- is read
 * back, so the CLI may resend it and get a fresh URL for the same key. A
 * different file under an id already used is refused: an id names one file.
 * A row already uploaded is not reopened.
 */
export async function submitMarketingAsset(
  tx: MarketingTransaction,
  submission: MarketingAssetSubmission,
): Promise<{ readonly assetId: string; readonly r2Key: string; readonly existing: boolean }> {
  await takeAuditChainLock(tx);
  const r2Key = marketingAssetR2Key(submission.asset.id, submission.kind, submission.contentType);
  const existing = await readRow(tx, submission.asset.id, "update");
  if (existing) {
    if (!sameSubmission(existing, submission, r2Key)) {
      throw new MarketingAssetRefusedError("asset_id_taken", 409, "That asset id already names a different file");
    }
    if (existing.status !== "submitted" || existing.uploadedAt !== null) {
      throw new MarketingAssetRefusedError("asset_already_uploaded", 409, "That asset is already uploaded");
    }
    return { assetId: existing.id, r2Key, existing: true };
  }
  const asset = submission.asset;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "MarketingAsset" (
      "id", "kind", "provenance", "allowedChannels", "disclosure", "alt", "claimIds", "validUntil",
      "depictsProductInterface", "r2Key", "contentType", "bytes", "sha256", "durationSeconds",
      "status", "updatedAt")
    VALUES (
      ${asset.id}, ${submission.kind}, ${asset.provenance}, ${[...asset.allowedChannels]}::TEXT[],
      ${JSON.stringify(asset.disclosure)}::jsonb, ${JSON.stringify(asset.alt)}::jsonb,
      ${[...asset.claimIds]}::TEXT[], ${asset.validUntil}::date, ${asset.depictsProductInterface},
      ${r2Key}, ${submission.contentType}, ${submission.bytes}, ${submission.sha256},
      ${submission.durationSeconds}, 'submitted', (clock_timestamp() AT TIME ZONE 'UTC'))
  `);
  await writeSystemAuditLog({
    tx,
    systemActor: "marketing-generator",
    action: MARKETING_ASSET_ACTIONS.submitted,
    targetType: "MarketingAsset",
    targetId: asset.id,
    summary: "The media agent submitted an image or video for a person to review.",
    metadata: {
      kind: submission.kind,
      provenance: asset.provenance,
      bytes: submission.bytes,
      sha256: submission.sha256,
    },
  });
  return { assetId: asset.id, r2Key, existing: false };
}

/** Where a submission's file must be, and what it must measure, to be confirmed. */
export async function readMarketingAssetUploadTarget(
  db: AssetReader,
  id: string,
): Promise<{ readonly r2Key: string; readonly kind: MarketingAssetKind; readonly contentType: string; readonly bytes: number; readonly uploaded: boolean } | null> {
  const row = await readRow(db, id, null);
  if (!row || row.status !== "submitted") return null;
  return { r2Key: row.r2Key, kind: row.kind, contentType: row.contentType, bytes: row.bytes, uploaded: row.uploadedAt !== null };
}

/**
 * Record that the file is in R2. The caller measured the object against the
 * declared type and size first; this writes the time, once. A second
 * confirmation of the same upload answers as the first did.
 */
export async function confirmMarketingAssetUpload(
  tx: MarketingTransaction,
  input: { readonly assetId: string; readonly bytes: number },
): Promise<{ readonly assetId: string; readonly uploadedAt: string }> {
  const row = await readRow(tx, input.assetId, "update");
  if (!row || row.status !== "submitted") {
    throw new MarketingAssetRefusedError("asset_not_submitted", 409, "No submission waits for that upload");
  }
  if (row.bytes !== input.bytes) {
    throw new MarketingAssetRefusedError("asset_size_mismatch", 422, "The uploaded file is not the size announced");
  }
  if (row.uploadedAt !== null) return { assetId: row.id, uploadedAt: row.uploadedAt.toISOString() };
  const updated = await tx.$queryRaw<Array<{ uploadedAt: Date }>>(Prisma.sql`
    UPDATE "MarketingAsset"
       SET "uploadedAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
     WHERE "id" = ${input.assetId} AND "status" = 'submitted' AND "uploadedAt" IS NULL
     RETURNING "uploadedAt"
  `);
  if (!updated[0]) {
    throw new MarketingAssetRefusedError("asset_not_submitted", 409, "No submission waits for that upload");
  }
  return { assetId: input.assetId, uploadedAt: updated[0].uploadedAt.toISOString() };
}

/**
 * A person's decision about an asset, recorded by the audit row the mutation
 * wrapper has just written (`auditLogId`). The row moves only if its current
 * decision is the one the person saw, and an approval only for the bytes the
 * person saw (`sha256`, which the audit row records and the guard compares).
 */
export async function decideMarketingAsset(
  tx: MarketingTransaction,
  input: {
    readonly assetId: string;
    readonly decision: "approved" | "retired";
    readonly expectedDecisionAuditLogId: string | null;
    readonly auditLogId: string;
  },
): Promise<{ readonly assetId: string; readonly status: string; readonly registryVersion: number }> {
  let updated: Array<{ registryVersion: number }>;
  try {
    updated = await tx.$queryRaw<Array<{ registryVersion: number }>>(Prisma.sql`
      UPDATE "MarketingAsset"
         SET "status" = ${input.decision}, "decisionAuditLogId" = ${input.auditLogId},
             "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE "id" = ${input.assetId}
         AND "decisionAuditLogId" IS NOT DISTINCT FROM ${input.expectedDecisionAuditLogId}
       RETURNING "registryVersion"
    `);
  } catch (error) {
    // The write guard's answer. The transaction is already aborted; this only
    // names the refusal.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("marketing_asset_transition_invalid")) {
      throw new MarketingAssetRefusedError("asset_transition_invalid", 409, "That decision does not apply to the asset's current status");
    }
    if (message.includes("marketing_asset_not_uploaded")) {
      throw new MarketingAssetRefusedError("asset_not_uploaded", 409, "The file has not been uploaded yet");
    }
    throw error;
  }
  if (!updated[0]) {
    throw new MarketingAssetRefusedError("asset_decision_conflict", 409, "The asset changed, or does not exist, since it was shown");
  }
  return { assetId: input.assetId, status: input.decision, registryVersion: updated[0].registryVersion };
}

/**
 * The approved assets as registry entries, held FOR SHARE until the caller's
 * transaction ends (a retirement waits for a Guard decision read against the
 * asset to commit), and the registry version: the highest any approval or
 * retirement has taken, 0 when none has.
 */
export async function readApprovedMarketingAssetRows(
  db: AssetReader,
): Promise<{ readonly assets: readonly MarketingAsset[]; readonly version: number }> {
  const rows = await db.$queryRaw<AssetRow[]>(Prisma.sql`
    SELECT ${ROW_COLUMNS} FROM "MarketingAsset" WHERE "status" = 'approved' ORDER BY "id" FOR SHARE
  `);
  const version = await db.$queryRaw<Array<{ version: number | null }>>(Prisma.sql`
    SELECT max("registryVersion")::INTEGER AS "version" FROM "MarketingAsset"
  `);
  return { assets: rows.map(registryEntry), version: version[0]?.version ?? 0 };
}

/**
 * Where an approved asset's file is, for the publisher to hand the platform a
 * URL. Null for an asset that is not approved now: a retired one is not
 * published, whatever a post says.
 */
export async function readApprovedMarketingAssetLocation(
  db: AssetReader,
  id: string,
): Promise<{ readonly r2Key: string; readonly kind: MarketingAssetKind; readonly contentType: string; readonly bytes: number; readonly provenance: MarketingAsset["provenance"] } | null> {
  const row = await readRow(db, id, null);
  if (!row || row.status !== "approved") return null;
  return { r2Key: row.r2Key, kind: row.kind, contentType: row.contentType, bytes: row.bytes, provenance: row.provenance };
}

/** The rows the Admin console lists: submissions first, then approved, then retired. */
export async function readMarketingAssetsForConsole(db: AssetReader, limit: number) {
  const rows = await db.$queryRaw<AssetRow[]>(Prisma.sql`
    SELECT ${ROW_COLUMNS} FROM "MarketingAsset"
     ORDER BY CASE "status" WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, "createdAt" DESC
     LIMIT ${limit + 1}
  `);
  return {
    truncated: rows.length > limit,
    rows: rows.slice(0, limit).map((row) => ({
      ...row,
      uploadedAt: row.uploadedAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** The object a person previews in Admin: any asset whose file was uploaded. */
export async function readMarketingAssetPreviewKey(db: AssetReader, id: string): Promise<string | null> {
  const row = await readRow(db, id, null);
  return row && row.uploadedAt !== null ? row.r2Key : null;
}
