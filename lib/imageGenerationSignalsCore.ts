import type { ImageGenerationSignalKind } from "@/lib/imageRoutingCore";

/**
 * What a person can say about one generated image from the browser.
 * `download` is recorded by the download route itself and is never accepted
 * from a client: a count a caller can inflate says nothing about the image.
 */
export const IMAGE_GENERATION_USER_SIGNAL_KINDS = ["selected", "helpful", "not_helpful", "wanted_text"] as const;
export type ImageGenerationUserSignalKind = (typeof IMAGE_GENERATION_USER_SIGNAL_KINDS)[number];

/** Signals a person can take back. A choice between models is moved, not undone. */
export const IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS = ["helpful", "not_helpful", "wanted_text"] as const;
export type ImageGenerationCancellableSignalKind = (typeof IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS)[number];

export const isImageGenerationUserSignalKind = (value: unknown): value is ImageGenerationUserSignalKind =>
  typeof value === "string" && (IMAGE_GENERATION_USER_SIGNAL_KINDS as readonly string[]).includes(value);

export const isImageGenerationCancellableSignalKind = (
  value: unknown
): value is ImageGenerationCancellableSignalKind =>
  typeof value === "string" && (IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS as readonly string[]).includes(value);

/** The kind a signal of this kind replaces on the same generation, if any. */
export const mutuallyExclusiveSignalKind = (
  kind: ImageGenerationSignalKind
): ImageGenerationSignalKind | null =>
  kind === "helpful" ? "not_helpful" : kind === "not_helpful" ? "helpful" : null;

/** Compile-time check that the user-facing list stays inside the stored list. */
export const USER_SIGNAL_KINDS_ARE_STORED_KINDS: readonly ImageGenerationSignalKind[] =
  IMAGE_GENERATION_USER_SIGNAL_KINDS;

/**
 * The kinds on screen for one generation after a press: the pressed kind is
 * added or removed, and a rival kind leaves when its rival arrives.
 */
export const applyImageSignalToState = (
  current: readonly ImageGenerationSignalKind[],
  kind: ImageGenerationSignalKind,
  active: boolean
): ImageGenerationSignalKind[] => {
  const rival = mutuallyExclusiveSignalKind(kind);
  const next = current.filter((entry) => entry !== kind && !(active && entry === rival));
  return active ? [...next, kind] : next;
};

/**
 * Sends one signal. Resolves true when the server accepted it; any refusal or
 * network failure is false, because a signal is a courtesy the page never
 * blocks on and never shows an error for.
 */
export async function sendImageGenerationSignal(
  generationId: string,
  kind: ImageGenerationUserSignalKind,
  active: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const base = `/api/images/generations/${encodeURIComponent(generationId)}/signal`;
    const response = active
      ? await fetchImpl(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind }),
        })
      : await fetchImpl(`${base}?kind=${encodeURIComponent(kind)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
