// The request-side price-selector guard, as a pure function.
//
// `scripts/check-model-pricing.mjs` greps the tree for the selector names and
// hands the matched paths to `auditProcessingTierMentions` below. Keeping the
// decision separate from the grep is what makes it testable: the interesting
// cases are "a request-building file gained a selector" and "an exemption
// outlived the mention it was written for", and neither can be exercised by
// running the real check against the real tree, because the real tree is
// supposed to be clean.
//
// The regex is exported so the test and the check cannot drift apart -- a
// guard whose test greps for something narrower than the guard does is a test
// that passes while the guard is blind.
export const PROCESSING_TIER_SELECTOR_PATTERN =
  "(service_tier|serviceTier|inference_geo|inferenceGeo)";

/**
 * @param {{
 *   matchedFiles: readonly string[],
 *   allowlist: readonly { file: string, sendsATier: boolean, reason: string }[],
 * }} input
 * @returns {{ errors: string[] }}
 */
export function auditProcessingTierMentions({ matchedFiles, allowlist }) {
  const allowed = new Map(allowlist.map((entry) => [entry.file, entry]));
  const matched = new Set(matchedFiles);
  const errors = [];

  for (const file of matchedFiles) {
    const entry = allowed.get(file);
    if (!entry) {
      errors.push(
        `${file} names a request-side price selector and is not in the allowlist.`
      );
      continue;
    }
    if (entry.sendsATier) {
      errors.push(
        `${file} is allowlisted with sendsATier: true, which requires the pricing profiles for that tier in the same change.`
      );
    }
  }

  // A stale entry is an error, not a warning. The exemption covers the whole
  // file, so once the mention it was written for is gone the entry is a
  // standing licence for a selector nobody has reviewed -- which is how
  // app/api/chat/route.ts, the file that actually builds the provider request,
  // ended up exempt from the check that guards it.
  for (const entry of allowlist) {
    if (!matched.has(entry.file)) {
      errors.push(
        `${entry.file} is allowlisted for naming a price selector but no longer names one. ` +
          `Remove the entry: it exempts the whole file, so leaving it in place waves through ` +
          `a selector added to that file later.`
      );
    }
  }

  return { errors };
}
