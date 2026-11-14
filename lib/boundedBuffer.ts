import "server-only";

export class BoundedBufferError extends Error {
  constructor(message = "Stream exceeded the allowed size.") {
    super(message);
    this.name = "BoundedBufferError";
  }
}

export async function readWebStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal
) {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (signal?.aborted) {
      abort();
      signal.throwIfAborted();
    }
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // A remote stream's cancellation handshake must not hold up rejection.
        void reader.cancel("Size limit exceeded.").catch(() => {});
        throw new BoundedBufferError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function readResponseToBuffer(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    void response.body?.cancel("Size limit exceeded.").catch(() => {});
    throw new BoundedBufferError();
  }
  if (!response.body) {
    throw new Error("Response has no body.");
  }

  return readWebStreamToBuffer(response.body, maxBytes, signal);
}
