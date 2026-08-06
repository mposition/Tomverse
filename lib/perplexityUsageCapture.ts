import "server-only";

import {
  combinePerplexityResponseCaptures,
  parsePerplexityResponseCapture,
  EMPTY_PERPLEXITY_RESPONSE_CAPTURE,
  type PerplexityResponseCapture,
} from "@/lib/perplexityResponseCore";

export const PERPLEXITY_USAGE_TRACE_HEADER =
  "x-tomverse-perplexity-usage-trace";

type Capture = {
  promise: Promise<PerplexityResponseCapture>;
  resolve: (value: PerplexityResponseCapture) => void;
};

const captures = new Map<string, Capture[]>();
const MAX_CAPTURE_CHARACTERS = 2_000_000;

const createCapture = (traceId: string) => {
  let resolve!: (value: PerplexityResponseCapture) => void;
  const promise = new Promise<PerplexityResponseCapture>((resolver) => {
    resolve = resolver;
  });
  const capture = { promise, resolve };
  const entries = captures.get(traceId) || [];
  entries.push(capture);
  captures.set(traceId, entries);
  return capture;
};

export const perplexityUsageHeaders = (traceId: string) => ({
  [PERPLEXITY_USAGE_TRACE_HEADER]: traceId,
});

/**
 * The canonical read of this trace's Perplexity responses: billing usage and
 * user-facing sources from the one body each response was already captured
 * as. Consuming is destructive (the trace's buffers are released), so a
 * request that needs both must take the capture once and use both halves --
 * see the memoized takePerplexityCapture() in app/api/chat/route.ts.
 */
export const consumePerplexityResponseCapture = async (
  traceId: string
): Promise<PerplexityResponseCapture | null> => {
  const entries = captures.get(traceId);
  if (!entries) return null;
  captures.delete(traceId);
  return combinePerplexityResponseCaptures(
    await Promise.all(entries.map((capture) => capture.promise))
  );
};

/**
 * Billing-only view of the same capture, kept so existing settlement call
 * sites read exactly as before. Identical semantics to the original: the
 * combined cost snapshot for the trace, or null when nothing was captured.
 */
export const consumePerplexityUsage = async (traceId: string) =>
  (await consumePerplexityResponseCapture(traceId))?.usage ?? null;

export const discardPerplexityUsage = (traceId: string) => {
  const entries = captures.get(traceId);
  if (!entries) return;
  captures.delete(traceId);
  for (const capture of entries) {
    capture.resolve(EMPTY_PERPLEXITY_RESPONSE_CAPTURE);
  }
};

export const perplexityUsageFetch: typeof fetch = async (input, init) => {
  const inputHeaders =
    init?.headers || (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inputHeaders);
  const traceId = headers.get(PERPLEXITY_USAGE_TRACE_HEADER)?.trim() || null;
  headers.delete(PERPLEXITY_USAGE_TRACE_HEADER);

  const response = await fetch(input, { ...init, headers });
  if (!traceId || !response.ok || !response.body) return response;

  const capture = createCapture(traceId);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  let completed = false;

  const finish = (tail = "") => {
    if (completed) return;
    completed = true;
    if (captured.length < MAX_CAPTURE_CHARACTERS) {
      captured += tail.slice(0, MAX_CAPTURE_CHARACTERS - captured.length);
    }
    capture.resolve(parsePerplexityResponseCapture(captured));
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(decoder.decode());
          controller.close();
          return;
        }
        if (captured.length < MAX_CAPTURE_CHARACTERS) {
          const decoded = decoder.decode(value, { stream: true });
          captured += decoded.slice(
            0,
            MAX_CAPTURE_CHARACTERS - captured.length
          );
        }
        controller.enqueue(value);
      } catch (error) {
        finish(decoder.decode());
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish(decoder.decode());
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
