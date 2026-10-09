// Read-only activation evidence. No model calls, key writes/deletes, audit
// writes or switches. Output is limited to configuration booleans and counts.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { loadCurrentAmuxContentKeys } from "../lib/amux/ideaKeyConfig.ts";

export const CONTENT_COLUMNS = Object.freeze([
  ["AmuxIdeaSubmission", "rawCiphertext", "rawKeyId"],
  ["AmuxIdeaSourceScopeApproval", "scopeCiphertext", "scopeKeyId"],
  ["AmuxIdeaTransferPreview", "payloadCiphertext", "payloadKeyId"],
  ["AmuxIdeaAnalysisChunk", "draftCiphertext", "draftKeyId"],
  ["AmuxIdeaAnalysisChunk", "freeformCiphertext", "freeformKeyId"],
  ["AmuxIdeaDraftUnit", "bodyCiphertext", "bodyKeyId"],
  ["AmuxPortfolioNode", "titleCiphertext", "contentKeyId"],
  ["AmuxPortfolioNode", "descriptionCiphertext", "contentKeyId"],
  ["AmuxWorkItem", "v4TitleCiphertext", "v4TitleKeyId"],
  ["AmuxWorkItem", "v4BodyCiphertext", "v4BodyKeyId"],
  ["AmuxWorkItem", "v4BriefCiphertext", "v4BriefKeyId"],
  ["AmuxV22TaskResult", "ciphertext", "keyId"],
  ["AmuxV22TaskPatch", "ciphertext", "keyId"],
].map(Object.freeze));

// Identifiers come only from the fixed source allowlist, never CLI input.
export const LEGACY_KEY_COUNTS_SQL = CONTENT_COLUMNS.map(([table, body, key], i) =>
  `SELECT ${i}::int AS ordinal, count(*)::text AS bodies,
    count(*) FILTER (WHERE "${key}" IS NULL OR
      "${key}" !~ '^amux2-[A-Za-z0-9_-]{43}$')::text AS legacy
    FROM public."${table}" WHERE "${body}" IS NOT NULL`
).join("\nUNION ALL\n") + "\nORDER BY ordinal";

export function summarizeCounts(rows) {
  if (!Array.isArray(rows) || rows.length !== CONTENT_COLUMNS.length) return null;
  let encryptedBodies = 0;
  let legacyOrInvalidKeyBodies = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.ordinal !== i || !/^(0|[1-9][0-9]*)$/.test(row.bodies) ||
        !/^(0|[1-9][0-9]*)$/.test(row.legacy)) return null;
    const bodies = Number(row.bodies);
    const legacy = Number(row.legacy);
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(legacy) ||
        legacy > bodies) return null;
    encryptedBodies += bodies;
    legacyOrInvalidKeyBodies += legacy;
    if (!Number.isSafeInteger(encryptedBodies) ||
        !Number.isSafeInteger(legacyOrInvalidKeyBodies)) return null;
  }
  return { encryptedBodies, legacyOrInvalidKeyBodies };
}

export async function readLegacyKeyCounts(env) {
  const connectionString = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("database_unavailable");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
    query_timeout: 15000, application_name: "amux_v4_read_only_preflight" });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    const { rows } = await client.query(LEGACY_KEY_COUNTS_SQL);
    await client.query("COMMIT");
    return rows;
  } finally {
    // Disconnect also rolls back an interrupted read-only transaction.
    await client.end().catch(() => {});
  }
}

export function completeVersionListing(response) {
  if (response?.IsTruncated !== false || response.NextKeyMarker ||
      response.NextVersionIdMarker) return false;
  return [response.Versions, response.DeleteMarkers].every(entries =>
    entries === undefined || (Array.isArray(entries) && entries.length === 0));
}

export async function probeVersionListing(env) {
  const bucket = env.AMUX_V4_KEY_STORE_BUCKET;
  const endpoint = env.AMUX_V4_KEY_STORE_ENDPOINT;
  const region = env.AMUX_V4_KEY_STORE_REGION;
  const accessKeyId = env.AMUX_V4_KEY_STORE_ACCESS_KEY_ID;
  const secretAccessKey = env.AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey ||
      !endpoint || !/^https:\/\/[^/?#]+\/?$/.test(endpoint)) {
    throw new Error("key_store_unavailable");
  }
  const client = new S3Client({ endpoint, region,
    forcePathStyle: env.AMUX_V4_KEY_STORE_URL_STYLE === "path",
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
  try {
    // An unused namespace, not a real content-key prefix. A successful empty
    // listing proves API availability only, not deletion of any existing key.
    return await client.send(new ListObjectVersionsCommand({ Bucket: bucket,
      Prefix: `amux/v4/activation-probe/${randomUUID()}`, MaxKeys: 1 }),
    { abortSignal: AbortSignal.timeout(10000) });
  } finally { client.destroy(); }
}

export async function activationPreflight({ env = process.env,
  readCounts = readLegacyKeyCounts, listVersions = probeVersionListing } = {}) {
  let appContentKeysConfigured = false;
  try { loadCurrentAmuxContentKeys(env); appContentKeysConfigured = true; }
  catch { /* Never expose configuration values or underlying errors. */ }
  let counts = null;
  try { counts = summarizeCounts(await readCounts(env)); } catch { /* Redact. */ }
  let keyStoreVersionListingAvailable = false;
  try { keyStoreVersionListingAvailable = completeVersionListing(await listVersions(env)); }
  catch { /* Redact endpoint, object and credentials. */ }
  return {
    readOnly: true,
    appContentKeysConfigured,
    databaseCountsAvailable: counts !== null,
    checkedContentColumns: CONTENT_COLUMNS.length,
    encryptedBodies: counts?.encryptedBodies ?? null,
    legacyOrInvalidKeyBodies: counts?.legacyOrInvalidKeyBodies ?? null,
    keyStoreVersionListingAvailable,
    // A separate bounded create/delete/restore-canary verification is required.
    cryptographicDeletionVerified: false,
    runtimeActivated: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await activationPreflight();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.appContentKeysConfigured || !report.databaseCountsAvailable ||
      report.legacyOrInvalidKeyBodies !== 0 || !report.keyStoreVersionListingAvailable) {
    process.exitCode = 2;
  }
}
