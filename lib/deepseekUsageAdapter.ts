import "server-only";

import {
  normalizeDeepSeekSseLine,
  normalizeDeepSeekUsagePayload,
} from "@/lib/deepseekUsageAdapterCore";

const rewrittenHeaders = (headers: Headers) => {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-encoding");
  return next;
};

const normalizeEventStream = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          if (buffered) {
            controller.enqueue(
              encoder.encode(normalizeDeepSeekSseLine(buffered))
            );
          }
          controller.close();
          return;
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline + 1);
          buffered = buffered.slice(newline + 1);
          controller.enqueue(encoder.encode(normalizeDeepSeekSseLine(line)));
          newline = buffered.indexOf("\n");
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
};

export const deepseekUsageFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok || !response.body) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";

  if (contentType.includes("text/event-stream")) {
    return new Response(normalizeEventStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: rewrittenHeaders(response.headers),
    });
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as unknown;
      return new Response(
        JSON.stringify(normalizeDeepSeekUsagePayload(payload)),
        {
          status: response.status,
          statusText: response.statusText,
          headers: rewrittenHeaders(response.headers),
        }
      );
    } catch {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: rewrittenHeaders(response.headers),
      });
    }
  }

  return response;
};
