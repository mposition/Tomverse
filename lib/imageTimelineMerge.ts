// How a poll answer is folded into the workspace timeline.
//
// Pure and in lib/ rather than inline in the component, because both rules it
// encodes are ones a plausible refactor would drop, and neither failure is
// visible on screen.

export type ImageTimelineAsset = {
  role: string;
  mimeType: string;
  url: string;
};

export type ImageTimelineRow = {
  generationId: string;
  status: string;
  assets: ImageTimelineAsset[];
  attemptNumber?: number;
  [key: string]: unknown;
};

const isTerminal = (status: string) =>
  status === "succeeded" || status === "failed";

export type MergeImageTimelineOptions = {
  /**
   * Allow the incoming signed asset URLs to replace the ones already held.
   *
   * Only the single-card recovery read sets this. It exists precisely because
   * the URLs expire, so it must be able to replace them; every other caller
   * must not.
   */
  refreshAssets?: boolean;
};

/**
 * Fold one generation into the timeline.
 *
 * Two rules, both about not undoing something already true:
 *
 * 1. **A terminal row is never moved back to a live status.** Poll answers can
 *    arrive out of order, and a stale one must not turn a finished card back
 *    into a spinner.
 *
 * 2. **A settled row keeps the asset URLs it already has.** Signed URLs are
 *    minted fresh on every read, so a group poll returns a *different* URL
 *    string for an image that has not changed. Taking it rewrites the `<img>`
 *    src and the browser downloads the same bytes again -- once per poll tick,
 *    for every target that finished before the slowest one. Per-generation
 *    polling never hit this because it only ever read unsettled rows; reading
 *    the whole group is what made an already-finished card part of every
 *    answer.
 */
export const mergeImageTimelineRow = <T extends ImageTimelineRow>(
  current: readonly T[],
  incoming: T,
  options: MergeImageTimelineOptions = {}
): T[] => {
  const index = current.findIndex(
    (row) => row.generationId === incoming.generationId
  );
  if (index === -1) return [...current, incoming];

  const existing = current[index];
  if (isTerminal(existing.status) && !isTerminal(incoming.status)) {
    return [...current];
  }

  const keepAssets =
    !options.refreshAssets &&
    isTerminal(existing.status) &&
    existing.assets.length > 0;

  const next = [...current];
  next[index] = {
    ...existing,
    ...incoming,
    ...(keepAssets ? { assets: existing.assets } : {}),
  };
  return next;
};
