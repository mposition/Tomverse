"use client";

import { useEffect, useState } from "react";
import { consumeChatStream } from "@/lib/chatStreamConsumer";
import type { ImageSize } from "@/lib/imageGenerationPricing";

export type StudioImageQuote = {
  modelId: string;
  model: string;
  credits: number;
  pricingVersion: string;
};

export class StudioGenerationError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(code || "Studio generation failed");
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new StudioGenerationError(response.status, data?.code);
  return data as T;
}

function postJson(path: string, body: object, signal: AbortSignal, method = "POST") {
  return fetch(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

export function useStudioImageQuote(size: ImageSize, edit: boolean, enabled = true) {
  const [result, setResult] = useState<{ key: string; quote?: StudioImageQuote; error?: number }>();
  const [version, setVersion] = useState(0);
  const key = [size, edit, version].join("/");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void fetch("/api/studio/images?" + new URLSearchParams({ size, edit: String(edit) }), { signal, cache: "no-store" })
      .then(readJson<StudioImageQuote>)
      .then(quote => setResult({ key, quote }))
      .catch(error => {
        if (!signal.aborted) setResult({ key, error: error instanceof StudioGenerationError ? error.status : 503 });
      });
    return () => controller.abort();
  }, [enabled, size, edit, key]);
  return {
    quote: enabled && result?.key === key ? result.quote : undefined,
    error: enabled && result?.key === key ? result.error : undefined,
    reload: () => setVersion(value => value + 1),
  };
}

async function uploadStudioReference(blob: Blob, signal: AbortSignal) {
  const descriptor = { name: "studio-reference.png", mediaType: blob.type, size: blob.size };
  const prepared = await readJson<{ key: string; uploadUrl: string; uploadHeaders?: Record<string, string> }>(
    await postJson("/api/chat", descriptor, signal, "PUT"),
  );
  const uploaded = await fetch(prepared.uploadUrl, {
    method: "PUT", headers: prepared.uploadHeaders ?? { "Content-Type": blob.type }, body: blob, signal,
  });
  if (!uploaded.ok) throw new StudioGenerationError(uploaded.status);
  const { uploadId } = await readJson<{ uploadId: string }>(
    await postJson("/api/chat", { ...descriptor, key: prepared.key }, signal, "PATCH"),
  );
  if (!uploadId) throw new StudioGenerationError(400);
  return uploadId;
}

function waitForImage(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 2_500);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

type StudioSubmission = { groupId: string };
type StudioImageRun = { inputKey: string; idempotencyKey: string; uploadId?: string; groupId?: string };
export function createStudioImageRunner() {
  let current: StudioImageRun | undefined;
  return async (input: {
    inputKey: string;
    prompt: string;
    size: ImageSize;
    quote: StudioImageQuote;
    reference?: () => Promise<Blob>;
    signal: AbortSignal;
  }): Promise<Blob> => {
    const { signal, quote } = input;
    const key = JSON.stringify([input.inputKey, input.prompt, input.size, quote.modelId, quote.pricingVersion]);
    if (current?.inputKey !== key) current = { inputKey: key, idempotencyKey: crypto.randomUUID() };
    const run = current;
    if (!run.groupId) {
      if (!run.uploadId && input.reference) {
        run.uploadId = await uploadStudioReference(await input.reference(), signal);
      }
      let submitted: StudioSubmission;
      try {
        submitted = await readJson<StudioSubmission>(await postJson("/api/studio/images", {
          prompt: input.prompt, size: input.size, modelId: quote.modelId, pricingVersion: quote.pricingVersion,
          idempotencyKey: run.idempotencyKey, ...(run.uploadId ? { uploadId: run.uploadId } : {}),
        }, signal));
      } catch (error) {
        if (signal.aborted || (error instanceof StudioGenerationError && error.status < 500)) {
          if (!signal.aborted) current = undefined;
          throw error;
        }
        // A lost response may already have reserved credits. Recover the
        // receipt or keep the same key for the next click.
        const query = new URLSearchParams({ requestKey: run.idempotencyKey });
        submitted = await readJson<StudioSubmission>(await fetch("/api/images/generations?" + query, { signal }));
      }
      run.groupId = submitted.groupId;
    }
    const deadline = Date.now() + 16 * 60 * 1000;
    while (Date.now() < deadline) {
      const group = await readJson<{
        targets: { currentGenerationId: string | null }[];
        generations: { generationId: string; status: string }[];
      }>(await fetch("/api/images/groups/" + encodeURIComponent(run.groupId), { signal, cache: "no-store" }));
      const generation = group.generations.find(item => item.generationId === group.targets[0]?.currentGenerationId);
      if (generation?.status === "succeeded") {
        const response = await fetch("/api/images/generations/" + encodeURIComponent(generation.generationId) + "/download", { signal });
        if (!response.ok) throw new StudioGenerationError(response.status);
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new StudioGenerationError(502);
        current = undefined;
        return blob;
      }
      if (generation?.status === "failed") {
        current = undefined;
        throw new StudioGenerationError(502);
      }
      await waitForImage(signal);
    }
    throw new StudioGenerationError(504);
  };
}

export async function generateStudioText(prompt: string, signal: AbortSignal) {
  // Use the ordinary metered text endpoint without opening a chat or
  // persisting a transcript. The Studio editor owns the draft.
  const response = await postJson("/api/chat", {
    messages: [{ role: "user", content: prompt }],
  }, signal);
  if (!response.ok || !response.body) {
    await readJson(response);
    throw new StudioGenerationError(response.status);
  }
  const result = await consumeChatStream({
    reader: response.body.getReader(),
    liveness: { noteKeepalive() {}, noteVisibleChunk() {} },
    onProgress() {},
  });
  if (result.serverStallCode || !result.displayText.trim()) throw new StudioGenerationError(502);
  return result.displayText.trim();
}
