/**
 * "Creating the Excel file..." -- as a chunk in the answer stream.
 *
 * Policy: docs/policy/generated-artifacts.md section 9.
 *
 * A tool call happens between the model's steps, and while it runs the
 * provider is producing no tokens at all. From the browser that is
 * indistinguishable from a slow model: the answer simply stops for a second or
 * two and then resumes. Saying which of the two is happening is the whole job
 * of this signal.
 *
 * It cannot be a header (headers are fixed before the first body byte, and the
 * tool has not been called yet) and it cannot wait for the trailer (which
 * arrives when the work is already done, so the status would only ever be
 * shown after it stopped being true). So it goes where the news is, using the
 * same convention as lib/routingRetrySignal.ts: a chunk led by a NUL code
 * point, which providers do not emit in normal completions, so real model
 * output cannot collide with it.
 *
 * What it carries is the format and nothing else. Not the file name -- the
 * model chose that and it is not final until the specification is admitted --
 * and not the row count, which would be a number about data the user has not
 * been shown yet.
 */

import {
  isSupportedArtifactFormat,
  type SupportedArtifactFormat,
} from "@/lib/generatedArtifactCore";

const NUL = String.fromCharCode(0);

export const ARTIFACT_PROGRESS_MARKER = `${NUL}TOMVERSE_ARTIFACT_PROGRESS`;

export type ArtifactProgressSignal = {
  /** Fixed, so a client can switch on it rather than on a truthy check. */
  state: "generating";
  format: SupportedArtifactFormat;
};

export const buildArtifactProgressChunk = (
  format: SupportedArtifactFormat
): string =>
  `${ARTIFACT_PROGRESS_MARKER}${JSON.stringify({
    state: "generating",
    format,
  } satisfies ArtifactProgressSignal)}`;

export type SplitArtifactProgress = {
  /** The stream with every progress marker removed. What the user reads. */
  text: string;
  /** The last signal seen, or null. */
  signal: ArtifactProgressSignal | null;
};

/**
 * Separates the signal from the answer.
 *
 * Tolerant in the same direction as the routing retry signal: an unparseable
 * marker is still *removed*, and only its content is dropped. The failure that
 * must never happen is rendering the marker itself as the first words of an
 * answer.
 *
 * The payload is one flat JSON object written by this file -- no nested braces
 * and no braces inside its strings -- so the first `}` is its end. A payload
 * that does not parse is discarded rather than guessed at.
 */
export const splitArtifactProgressSignal = (
  raw: string
): SplitArtifactProgress => {
  if (!raw.includes(ARTIFACT_PROGRESS_MARKER)) return { text: raw, signal: null };

  let text = "";
  let signal: ArtifactProgressSignal | null = null;
  let rest = raw;

  for (;;) {
    const start = rest.indexOf(ARTIFACT_PROGRESS_MARKER);
    if (start === -1) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    const payloadStart = start + ARTIFACT_PROGRESS_MARKER.length;
    const end = rest.indexOf("}", payloadStart);
    if (end === -1) {
      // A truncated marker: the stream is still arriving, and half a marker is
      // not answer text.
      break;
    }
    const parsed = parseSignal(rest.slice(payloadStart, end + 1));
    if (parsed) signal = parsed;
    rest = rest.slice(end + 1);
  }

  return { text, signal };
};

const parseSignal = (payload: string): ArtifactProgressSignal | null => {
  try {
    const parsed = JSON.parse(payload) as Partial<ArtifactProgressSignal>;
    return parsed?.state === "generating" &&
      typeof parsed.format === "string" &&
      isSupportedArtifactFormat(parsed.format)
      ? { state: "generating", format: parsed.format }
      : null;
  } catch {
    return null;
  }
};
