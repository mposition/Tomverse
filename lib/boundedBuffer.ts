import "server-only";

export class BoundedBufferError extends Error {
  constructor(message = "Stream exceeded the allowed size.") {
    super(message);
    this.name = "BoundedBufferError";
  }
}

export async function readWebStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
) {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Size limit exceeded.");
        throw new BoundedBufferError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function readResponseToBuffer(
  response: Response,
  maxBytes: number
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await response.body?.cancel("Size limit exceeded.");
    throw new BoundedBufferError();
  }
  if (!response.body) {
    throw new Error("Response has no body.");
  }

  return readWebStreamToBuffer(response.body, maxBytes);
}
