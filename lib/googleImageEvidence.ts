// What the thinking-cap measurement is allowed to write down.
//
// Policy §12 step 8 asks the run to preserve five things as audit evidence:
// the request JSON, the raw response, the model ID, the response ID and the
// run timestamp. The measurement script recorded three of them. The two it
// dropped are the two a later reader would most want, because they are the
// only ones that let someone check the numbers instead of trusting them --
// and every sample is a paid image, so evidence missing at the end of a run
// has to be bought again.
//
// It dropped them for real reasons, and neither is solved by simply keeping
// the bytes:
//
//   * The request carries the prompt, and policy §10 keeps prompt text out of
//     anything we store. So the body is preserved exactly as sent with the
//     prompt replaced by a digest -- which is what makes two runs comparable
//     without either of them recording the text.
//   * The response carries a base64 image, often around a megabyte. It cannot
//     be audited as text, and pasting one into a ticket helps nobody. So image
//     data is replaced by a digest and a length, which still answers "was this
//     the same image?" and "was there an image at all?".
//
// Pure and injected rather than importing node:crypto, so both rules can be
// tested directly. The digest is the caller's.

export type ImageEvidenceDigest = (value: string) => string;

/**
 * Long enough that no field Google uses for prose reaches it, short enough
 * that no encoded payload slips under it. The named `data` field below is the
 * documented location; this is the backstop for the day it moves.
 */
const OPAQUE_STRING_LENGTH = 4_096;

const digestOf = (value: string, digest: ImageEvidenceDigest) =>
  `sha256:${digest(value)} (${value.length} chars)`;

/**
 * The request body as sent, with the prompt replaced by its digest.
 *
 * Everything else is kept verbatim, including the fields it would be tempting
 * to summarise. `max_output_tokens` is the whole subject of the measurement,
 * and `thinking_level` decides whether there was anything to measure; a
 * reconstruction of the body from the report's other fields would be a second
 * source of truth about what was sent, which is exactly what evidence is for
 * not having.
 */
export const redactGoogleImageRequestBody = (
  body: Record<string, unknown>,
  digest: ImageEvidenceDigest
): Record<string, unknown> => ({
  ...body,
  ...(typeof body.input === "string"
    ? { input: digestOf(body.input, digest) }
    : {}),
});

/**
 * The response as received, with image bytes replaced by a digest and a size.
 *
 * Two rules, because one of them is about a field that might move. Any value
 * under a `data` key is replaced -- that is where the Interactions API puts
 * inline image bytes -- and so is any string long enough that it cannot be
 * prose, wherever it appears. A schema change that relocated the payload would
 * otherwise write a megabyte of base64 into an evidence file that a person is
 * expected to read and attach to a ticket.
 *
 * Structure is preserved otherwise: step order, step types, the image's
 * `mime_type`, the usage counters and the finish reason all survive, and those
 * are the parts the verdict actually rests on.
 */
export const redactGoogleImageResponseBody = (
  payload: unknown,
  digest: ImageEvidenceDigest
): unknown => {
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") {
      return key === "data" || value.length > OPAQUE_STRING_LENGTH
        ? digestOf(value, digest)
        : value;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry, null));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([childKey, childValue]) => [childKey, walk(childValue, childKey)]
        )
      );
    }
    return value;
  };
  return walk(payload, null);
};
