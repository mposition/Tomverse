"use client";

import { useEffect, useState } from "react";
import { consumeChatStream } from "@/lib/chatStreamConsumer";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { StudioImageUseCase } from "@/lib/studioTools";
import type { ImageQuality, ImageSize } from "@/lib/imageGenerationPricing";
import { notifyUserUsageChanged } from "@/components/chat/useUserUsage";

export type StudioImageQuote = {
  modelId: string;
  model: string;
  credits: number;
  pricingVersion: string;
  quality: ImageQuality;
  useCase?: StudioImageUseCase;
  requestedSize?: ImageSize;
  squareFallback?: boolean;
  /** Set when several tools answer one request; `credits` is then their total. */
  targets?: { modelId: string; model: string; credits: number; pricingVersion: string }[];
};

export class StudioGenerationError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly details?: Record<string, unknown>) {
    super(code || "Studio generation failed");
  }
}

function requireJson<T>(response: Response, data: unknown): T {
  if (!response.ok || data === null) {
    const error = data as { code?: string; details?: Record<string, unknown> } | null;
    throw new StudioGenerationError(response.status, error?.code, error?.details);
  }
  return data as T;
}

async function readJson<T>(response: Response): Promise<T> {
  return requireJson<T>(response, await response.json().catch(() => null));
}

function postJson(path: string, body: object, signal: AbortSignal, method = "POST") {
  return fetch(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

type SizedStudioImageQuote = StudioImageQuote & { size: ImageSize };

export async function loadStudioImageQuote(size: ImageSize, edit: boolean, signal: AbortSignal, fallbackSize?: ImageSize, useCase?: StudioImageUseCase): Promise<SizedStudioImageQuote> {
  const requestQuote = async (requestedSize: ImageSize) => {
    const params = new URLSearchParams({ size: requestedSize, edit: String(edit) });
    if (useCase) {
      params.set("useCase", useCase);
      if (fallbackSize === "1024x1024" && fallbackSize !== requestedSize) params.set("squareFallback", "true");
    }
    const quote = await fetch("/api/studio/images?" + params, { signal, cache: "no-store" })
      .then(readJson<StudioImageQuote & { size?: ImageSize }>);
    return { ...quote, size: quote.size ?? requestedSize };
  };
  try {
    return await requestQuote(size);
  } catch (error) {
    if (signal.aborted || !fallbackSize || fallbackSize === size || !(error instanceof StudioGenerationError) ||
      error.status !== 503 || error.code !== "STUDIO_GENERATION_UNAVAILABLE") throw error;
    return requestQuote(fallbackSize);
  }
}

export function useStudioImageQuote(size: ImageSize, edit: boolean, enabled = true, fallbackSize?: ImageSize, useCase?: StudioImageUseCase) {
  const [result, setResult] = useState<{ key: string; quote?: SizedStudioImageQuote; error?: number }>();
  const [version, setVersion] = useState(0);
  const key = [size, edit, fallbackSize, useCase, version].join("/");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void loadStudioImageQuote(size, edit, signal, fallbackSize, useCase)
      .then(quote => {
        if (!signal.aborted) setResult({ key, quote });
      })
      .catch(error => {
        if (!signal.aborted) setResult({ key, error: error instanceof StudioGenerationError ? error.status : 503 });
      });
    return () => controller.abort();
  }, [enabled, size, edit, fallbackSize, useCase, key]);
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
  await discardResponseBody(uploaded);
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
    /**
     * Called for every target of the request as it finishes, in whatever order
     * they do. Without it only the first target is read.
     */
    onImage?: (image: { blob: Blob; modelId: string }) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<Blob> => {
    const { signal, quote } = input;
    const key = JSON.stringify([input.inputKey, input.prompt, input.size, quote.modelId, quote.pricingVersion, quote.quality, quote.credits, quote.useCase, quote.targets]);
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
          quality: quote.quality, credits: quote.credits, requestedSize: quote.requestedSize, squareFallback: quote.squareFallback,
          useCase: quote.useCase, idempotencyKey: run.idempotencyKey, ...(run.uploadId ? { uploadId: run.uploadId } : {}),
          ...(quote.targets ? { targets: quote.targets.map(({ modelId, pricingVersion, credits }) => ({ modelId, pricingVersion, credits })) } : {}),
        }, signal));
      } catch (error) {
        if (signal.aborted || (error instanceof StudioGenerationError && error.status < 500)) {
          if (!signal.aborted) {
            current = undefined;
            if (run.uploadId) {
              await postJson("/api/chat", { uploadId: run.uploadId }, signal, "DELETE")
                .then(response => response.body?.cancel())
                .catch(() => undefined);
            }
          }
          throw error;
        }
        // A lost response may already have reserved credits. Recover the
        // receipt or keep the same key for the next click.
        const query = new URLSearchParams({ requestKey: run.idempotencyKey });
        const receipt = await fetch("/api/images/generations?" + query, { signal });
        submitted = requireJson<StudioSubmission>(receipt, await receipt.json().catch(() => null));
      }
      run.groupId = submitted.groupId;
    }
    const deadline = Date.now() + 16 * 60 * 1000;
    const delivered = new Map<string, Blob | null>();
    while (Date.now() < deadline) {
      const groupResponse = await fetch("/api/images/groups/" + encodeURIComponent(run.groupId), { signal, cache: "no-store" });
      const group = requireJson<{
        targets: { modelId: string; currentGenerationId: string | null }[];
        generations: { generationId: string; status: string }[];
      }>(groupResponse, await groupResponse.json().catch(() => null));
      const targets = input.onImage ? group.targets : group.targets.slice(0, 1);
      for (const target of targets) {
        const generation = group.generations.find(item => item.generationId === target.currentGenerationId);
        if (!generation || delivered.has(generation.generationId)) continue;
        if (generation.status === "failed") delivered.set(generation.generationId, null);
        if (generation.status !== "succeeded") continue;
        notifyUserUsageChanged();
        const response = await fetch("/api/images/generations/" + encodeURIComponent(generation.generationId) + "/download", { signal });
        if (!response.ok) {
          await discardResponseBody(response);
          throw new StudioGenerationError(response.status);
        }
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new StudioGenerationError(502);
        delivered.set(generation.generationId, blob);
        await input.onImage?.({ blob, modelId: target.modelId });
      }
      if (targets.length > 0 && delivered.size >= targets.length) {
        current = undefined;
        // One tool failing leaves the other's result; all failing is a failure.
        const first = [...delivered.values()].find(blob => blob !== null);
        if (!first) throw new StudioGenerationError(502);
        return first;
      }
      await waitForImage(signal);
    }
    throw new StudioGenerationError(504);
  };
}

export async function generateStudioText(prompt: string, signal: AbortSignal, reference?: Blob) {
  // Use the ordinary metered text endpoint without opening a chat or
  // persisting a transcript. The Studio editor owns the draft.
  const uploadId = reference ? await uploadStudioReference(reference, signal) : undefined;
  try {
    const response = await postJson("/api/chat", {
      messages: [{ role: "user", content: prompt, ...(uploadId ? { attachments: [{ uploadId }] } : {}) }],
      ...(uploadId ? { webSearchMode: "off" } : {}),
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
    notifyUserUsageChanged();
    if (result.serverStallCode || !result.displayText.trim()) throw new StudioGenerationError(502);
    return result.displayText.trim();
  } finally {
    if (uploadId) {
      void postJson("/api/chat", { uploadId }, AbortSignal.timeout(5000), "DELETE")
        .then(discardResponseBody)
        .catch(() => undefined);
    }
  }
}
