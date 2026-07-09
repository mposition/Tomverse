import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BoundedBufferError } from "@/lib/boundedBuffer";

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
      Metadata: {
        "upload-size": String(contentLength),
      },
    }),
    { expiresIn: Number(process.env.R2_SIGNED_URL_TTL || 900) }
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
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  const actualSize = head.ContentLength;
  const expectedSize = Number(head.Metadata?.["upload-size"]);
  const contentTypeMatches =
    normalizeContentType(head.ContentType) ===
    normalizeContentType(options.expectedContentType);
  const sizeIsValid =
    Number.isSafeInteger(actualSize) &&
    actualSize! > 0 &&
    actualSize! <= options.maxBytes &&
    Number.isSafeInteger(expectedSize) &&
    expectedSize === actualSize;

  if (!sizeIsValid || !contentTypeMatches) {
    await deleteInvalidObject(client, bucket, key);
    throw new BoundedBufferError("R2 object metadata is invalid.");
  }

  const abortController = new AbortController();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: head.ETag,
    }),
    { abortSignal: abortController.signal }
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

export async function writeR2Object(
  key: string,
  body: Buffer,
  contentType: string
) {
  const { client, bucket } = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: {
        "upload-size": String(body.byteLength),
      },
    })
  );
}

export async function deleteR2Object(key: string) {
  const { client, bucket } = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
