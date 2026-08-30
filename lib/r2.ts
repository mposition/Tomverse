import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BoundedBufferError } from "@/lib/boundedBuffer";
import {
  classifyStorageError,
  storageErrorStatus,
  toStorageError,
  type StorageOperation,
} from "@/lib/storageObjectErrors";

/**
 * Every S3 call in this file goes through here.
 *
 * Not for retries and not for logging -- for *typing*. The AWS SDK throws
 * `NotFound`, `AccessDenied` and a socket reset as three objects that differ
 * only in a string, and a caller that catches `error` cannot tell "the bytes
 * are gone" from "the credentials rotated" without repeating the same duck
 * typing at every call site. One of those two answers is something we tell a
 * user about their own file, and getting it wrong during a credentials outage
 * would mark an account's whole history as lost.
 *
 * The original error stays on `cause`; the key never leaves this module.
 */
const r2Call = async <T>(
  operation: StorageOperation,
  send: () => Promise<T>
): Promise<T> => {
  try {
    return await send();
  } catch (error) {
    throw toStorageError(operation, error);
  }
};

const getR2Config = () => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2 environment variables are not configured.");
  }

  return {
    bucket,
    endpoint:
      process.env.R2_ENDPOINT ||
      `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  };
};

const getR2Client = () => {
  const config = getR2Config();

  return {
    bucket: config.bucket,
    client: new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: config.credentials,
    }),
  };
};

export async function createR2UploadUrl(
  key: string,
  contentType: string,
  contentLength: number
) {
  const { client, bucket } = getR2Client();

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: Number(process.env.R2_SIGNED_URL_TTL || 900) }
  );
}

export async function createR2ReadUrl(key: string, expiresInSeconds = 300) {
  const { client, bucket } = getR2Client();

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn: expiresInSeconds }
  );
}

const normalizeContentType = (value: string | undefined) =>
  value?.split(";", 1)[0]?.trim().toLowerCase() || "";

const deleteInvalidObject = async (
  client: S3Client,
  bucket: string,
  key: string
) => {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    console.error("Failed to delete invalid R2 object:", error);
  }
};

export async function readR2Object(
  key: string,
  options: { maxBytes: number; expectedContentType: string }
) {
  const { client, bucket } = getR2Client();
  const head = await r2Call("head", () =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  );
  const actualSize = head.ContentLength;
  const contentTypeMatches =
    normalizeContentType(head.ContentType) ===
    normalizeContentType(options.expectedContentType);
  const sizeIsValid =
    Number.isSafeInteger(actualSize) &&
    actualSize! > 0 &&
    actualSize! <= options.maxBytes;

  if (!sizeIsValid || !contentTypeMatches) {
    await deleteInvalidObject(client, bucket, key);
    throw new BoundedBufferError("R2 object metadata is invalid.");
  }

  const abortController = new AbortController();
  const response = await r2Call("get", () =>
    client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        IfMatch: head.ETag,
      }),
      { abortSignal: abortController.signal }
    )
  );

  if (!response.Body) {
    throw new Error("R2 object has no body.");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxBytes) {
        abortController.abort();
        await deleteInvalidObject(client, bucket, key);
        throw new BoundedBufferError();
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof BoundedBufferError) throw error;
    abortController.abort();
    throw error;
  }

  if (totalBytes !== actualSize) {
    await deleteInvalidObject(client, bucket, key);
    throw new BoundedBufferError("R2 object size changed while reading.");
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function validateR2ObjectMetadata(
  key: string,
  options: {
    maxBytes: number;
    expectedContentType: string;
    expectedSize?: number;
  }
) {
  const { client, bucket } = getR2Client();
  const head = await r2Call("head", () =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  );
  const actualSize = head.ContentLength;
  const contentType = normalizeContentType(head.ContentType);
  const expectedContentType = normalizeContentType(options.expectedContentType);
  const sizeMatches =
    Number.isSafeInteger(actualSize) &&
    actualSize! > 0 &&
    actualSize! <= options.maxBytes &&
    (options.expectedSize === undefined || actualSize === options.expectedSize);
  const contentTypeMatches = contentType === expectedContentType;

  if (!sizeMatches || !contentTypeMatches) {
    await deleteInvalidObject(client, bucket, key);
    throw new BoundedBufferError("R2 object metadata is invalid.");
  }

  return {
    size: actualSize!,
    contentType,
    etag: head.ETag || null,
  };
}

/**
 * The size of an object, without reading it and without deleting anything.
 *
 * `validateR2ObjectMetadata` above answers a different question: is this
 * upload what it claimed to be, and if not, remove it. Reusing it to measure
 * an object would make a measurement destructive -- a routing probe that
 * deleted the user's attachment because a content type had drifted would be a
 * data-loss bug caused by a feature that only wanted a number.
 *
 * Returns null when the object cannot be measured, rather than throwing:
 * every caller so far is deciding whether it knows enough to act, and "no"
 * is an answer they can use.
 */
export async function measureR2Object(key: string): Promise<number | null> {
  try {
    const { client, bucket } = getR2Client();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    const size = head.ContentLength;
    return Number.isSafeInteger(size) && size! > 0 ? size! : null;
  } catch {
    return null;
  }
}

/**
 * Read an object we wrote ourselves, bounded, and **never** delete it.
 *
 * `readR2Object` above is for untrusted uploads: a metadata mismatch there is
 * evidence the object is not what it claimed, so it removes it. That branch is
 * the reason this second function exists rather than a flag. The thumbnail
 * repair reads a generated original that the user paid for and cannot
 * regenerate; a read path that can destroy its own subject is not a repair.
 * Nothing here validates a claimed content type, because nothing here trusts a
 * caller's claim about one -- the bound on bytes is the whole contract.
 */
export async function readOwnR2ObjectBytes(
  key: string,
  options: { maxBytes: number }
) {
  const { client, bucket } = getR2Client();
  const abortController = new AbortController();
  const response = await r2Call("get", () =>
    client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: abortController.signal,
    })
  );
  if (!response.Body) throw new Error("R2 object has no body.");

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxBytes) {
        abortController.abort();
        throw new BoundedBufferError();
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (!(error instanceof BoundedBufferError)) abortController.abort();
    throw error;
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function writeR2Object(
  key: string,
  body: Buffer,
  contentType: string
) {
  const { client, bucket } = getR2Client();
  await r2Call("put", () =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: {
          "upload-size": String(body.byteLength),
        },
      })
    )
  );
}

export async function deleteR2Object(key: string) {
  const { client, bucket } = getR2Client();
  await r2Call("delete", () =>
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  );
}

/**
 * Does this object exist? -- asked without reading it and without deleting
 * anything, and answered in three states rather than two.
 *
 * `measureR2Object` above returns null for every failure, which is the right
 * answer for a routing probe deciding whether it knows enough to act and the
 * wrong one for anything that records a verdict: "storage said 404" and
 * "storage did not answer" are the same null there, and treating the second as
 * the first is how a five-minute credentials outage would be written into the
 * database as permanent data loss.
 *
 * Used by the read-only attachment audit and by the chat route's confirmation
 * step before an attachment row is marked unavailable.
 */
export async function probeR2Object(key: string): Promise<{
  state: "present" | "missing" | "unreachable";
  size: number | null;
  contentType: string | null;
  lastModified: Date | null;
  storageStatus: number | null;
}> {
  const { client, bucket } = getR2Client();
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    const size = head.ContentLength;
    return {
      state: "present",
      size: Number.isSafeInteger(size) ? size! : null,
      contentType: normalizeContentType(head.ContentType) || null,
      lastModified: head.LastModified ?? null,
      storageStatus: 200,
    };
  } catch (error) {
    const kind = classifyStorageError(error);
    return {
      state: kind === "missing" ? "missing" : "unreachable",
      size: null,
      contentType: null,
      lastModified: null,
      storageStatus: storageErrorStatus(error),
    };
  }
}

/**
 * Objects under a prefix that were written before `olderThan`, oldest first.
 *
 * Used by the maintenance sweep to reclaim ephemeral guest uploads that were
 * never sent -- a file picked in the composer and then abandoned leaves an
 * orphan that nothing else will ever reference. `maxKeys` bounds one sweep so
 * a large backlog is drained across runs rather than in one long request.
 */
export async function listExpiredR2Objects(
  prefix: string,
  olderThan: Date,
  maxKeys = 1_000
) {
  const { client, bucket } = getR2Client();
  const expired: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await r2Call("list", () =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1_000, maxKeys - expired.length),
          ContinuationToken: continuationToken,
        })
      )
    );
    for (const object of page.Contents || []) {
      if (!object.Key || !object.LastModified) continue;
      if (object.LastModified.getTime() > olderThan.getTime()) continue;
      expired.push(object.Key);
      if (expired.length >= maxKeys) return expired;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return expired;
}
