const NUL = String.fromCharCode(0);
export const SEARCH_METADATA_TRAILER_MARKER = `${NUL}TOMVERSE_SEARCH_METADATA`;

export function buildSearchMetadataTrailerChunk(execution: unknown): string {
  return `${SEARCH_METADATA_TRAILER_MARKER}${JSON.stringify(execution)}`;
}

/**
 * What the trailer carries, for the same reason the trailer exists: neither
 * the citations nor the finish reason is knowable before the last text token
 * has already streamed.
 */

export function splitSearchMetadataTrailer(raw: string): {
  displayText: string;
  searchMetadataJson: string | null;
} {
  const markerIndex = raw.indexOf(SEARCH_METADATA_TRAILER_MARKER);
  if (markerIndex === -1) {
    return { displayText: raw, searchMetadataJson: null };
  }
  return {
    displayText: raw.slice(0, markerIndex),
    searchMetadataJson: raw.slice(
      markerIndex + SEARCH_METADATA_TRAILER_MARKER.length
    ),
  };
}
