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
 * The one request in the repository allowed to send a tier.
 *
 * The rule below exists because every lib/modelPricing.ts profile is a
 * Standard price, which is only true while no request selects a tier. The
 * marketing generator's adapter is not priced by those profiles at all: the
 * marketing LLM cost ledger prices each call from a person's price pin, which
 * records the worst rate across every tier, reserves that worst case before the
 * call, stores the tier the adapter is bound to send in each reservation's
 * config snapshot and keeps a call served at any other tier at its reservation
 * (docs/policy/marketing-automation.md §5; S3 plan §2 names `service_tier:
 * "default"` in the adapter's request allowlist).
 *
 * So exactly one line in exactly one file may send one, and only by naming the
 * ledger's own constant -- a literal, or any other value, is still an error.
 */
export const MARKETING_LEDGER_TIER_SENDER = Object.freeze({
  file: "lib/marketingLlmClientCore.ts",
  pricedBy: "marketing-llm-price-pins",
  line: "service_tier: MARKETING_LLM_SERVICE_TIER,",
});

const isMarketingLedgerTierSender = (entry) =>
  entry.file === MARKETING_LEDGER_TIER_SENDER.file &&
  entry.pricedBy === MARKETING_LEDGER_TIER_SENDER.pricedBy &&
  Array.isArray(entry.sends) &&
  entry.sends.length === 1 &&
  normalize(entry.sends[0]) === MARKETING_LEDGER_TIER_SENDER.line &&
  entry.mentions.map(normalize).includes(MARKETING_LEDGER_TIER_SENDER.line);

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
    if (entry.sendsATier && !isMarketingLedgerTierSender(entry)) {
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
 * change. The one exception is MARKETING_LEDGER_TIER_SENDER above, which is
 * priced by the marketing ledger's pins rather than by those profiles.
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
    file: "lib/marketingLlmClientCore.ts",
    sendsATier: true,
    pricedBy: "marketing-llm-price-pins",
    sends: ["service_tier: MARKETING_LLM_SERVICE_TIER,"],
    reason:
      "The marketing generator's adapter sends the ledger's tier (`default`) in its one provider request, as S3 plan §2's request allowlist requires; the call is priced by the person-set price pin's worst rate across tiers, never by lib/modelPricing.ts, and the reservation's config snapshot records the tier so a call served at another one is kept at its reservation. The other lines read the served tier off the response and pass it to the ledger.",
    mentions: [
      "service_tier: MARKETING_LLM_SERVICE_TIER,",
      "readonly serviceTier: string;",
      "service_tier?: unknown;",
      "typeof root.service_tier !== \"string\" ||",
      "return { content, model: root.model, serviceTier: root.service_tier, inputTokens, outputTokens };",
      "reportedServiceTier: answer.serviceTier,",
    ],
  },
  {
    file: "lib/marketingLlmBudgetCore.ts",
    sendsATier: false,
    reason:
      "The marketing LLM cost ledger records, in each reservation's immutable config snapshot and in the adapter digest, the tier the generator's adapter is bound to send (`default`, Standard price), so a call billed under another tier is detected and kept at its reservation. The module builds no request and calls no provider; the marketing ledger is priced from its own pins, not lib/modelPricing.ts. These three lines are pinned, not the whole file.",
    mentions: [
      "serviceTier: typeof MARKETING_LLM_SERVICE_TIER;",
      "serviceTier: MARKETING_LLM_SERVICE_TIER,",
      "serviceTier: snapshot.serviceTier,",
    ],
  },
  {
    file: "lib/agentPushPolicy.ts",
    sendsATier: false,
    reason:
      "The engineering agent's push policy lists names whose values AGENTS.md reserves for a person, and raises a change that adds one to tier two. The selector is one of those names, matched in the agent's patch text. The module builds no request and calls no provider; this exact pattern line is pinned, not the whole file.",
    mentions: [
      "/\\bservice_tier\\b/,",
    ],
  },
  {
    file: "lib/routerDevelopmentCollectorProvider.ts",
    sendsATier: false,
    reason:
      "Reads only the returned body to flag a served tier outside the frozen Standard-price assumption. The development collector sets no outbound price selector; this exact observation line is pinned, not the whole file.",
    mentions: [
      "observation.servedProcessingTier = label(root.service_tier ?? usage.service_tier ?? record(root.usageMetadata).serviceTier);",
    ],
  },
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
    file: "scripts/report-anthropic-cache-efficiency-core.mjs",
    sendsATier: false,
    reason:
      "Reads `service_tier`, `inference_geo` and `speed` off the Usage API's *report* and uses them to decide which rows this registry can price. It builds no Messages API request at all -- the only URL it constructs is a read of GET /v1/organizations/usage_report/messages, where `group_by[]` is what makes each field come back rather than null. A report that priced rows without asking for the tier would rate a batch row at Standard without ever seeing that it was batch; the same argument put `inference_geo` in the base group-by, since `us` costs 1.1x on every token category. `speed` is opt-in there because its group-by needs a beta header.",
    mentions: [
      "* price: `service_tier` must be `standard`, and `speed` must be `standard` or",
      "SERVICE_TIER: \"service_tier_not_standard\",",
      "INFERENCE_GEO: \"inference_geo_not_global\",",
      "INFERENCE_GEO_UNKNOWN: \"inference_geo_not_reported\",",
      "\"service_tier\",",
      "// Grouped from the start rather than on request. `inference_geo: \"us\"`",
      "\"inference_geo\",",
      "// without asking for `service_tier` would be pricing rows it could not see",
      "serviceTier:",
      "typeof result.service_tier === \"string\"",
      "? result.service_tier",
      "inferenceGeo:",
      "typeof result.inference_geo === \"string\"",
      "? result.inference_geo",
      "if (row.serviceTier !== null && row.serviceTier !== \"standard\") {",
      "// `inference_geo`, handled by value rather than by \"is it global\".",
      "if (row.inferenceGeo === \"us\") {",
      "if (row.inferenceGeo === null) {",
      "if (row.inferenceGeo !== \"global\" && row.inferenceGeo !== \"not_available\") {",
      "serviceTier: row.serviceTier,",
      "inferenceGeo: row.inferenceGeo,",
    ],
  },
  {
    file: "scripts/report-anthropic-cache-efficiency.mjs",
    sendsATier: false,
    reason:
      "The runner for the module above. It names the grouping dimensions it asked the Usage API for, sends the fast-mode beta header exactly when it groups by `speed`, and renders the tier or geo of a row it refused to price. All read-side; none of it reaches a Messages API request, which this script never makes.",
    mentions: [
      "? `service_tier=${entry.serviceTier}`",
      "? `inference_geo=${entry.inferenceGeo} (1.1x on every token category; no verified rate here)`",
      "? \"inference_geo was grouped but not reported, so the multiplier is unknown\"",
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
