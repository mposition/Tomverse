/** Opt-in transport; the original handler owns all authorization and settlement. */
export const REVIEW_STREAM_TYPE = "application/x-ndjson";
export type PublishReviewProgress = (review: unknown, headers?: HeadersInit) => void;

export async function withReviewProgress(
  request: Request,
  run: (publish: PublishReviewProgress) => Promise<Response>,
): Promise<Response> {
  if (!request.headers.get("accept")?.split(",").some(value => value.trim() === REVIEW_STREAM_TYPE)) {
    return run(() => {});
  }
  let publishFirst!: (value: { review: unknown; headers?: HeadersInit }) => void;
  const first = new Promise<{ review: unknown; headers?: HeadersInit }>(resolve => { publishFirst = resolve; });
  let published = false;
  const result = run((review, headers) => {
    if (published) return;
    published = true;
    publishFirst({ review, headers });
  });
  const ready = await Promise.race([
    first.then(progress => ({ kind: "progress" as const, progress })),
    result.then(response => ({ kind: "complete" as const, response })),
  ]);
  // Validation errors and cache hits keep their HTTP status and ordinary JSON.
  if (ready.kind === "complete") return ready.response;
  const encoder = new TextEncoder();
  let disconnected = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (!disconnected) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      send({ type: "primary", data: ready.progress.review });
      heartbeat = setInterval(() => {
        if (!disconnected) controller.enqueue(encoder.encode("\n"));
      }, 15_000);
      void result.then(async response => {
        const data: unknown = await response.json();
        send({ type: response.ok ? "complete" : "error", data });
      }).catch(() => {
        send({ type: "error", data: { code: "COMPARISON_REVIEW_FAILED", error: "The review could not be finalized." } });
      }).finally(() => {
        clearInterval(heartbeat);
        if (!disconnected) controller.close();
      });
    },
    // Disconnecting does not abandon a paid run or bypass its durable finalization.
    cancel() { disconnected = true; clearInterval(heartbeat); },
  });
  const headers = new Headers(ready.progress.headers);
  headers.set("Content-Type", `${REVIEW_STREAM_TYPE}; charset=utf-8`);
  headers.set("Cache-Control", "no-store, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(stream, { headers });
}

/** A primary result is useful, but EOF without a final event is never success. */
export async function readReviewProgress(
  response: Response,
  onPrimary: (data: unknown) => void,
): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes(REVIEW_STREAM_TYPE)) return response.json();
  if (!response.body) throw new Error("The review stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: unknown;
  let completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 2_000_000) throw new Error("The review stream is too large.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type: string; data: unknown };
        if (completed) throw new Error("The review stream contains events after completion.");
        if (event.type === "primary") onPrimary(event.data);
        else if (event.type === "complete" || event.type === "error") {
          final = event.data;
          completed = true;
        } else throw new Error("The review stream contains an unknown event.");
      }
      if (chunk.done) break;
    }
    if (!completed || buffer.trim()) throw new Error("The review stream ended before finalization.");
    return final;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
