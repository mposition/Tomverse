// The request-side price-selector guard, as a pure function.
//
// `scripts/check-model-pricing.mjs` greps the tree for the selector names and
// hands the matched lines to `auditProcessingTierMentions` below. Keeping the
// decision separate from the grep is what makes it testable: every interesting
// case is a file that should not be clean, and the real tree is supposed to be
// clean.
//
// The regex is exported so the test and the check cannot drift apart -- a
// guard whose test greps for something narrower than the guard does is a test
// that passes while the guard is blind.
export const PROCESSING_TIER_SELECTOR_PATTERN =
  "(service_tier|serviceTier|inference_geo|inferenceGeo)";

/** Re-indenting a line is not a change of meaning; its text is. */
const normalize = (line) => line.trim();

/**
 * @param {{
 *   matchedLines: readonly { file: string, text: string }[],
 *   allowlist: readonly {
 *     file: string,
 *     sendsATier: boolean,
 *     reason: string,
 *     mentions: readonly string[],
 *   }[],
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditProcessingTierMentions({ matchedLines, allowlist }) {
  const allowed = new Map(allowlist.map((entry) => [entry.file, entry]));
  const errors = [];

  /** file -> the normalized lines actually found in it. */
  const found = new Map();
  for (const { file, text } of matchedLines) {
    if (!found.has(file)) found.set(file, new Set());
    found.get(file).add(normalize(text));
  }

  for (const [file, lines] of found) {
    const entry = allowed.get(file);
    if (!entry) {
      errors.push(
        `${file} names a request-side price selector and is not in the allowlist.`,
      );
      continue;
    }
    if (entry.sendsATier) {
      errors.push(
        `${file} is allowlisted with sendsATier: true, which requires the pricing profiles for that tier in the same change.`,
      );
    }
    // The reason the allowlist is pinned line by line rather than by file
    // name. An entry used to exempt a whole file, so a file listed for reading
    // the tier off a response could later gain a line that *sets* one and the
    // check would say nothing. Each new line has to be read by a human and
    // added deliberately.
    const pinned = new Set(entry.mentions.map(normalize));
    for (const line of lines) {
      if (!pinned.has(line)) {
        errors.push(
          `${file} has a mention of a price selector that is not pinned in its allowlist entry: ${JSON.stringify(line)}. ` +
            `Read it, confirm it does not put a tier into an outbound request, and add it to that entry's mentions.`,
        );
      }
    }
  }

  // A stale pin is an error, not a warning. A pin for a line that is gone is a
  // licence nobody is reading, and at file granularity that is exactly how
  // app/api/chat/route.ts -- the file that actually builds the provider
  // request -- ended up exempt from the check that guards it.
  for (const entry of allowlist) {
    const lines = found.get(entry.file);
    if (!lines) {
      errors.push(
        `${entry.file} is allowlisted for naming a price selector but no longer names one. Remove the entry.`,
      );
      continue;
    }
    for (const mention of entry.mentions) {
      if (!lines.has(normalize(mention))) {
        errors.push(
          `${entry.file} pins a mention that is no longer in the file: ${JSON.stringify(normalize(mention))}. Remove the pin.`,
        );
      }
    }
  }

  return { errors };
}

/**
 * Source files allowed to name a request-side price selector, each pinned to
 * the exact lines it is allowed to name it on.
 *
 * The reasoning behind this list -- why `processingTier: "standard"` is a
 * claim about the request rather than a preference, and why `inference_geo` is
 * guarded alongside it -- is in lib/modelPricing.ts, next to the profiles that
 * depend on it. Only the data lives here, because only this check reads it.
 *
 * `sendsATier` is the field that matters: no entry may set it to `true`
 * without the pricing profiles that describe that tier landing in the same
 * change.
 *
 * @type {readonly {
 *   file: string,
 *   sendsATier: boolean,
 *   reason: string,
 *   mentions: readonly string[],
 * }[]}
 */
export const PROCESSING_TIER_REQUEST_ALLOWLIST = [
  {
    file: "scripts/check-openai-model-access.mjs",
    sendsATier: false,
    reason:
      "Reads `service_tier` off the response and reports it. Its own optional --invoke request sets none, which is the point: the tier a request is *served at* is the only evidence that the Standard table was the right one.",
    mentions: [
      "let serviceTier = null;",
      "// `service_tier` defaults to `auto`: the tier the response came back",
      "serviceTier = parsed?.service_tier ?? null;",
      "respondedServiceTier: serviceTier,",
      '? `ok  service_tier=${entry.respondedServiceTier ?? "not reported"}`',
    ],
  },
  {
    file: "lib/servedProcessingTier.ts",
    sendsATier: false,
    reason:
      "Classifies the tier a completed response reports, so a request served at a tier nobody priced is visible instead of silent. It reads provider metadata and returns a verdict and builds no request. app/api/chat/route.ts calls it once a stream has finished -- after the response exists, so it cannot influence the request it describes -- through an import that names no tier, which is why that file is deliberately not listed here.",
    mentions: [
      "// omitted `service_tier` as `auto`, and `auto` is free to serve a request at a",
      "// This file names `serviceTier` because it reads it off a response. It is in",
      "const value = (byProvider as Record<string, unknown>).serviceTier;",
    ],
  },
];
