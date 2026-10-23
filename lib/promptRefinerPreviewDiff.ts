export type PromptRefinerPreviewDiff = Readonly<{
  commonPrefix: string;
  removed: string;
  added: string;
  commonSuffix: string;
}>;

let graphemeSegmenter: Intl.Segmenter | null | undefined;

const graphemes = (value: string): string[] => {
  if (graphemeSegmenter === undefined) {
    const Segmenter = Intl.Segmenter;
    graphemeSegmenter = typeof Segmenter === "function"
      ? new Segmenter("en", { granularity: "grapheme" })
      : null;
  }
  if (!graphemeSegmenter) return value.length === 0 ? [] : [value];
  return Array.from(
    graphemeSegmenter.segment(value),
    ({ segment }) => segment
  );
};

/**
 * Finds one bounded changed region while preserving both inputs byte-for-byte.
 * Grapheme segmentation keeps combining marks and joined emoji inside the same
 * highlight. It does not normalize either string. An environment without
 * Intl.Segmenter treats each whole string as one conservative comparison unit,
 * so unsupported browsers may highlight more but cannot split authored text.
 * The Prompt Refiner schema already bounds each input.
 */
export function diffPromptRefinerPreview(
  sourcePrompt: string,
  refinedPrompt: string
): PromptRefinerPreviewDiff {
  const source = graphemes(sourcePrompt);
  const refined = graphemes(refinedPrompt);
  const sharedLength = Math.min(source.length, refined.length);
  let prefixLength = 0;
  while (
    prefixLength < sharedLength &&
    source[prefixLength] === refined[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < source.length - prefixLength &&
    suffixLength < refined.length - prefixLength &&
    source[source.length - 1 - suffixLength] ===
      refined[refined.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const sourceChangeEnd = source.length - suffixLength;
  const refinedChangeEnd = refined.length - suffixLength;
  return {
    commonPrefix: source.slice(0, prefixLength).join(""),
    removed: source.slice(prefixLength, sourceChangeEnd).join(""),
    added: refined.slice(prefixLength, refinedChangeEnd).join(""),
    commonSuffix: source.slice(sourceChangeEnd).join(""),
  };
}
