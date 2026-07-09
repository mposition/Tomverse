import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  contentType: string
) {
  const { client, bucket } = getR2Client();

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: Number(process.env.R2_SIGNED_URL_TTL || 900) }
  );
}

export async function readR2Object(key: string) {
  const { client, bucket } = getR2Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (!response.Body) {
    throw new Error("R2 object has no body.");
  }

  return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteR2Object(key: string) {
  const { client, bucket } = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

