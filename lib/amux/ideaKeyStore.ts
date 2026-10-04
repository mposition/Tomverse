import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{2,126}$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const MAGIC = Buffer.from("AMK1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const STORED_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES + KEY_BYTES;

export class AmuxIdeaKeyStoreError extends Error {
  constructor(readonly code: "unavailable" | "missing" | "conflict" |
    "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "AmuxIdeaKeyStoreError";
  }
}

function objectKey(ideaId: string): string {
  if (!IDEA_ID.test(ideaId)) throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  return `amux/v4/idea/${ideaId}/key`;
}

function connection(env: NodeJS.ProcessEnv) {
  const bucket = env.AMUX_V4_KEY_STORE_BUCKET;
  const region = env.AMUX_V4_KEY_STORE_REGION;
  const endpoint = env.AMUX_V4_KEY_STORE_ENDPOINT;
  const accessKeyId = env.AMUX_V4_KEY_STORE_ACCESS_KEY_ID;
  const secretAccessKey = env.AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY;
  if (!bucket || !BUCKET.test(bucket) || !region || !REGION.test(region) ||
      !endpoint || !accessKeyId || !secretAccessKey ||
      !/^https:\/\/[^/?#]+\/?$/.test(endpoint)) {
    throw new AmuxIdeaKeyStoreError("unavailable");
  }
  return { bucket, client: new S3Client({ region, endpoint,
    forcePathStyle: env.AMUX_V4_KEY_STORE_URL_STYLE === "path",
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 }) };
}

export function sealAmuxIdeaKey(ideaId: string, key: Buffer, wrappingKey: Buffer): Buffer {
  objectKey(ideaId);
  if (key.length !== KEY_BYTES || wrappingKey.length !== KEY_BYTES) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(Buffer.from(`amux-v4-idea-key\0${ideaId}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function openAmuxIdeaKey(ideaId: string, bytes: Buffer, wrappingKey: Buffer): Buffer {
  objectKey(ideaId);
  if (wrappingKey.length !== KEY_BYTES) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  if (bytes.length !== STORED_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  }
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = bytes.subarray(MAGIC.length + IV_BYTES,
    MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
  decipher.setAAD(Buffer.from(`amux-v4-idea-key\0${ideaId}`, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + IV_BYTES +
      TAG_BYTES)), decipher.final()]);
  } catch { throw new AmuxIdeaKeyStoreError("integrity_unavailable"); }
}

function scopedKeys(ideaId: string, key: Buffer, global: AmuxContentKeys): AmuxContentKeys {
  if (key.length !== KEY_BYTES) throw new AmuxIdeaKeyStoreError("integrity_unavailable");
  return { masterKeyId: `idea-${ideaId}`, masterKeyVersion: 1,
    masterKey: key, digestKeyId: global.digestKeyId, digestKey: global.digestKey };
}

/** Create before submission. On an uncertain submission outcome keep the key
 * until the exact request-id read-back; never delete a possibly committed key. */
export async function createAmuxIdeaContentKeys(ideaId: string,
  env: NodeJS.ProcessEnv = process.env): Promise<AmuxContentKeys> {
  const key = objectKey(ideaId);
  const global = loadCurrentAmuxContentKeys(env);
  const { bucket, client } = connection(env);
  const dataKey = randomBytes(KEY_BYTES);
  const body = sealAmuxIdeaKey(ideaId, dataKey, global.masterKey);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key,
      Body: body, ContentType: "application/octet-stream",
      IfNoneMatch: "*", CacheControl: "no-store" }));
    return scopedKeys(ideaId, dataKey, global);
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

/** The key object is outside product DB backups. Missing or unreadable keys
 * fail closed; a DB restore cannot silently recreate deleted content keys. */
export async function loadAmuxIdeaContentKeys(ideaId: string,
  env: NodeJS.ProcessEnv = process.env): Promise<AmuxContentKeys> {
  const key = objectKey(ideaId);
  const global = loadCurrentAmuxContentKeys(env);
  const { bucket, client } = connection(env);
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body || result.ContentLength !== STORED_BYTES) {
      throw new AmuxIdeaKeyStoreError("integrity_unavailable");
    }
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    try { return scopedKeys(ideaId, openAmuxIdeaKey(ideaId, bytes, global.masterKey), global); }
    finally { bytes.fill(0); }
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

/** Only a retention writer may call this after the corresponding DB body is
 * irreversibly out of the active rows. A failed read-back is outcome_unknown. */
export async function deleteAmuxIdeaContentKey(ideaId: string,
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const key = objectKey(ideaId);
  const { bucket, client } = connection(env);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      throw new AmuxIdeaKeyStoreError("outcome_unknown");
    } catch (error) {
      if (error instanceof AmuxIdeaKeyStoreError) throw error;
      if (typeof error === "object" && error !== null &&
          "$metadata" in error && (error as { $metadata?: { httpStatusCode?: number } })
            .$metadata?.httpStatusCode === 404) return;
      throw new AmuxIdeaKeyStoreError("outcome_unknown");
    }
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError) throw error;
    throw new AmuxIdeaKeyStoreError("outcome_unknown");
  } finally { client.destroy(); }
}
