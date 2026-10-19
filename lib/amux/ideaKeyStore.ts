import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetBucketVersioningCommand, GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { amuxContentKeyCoordinate, type AmuxContentKeys,
  type AmuxContentPurpose, type AmuxMasterKey } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SUBJECT_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const PURPOSES: ReadonlySet<string> = new Set<AmuxContentPurpose>([
  "idea_raw", "repository_read_manifest", "source_scope", "collection_result", "transfer_payload", "analysis_result",
  "analysis_draft", "analysis_freeform", "derivation_confirmation", "derivation_reason", "node_content", "card_title", "card_body", "card_brief", "task_result", "task_patch",
]);
const BUCKET = /^[a-z0-9][a-z0-9.-]{2,126}$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const MAGIC = Buffer.from("AMK2", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const STORED_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES + KEY_BYTES;
// This fixed, non-secret body occupies a retired intake key's object
// coordinate so an earlier conditional PutObject cannot recreate key material.
const RETIRED_INTAKE_KEY = Buffer.from("AMUX-READ-MANIFEST-KEY-RETIRED-v1", "ascii");
const retiresOrphanKey = (purpose: AmuxContentPurpose) =>
  purpose === "repository_read_manifest" || purpose === "analysis_result";

export type AmuxContentKeyIdentity = {
  ideaId: string;
  purpose: AmuxContentPurpose;
  subjectId: string;
};

export class AmuxIdeaKeyStoreError extends Error {
  constructor(readonly code: "unavailable" | "missing" | "conflict" |
    "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "AmuxIdeaKeyStoreError";
  }
}

/** Each encrypted row gets a separate external key. A draft's subject is its
 * UUID, so deleting its key does not affect any other draft or the raw idea. */
function identity(input: AmuxContentKeyIdentity) {
  if (!input || !IDEA_ID.test(input.ideaId) ||
      !PURPOSES.has(input.purpose) || !SUBJECT_ID.test(input.subjectId)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const context = Buffer.from(`amux-v4-content-key\0${input.ideaId}\0${input.purpose}\0${input.subjectId}`, "utf8");
  const digest = createHash("sha256").update(context).digest("base64url");
  return { context, objectKey: `amux/v4/content-key/${digest}`,
    keyId: `amux2-${digest}` };
}

export const amuxContentUnitKeyId = (input: AmuxContentKeyIdentity): string =>
  identity(input).keyId;

function connection(env: NodeJS.ProcessEnv) {
  const bucket = env.AMUX_V4_KEY_STORE_BUCKET;
  const region = env.AMUX_V4_KEY_STORE_REGION;
  const endpoint = env.AMUX_V4_KEY_STORE_ENDPOINT;
  const accessKeyId = env.AMUX_V4_KEY_STORE_ACCESS_KEY_ID;
  const secretAccessKey = env.AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY;
  const secureEndpoint = !!endpoint && /^https:\/\/[^/?#]+\/?$/.test(endpoint);
  const testLoopback = env.NODE_ENV === "test" && !!endpoint &&
    /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/.test(endpoint);
  if (!bucket || !BUCKET.test(bucket) || !region || !REGION.test(region) ||
      !endpoint || !accessKeyId || !secretAccessKey ||
      (!secureEndpoint && !testLoopback)) {
    throw new AmuxIdeaKeyStoreError("unavailable");
  }
  return { bucket, client: new S3Client({ region, endpoint,
    forcePathStyle: env.AMUX_V4_KEY_STORE_URL_STYLE === "path",
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 }) };
}

export function sealAmuxContentUnitKey(input: AmuxContentKeyIdentity,
  key: Buffer, wrappingKey: Buffer): Buffer {
  const { context } = identity(input);
  if (key.length !== KEY_BYTES || wrappingKey.length !== KEY_BYTES) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(context);
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function openAmuxContentUnitKey(input: AmuxContentKeyIdentity,
  bytes: Buffer, wrappingKey: Buffer): Buffer {
  const { context } = identity(input);
  if (wrappingKey.length !== KEY_BYTES || bytes.length !== STORED_BYTES ||
      !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = bytes.subarray(MAGIC.length + IV_BYTES,
    MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
  decipher.setAAD(context);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + IV_BYTES +
      TAG_BYTES)), decipher.final()]);
  } catch { throw new AmuxIdeaKeyStoreError("integrity_unavailable"); }
}

function scopedKeys(input: AmuxContentKeyIdentity, key: Buffer,
  global: AmuxContentKeys): AmuxContentKeys {
  if (key.length !== KEY_BYTES) throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  return { masterKeyId: identity(input).keyId, masterKeyVersion: 1,
    masterKey: key, digestKeyId: global.digestKeyId, digestKey: global.digestKey };
}

/** Assemble already-loaded unit keys before entering a DB transaction. */
export function amuxContentKeyRing(global: AmuxContentKeys,
  units: readonly { identity: AmuxContentKeyIdentity; keys: AmuxContentKeys }[]):
  AmuxContentKeys {
  const contentMasters = new Map<string, AmuxMasterKey>();
  for (const unit of units) {
    identity(unit.identity);
    if (unit.keys.digestKeyId !== global.digestKeyId ||
        !unit.keys.digestKey.equals(global.digestKey) ||
        unit.keys.masterKeyId !== identity(unit.identity).keyId ||
        unit.keys.masterKeyVersion !== 1) {
      throw new AmuxIdeaKeyStoreError("integrity_unavailable");
    }
    const coordinate = amuxContentKeyCoordinate(unit.identity.purpose,
      unit.identity.subjectId);
    if (contentMasters.has(coordinate)) {
      throw new AmuxIdeaKeyStoreError("conflict");
    }
    contentMasters.set(coordinate, unit.keys);
  }
  return { ...global, contentMasters };
}

export async function loadAmuxContentKeyRing(
  identities: readonly AmuxContentKeyIdentity[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<AmuxContentKeys> {
  const global = loadCurrentAmuxContentKeys(env);
  const units = await Promise.all(identities.map(async (item) => ({
    identity: item, keys: await loadAmuxContentUnitKeys(item, env),
  })));
  return amuxContentKeyRing(global, units);
}

export async function createAmuxContentKeyRing(
  existing: readonly AmuxContentKeyIdentity[],
  created: readonly AmuxContentKeyIdentity[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<AmuxContentKeys> {
  const global = loadCurrentAmuxContentKeys(env);
  const units = await Promise.all(existing.map(async (item) => ({
    identity: item, keys: await loadAmuxContentUnitKeys(item, env),
  })));
  // Creates are sequential so an early failure cannot write subsequent keys.
  for (const item of created) {
    units.push({ identity: item, keys: await createAmuxContentUnitKeys(item, env) });
  }
  return amuxContentKeyRing(global, units);
}

/** Create before storing the corresponding body. A failed DB transaction may
 * leave an empty orphan key; an uncertain COMMIT must be read back first. */
export async function createAmuxContentUnitKeys(input: AmuxContentKeyIdentity,
  env: NodeJS.ProcessEnv = process.env): Promise<AmuxContentKeys> {
  const { objectKey } = identity(input);
  const global = loadCurrentAmuxContentKeys(env);
  const { bucket, client } = connection(env);
  const dataKey = randomBytes(KEY_BYTES);
  const body = sealAmuxContentUnitKey(input, dataKey, global.masterKey);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey,
      Body: body, ContentType: "application/octet-stream",
      IfNoneMatch: "*", CacheControl: "no-store" }));
    return scopedKeys(input, dataKey, global);
  } catch (error) {
    dataKey.fill(0);
    if (typeof error === "object" && error !== null &&
        "$metadata" in error && (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode === 412) {
      throw new AmuxIdeaKeyStoreError("conflict");
    }
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { body.fill(0); client.destroy(); }
}

/** Missing keys fail closed, including after restoring an old DB backup. */
export async function loadAmuxContentUnitKeys(input: AmuxContentKeyIdentity,
  env: NodeJS.ProcessEnv = process.env): Promise<AmuxContentKeys> {
  const { objectKey } = identity(input);
  const global = loadCurrentAmuxContentKeys(env);
  const { bucket, client } = connection(env);
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!result.Body) throw new AmuxIdeaKeyStoreError("integrity_unavailable");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    try {
      if (bytes.length !== STORED_BYTES) throw new AmuxIdeaKeyStoreError("integrity_unavailable");
      return scopedKeys(input, openAmuxContentUnitKey(input, bytes, global.masterKey), global);
    } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    if (typeof error === "object" && error !== null &&
        "$metadata" in error && (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode === 404) {
      throw new AmuxIdeaKeyStoreError("missing");
    }
    throw new AmuxIdeaKeyStoreError("unavailable");
  } finally { client.destroy(); }
}

/** Call only after the active DB body is cleared or its write definitely rolled
 * back. An uncertain COMMIT is never grounds for deleting its key. */
export async function deleteAmuxContentUnitKey(input: AmuxContentKeyIdentity,
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { objectKey } = identity(input);
  const { bucket, client } = connection(env);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    await verifyAbsentContentKey(client, bucket, objectKey);
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { client.destroy(); }
}

/** Readback only: a claimed deletion whose audit result was lost must not
 * issue a second DeleteObject. HEAD alone is insufficient for versioned keys. */
export async function verifyAmuxContentUnitKeyAbsent(
  input: AmuxContentKeyIdentity, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { objectKey } = identity(input);
  const { bucket, client } = connection(env);
  try { await verifyAbsentContentKey(client, bucket, objectKey); }
  catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  }
  finally { client.destroy(); }
}

/** A claimed orphan has no live body. Replace its key with a non-secret fence
 * before removing old versions; a delayed IfNoneMatch create then conflicts. */
export async function retireClaimedAmuxReadManifestKey(
  input: AmuxContentKeyIdentity, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!retiresOrphanKey(input.purpose)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const { objectKey } = identity(input);
  const { bucket, client } = connection(env);
  const abortSignal = AbortSignal.timeout(30_000);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey,
      Body: RETIRED_INTAKE_KEY,
      ContentType: "application/octet-stream", CacheControl: "no-store" }),
    { abortSignal });
    await finishClaimedReadManifestRetirement(client, bucket, objectKey,
      isCloudflareR2(env), abortSignal);
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { client.destroy(); }
}

/** Readback after an uncertain write; this function never writes. */
export async function verifyAmuxReadManifestKeyRetired(
  input: AmuxContentKeyIdentity, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!retiresOrphanKey(input.purpose)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const { objectKey } = identity(input);
  const { bucket, client } = connection(env);
  try {
    await verifyRetiredReadManifestKey(client, bucket, objectKey,
      isCloudflareR2(env), AbortSignal.timeout(30_000));
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { client.destroy(); }
}

/** Reconcile a claimed intent, including claims left by the old delete flow.
 * A confirmed missing or old key may be replaced with the fixed non-secret
 * fence; an unavailable read must stop rather than guess. */
export async function finishClaimedAmuxReadManifestKeyRetirement(
  input: AmuxContentKeyIdentity, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!retiresOrphanKey(input.purpose)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const { objectKey } = identity(input);
  const { bucket, client } = connection(env);
  const abortSignal = AbortSignal.timeout(30_000);
  try {
    if (await inspectRetiredFence(client, bucket, objectKey,
      abortSignal) === "needs_fence") {
      await client.send(new PutObjectCommand({ Bucket: bucket,
        Key: objectKey, Body: RETIRED_INTAKE_KEY,
        ContentType: "application/octet-stream", CacheControl: "no-store" }),
      { abortSignal });
    }
    await finishClaimedReadManifestRetirement(client, bucket, objectKey,
      isCloudflareR2(env), abortSignal);
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { client.destroy(); }
}

/** The same conditional-create fence protects an orphan Max result key. */
export const retireClaimedAmuxSessionResultKey =
  retireClaimedAmuxReadManifestKey;
export const verifyAmuxSessionResultKeyRetired =
  verifyAmuxReadManifestKeyRetired;
export const finishClaimedAmuxSessionResultKeyRetirement =
  finishClaimedAmuxReadManifestKeyRetirement;

function isCloudflareR2(env: NodeJS.ProcessEnv): boolean {
  try {
    return new URL(env.AMUX_V4_KEY_STORE_ENDPOINT ?? "").hostname
      .endsWith(".r2.cloudflarestorage.com");
  } catch { return false; }
}

async function inspectRetiredFence(client: S3Client, bucket: string,
  objectKey: string, abortSignal: AbortSignal):
  Promise<"retired" | "needs_fence"> {
  let result;
  try {
    result = await client.send(new GetObjectCommand({ Bucket: bucket,
      Key: objectKey }), { abortSignal });
  } catch (error) {
    if (typeof error === "object" && error !== null &&
        "$metadata" in error && (error as {
          $metadata?: { httpStatusCode?: number }
        }).$metadata?.httpStatusCode === 404) return "needs_fence";
    throw error;
  }
  if (!result.Body) throw new AmuxIdeaKeyStoreError("outcome_unknown");
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  try {
    return bytes.equals(RETIRED_INTAKE_KEY) ?
      "retired" : "needs_fence";
  } finally { bytes.fill(0); }
}

async function readRetiredFence(client: S3Client, bucket: string,
  objectKey: string, abortSignal: AbortSignal): Promise<void> {
  if (await inspectRetiredFence(client, bucket, objectKey,
    abortSignal) !== "retired") {
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  }
}

async function readVersioning(client: S3Client, bucket: string,
  r2: boolean, abortSignal: AbortSignal): Promise<"none" | "versioned"> {
  if (r2) return "none"; // R2 does not implement GetBucketVersioning.
  const versioning = await client.send(new GetBucketVersioningCommand({
    Bucket: bucket }), { abortSignal });
  if (versioning.Status === undefined) return "none";
  if (versioning.Status === "Enabled" || versioning.Status === "Suspended") {
    return "versioned";
  }
  throw new AmuxIdeaKeyStoreError("outcome_unknown");
}

async function listedReadManifestVersions(client: S3Client, bucket: string,
  objectKey: string, abortSignal: AbortSignal) {
  const listed = await client.send(new ListObjectVersionsCommand({
    Bucket: bucket, Prefix: objectKey, MaxKeys: 1000,
  }), { abortSignal });
  if (listed.IsTruncated !== false || listed.NextKeyMarker ||
      listed.NextVersionIdMarker) throw new AmuxIdeaKeyStoreError("outcome_unknown");
  return [
    ...(listed.Versions ?? []).filter((item) => item.Key === objectKey)
      .map((item) => ({ versionId: item.VersionId,
        isLatest: item.IsLatest, deleteMarker: false })),
    ...(listed.DeleteMarkers ?? []).filter((item) => item.Key === objectKey)
      .map((item) => ({ versionId: item.VersionId,
        isLatest: item.IsLatest, deleteMarker: true })),
  ];
}

async function verifyRetiredReadManifestKey(client: S3Client, bucket: string,
  objectKey: string, r2: boolean, abortSignal: AbortSignal): Promise<void> {
  await readRetiredFence(client, bucket, objectKey, abortSignal);
  if (await readVersioning(client, bucket, r2, abortSignal) === "none") return;
  const versions = await listedReadManifestVersions(client, bucket, objectKey,
    abortSignal);
  if (versions.length !== 1 || !versions[0].isLatest ||
      !versions[0].versionId || versions[0].deleteMarker) {
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  }
}

async function finishClaimedReadManifestRetirement(client: S3Client,
  bucket: string, objectKey: string, r2: boolean,
  abortSignal: AbortSignal): Promise<void> {
  await readRetiredFence(client, bucket, objectKey, abortSignal);
  if (await readVersioning(client, bucket, r2, abortSignal) === "versioned") {
    const versions = await listedReadManifestVersions(client, bucket, objectKey,
      abortSignal);
    const latest = versions.filter((item) => item.isLatest);
    if (latest.length !== 1 || latest[0].deleteMarker ||
        !versions.every((item) => !!item.versionId)) {
      throw new AmuxIdeaKeyStoreError("outcome_unknown");
    }
    for (const version of versions) {
      if (version === latest[0]) continue;
      await client.send(new DeleteObjectCommand({ Bucket: bucket,
        Key: objectKey, VersionId: version.versionId }), { abortSignal });
    }
  }
  await verifyRetiredReadManifestKey(client, bucket, objectKey, r2,
    abortSignal);
}

async function verifyAbsentContentKey(client: S3Client, bucket: string,
  objectKey: string, abortSignal?: AbortSignal): Promise<void> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
      { abortSignal });
  } catch (error) {
    if (typeof error === "object" && error !== null &&
        "$metadata" in error && (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode === 404) {
      const versions = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket, Prefix: objectKey, MaxKeys: 1000,
      }), { abortSignal });
      if (versions.IsTruncated === false &&
          !versions.Versions?.some((item) => item.Key === objectKey) &&
          !versions.DeleteMarkers?.some((item) => item.Key === objectKey)) return;
    }
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  }
  throw new AmuxIdeaKeyStoreError("outcome_unknown");
}
