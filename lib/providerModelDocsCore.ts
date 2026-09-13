/**
 * What a provider's own documentation says about a model, read from the
 * markdown the provider publishes for machines.
 *
 * ## Why this exists
 *
 * The models APIs do not carry most of what an adoption needs. OpenAI's
 * `GET /v1/models` answers `{id, owned_by}` and nothing else, and neither
 * OpenAI nor Anthropic prices a model in its models API at all. The numbers
 * are public -- on documentation pages -- so an operator adopting GPT-6 Astra
 * was retyping a context window, an output ceiling and four prices off a web
 * page that a request could have read.
 *
 * ## What this module promises
 *
 * Pure parsing of documents already fetched. Nothing here fetches, stores or
 * decides anything about the registry; `lib/providerModelDocEvidence.ts` does
 * the I/O and `lib/modelAdoptionDraft.ts` decides what a parse may fill in.
 *
 * Every parser fails closed. A page whose structure has moved is a page whose
 * numbers cannot be trusted, and the answer to that is a named problem --
 * never a best guess, because a guessed price is an override written into a
 * column that bills every request. A problem anywhere in a parse withholds its
 * price, and the daily report prints it.
 *
 * ## Not a price source
 *
 * `lib/modelPricing.ts` is the only price source (docs/policy/credit-and-cost-limits.md
 * §3). What this reads is *evidence*: shown to the operator with where it came
 * from, used to prefill a form they confirm, and turned into a profile
 * proposal a person commits. It is never applied to a live request on its own.
 */

/** Bumped whenever a parser's reading of a document changes. Stored with every row. */
export const PROVIDER_MODEL_DOC_PARSER_VERSION = "2026-09-13.5";

/**
 * How old evidence may be and still prefill anything.
 *
 * The read is daily. A day and a half allows one late run; beyond that the
 * row describes a price the provider may since have changed, and a stale low
 * price prefilled into an override column bills every request at it. Old
 * evidence is shown as old and fills nothing.
 */
export const DOC_EVIDENCE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export const PROVIDER_MODEL_DOC_EVIDENCE_STATUSES = [
  "parsed",
  "not_found",
  "fetch_failed",
  "parse_failed",
] as const;
export type ProviderModelDocEvidenceStatus =
  (typeof PROVIDER_MODEL_DOC_EVIDENCE_STATUSES)[number];

export type ProviderModelDocEvidenceSummary = {
  attempted: number;
  byStatus: Record<ProviderModelDocEvidenceStatus, number>;
  /** Parsed, but with at least one named problem -- counted apart from a clean parse. */
  degraded: number;
  /** One entry per read that did not parse cleanly, for the daily report. */
  failures: Array<{ provider: string; apiModel: string; status: string; problems: string[] }>;
  /** Queued models this run did not reach: over the per-provider cap or past the time budget. */
  notAttempted: Array<{ provider: string; apiModel: string; reason: "cap" | "time_budget" }>;
  /**
   * Promotion sentences on a pricing page that are not in
   * ACKNOWLEDGED_PROMOTION_SENTENCES. Each one withholds every price that page
   * supplies until somebody reads it and records what it applies to.
   */
  unacknowledgedNotices: Array<{ provider: string; sentence: string }>;
};

/**
 * The documentation read, as the daily report states it.
 *
 * A read that failed is printed, not only counted -- and so is one that parsed
 * with a problem. Fail-closed means the adoption form quietly stops
 * prefilling a price, and the only place anybody learns that a provider moved
 * its page is here: a "parsed 12/12" over twelve rows that each refused their
 * price would be the silent failure fail-closed was supposed to make visible.
 */
export const docEvidenceReportLines = (
  summary: ProviderModelDocEvidenceSummary | undefined
) => {
  if (!summary) {
    return { summary: " · docs read failed", failures: ["• Provider documentation: read did not run (see logs)"] };
  }
  if (summary.attempted === 0 && summary.notAttempted.length === 0 && summary.unacknowledgedNotices.length === 0) {
    return { summary: "", failures: [] };
  }
  const clean = summary.byStatus.parsed - summary.degraded;
  return {
    summary: ` · docs clean ${clean}/${summary.attempted}${
      summary.notAttempted.length ? ` · docs not read ${summary.notAttempted.length}` : ""
    }`,
    failures: [
      ...summary.failures.map(
        (failure) =>
          `• ${failure.provider} docs \`${failure.apiModel}\`: ${failure.status}${
            failure.problems.length ? ` (${failure.problems.slice(0, 3).join(", ")})` : ""
          }`
      ),
      ...summary.unacknowledgedNotices.map(
        (notice) =>
          `• ${notice.provider} pricing page: unreviewed promotion sentence withholds every documented price -- "${notice.sentence.slice(0, 160)}"`
      ),
      ...(summary.notAttempted.length
        ? [
            `• Provider documentation not read this run (${summary.notAttempted
              .map((item) => `${item.provider} \`${item.apiModel}\`: ${item.reason}`)
              .slice(0, 5)
              .join(", ")}${summary.notAttempted.length > 5 ? ", …" : ""})`,
          ]
        : []),
    ],
  };
};

/**
 * The documentation read for one provider, as a note on that provider's row of
 * the daily email. The email renders a fixed set of per-provider fields; a
 * note is the one that already exists, so a read that failed for OpenAI
 * appears on OpenAI's row rather than nowhere.
 */
export const docEvidenceProviderNote = (
  summary: ProviderModelDocEvidenceSummary | undefined | null,
  provider: string
) => {
  if (summary === null || !(PROVIDER_MODEL_DOC_PROVIDERS as readonly string[]).includes(provider)) {
    return null;
  }
  if (summary === undefined) return "documentation read did not run";
  const failures = summary.failures.filter((failure) => failure.provider === provider);
  const unread = summary.notAttempted.filter((item) => item.provider === provider);
  const parts = [
    failures.length
      ? `documentation: ${failures
          .slice(0, 3)
          .map((failure) => `${failure.apiModel} ${failure.status}${failure.problems.length ? ` (${failure.problems.slice(0, 2).join(", ")})` : ""}`)
          .join("; ")}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ""}`
      : null,
    unread.length ? `documentation not read for ${unread.length} queued model(s)` : null,
    summary.unacknowledgedNotices.some((notice) => notice.provider === provider)
      ? "unreviewed promotion sentence on the pricing page; no documented price used"
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
};

/** Providers whose documentation this module can read. Everyone else has no evidence. */
export const PROVIDER_MODEL_DOC_PROVIDERS = ["openai", "anthropic"] as const;
export type ProviderModelDocProvider = (typeof PROVIDER_MODEL_DOC_PROVIDERS)[number];

export const OPENAI_PRICING_MARKDOWN_URL =
  "https://developers.openai.com/api/docs/pricing.md";
export const ANTHROPIC_PRICING_MARKDOWN_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing.md";
export const openAiModelMarkdownUrl = (apiModel: string) =>
  `https://developers.openai.com/api/docs/models/${encodeURIComponent(apiModel)}.md`;

/**
 * How a model's price moves with prompt size.
 *
 * `flat` is a positive statement, not an absence: OpenAI's pricing table
 * printing `-` in every long-context column, or Anthropic saying in words
 * that a model family bills its whole window at the standard rate. `unknown`
 * is everything else, and it is the answer that keeps a price out of an
 * override column -- a flat override on a tiered model under-bills every
 * request above the threshold, silently, which is the first of the three
 * failures docs/policy/credit-and-cost-limits.md §3 records.
 */
export type DocLongContext =
  | { kind: "flat" }
  | {
      kind: "tiered";
      thresholdTokens: number;
      inputMultiplier: number;
      outputMultiplier: number;
      /**
       * Whether cache rates take the input multiplier above the threshold --
       * stated on the model page, or shown by the pricing table's own
       * long-context cache cells.
       */
      cacheTakesInputMultiplier: boolean;
    }
  | { kind: "unknown" };

export type ProviderModelDocFields = {
  displayName: string | null;
  contextWindowTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  imageInput: boolean | null;
  /** Standard processing, short context, USD per million tokens. */
  inputUsdPerMillionTokens: number | null;
  cachedInputUsdPerMillionTokens: number | null;
  cacheWriteUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  longContext: DocLongContext;
  /**
   * The documentation calls the price promotional or introductory. Kept apart
   * because such a price will end: `lib/modelPricing.ts` keeps GPT-5.6 Sol at
   * its list price while its model page advertises a promotion, and a parse
   * that silently took the promotional figure would turn that decision around.
   */
  promotional: { note: string } | null;
};

export type ProviderModelDocParse =
  | { status: "parsed"; fields: ProviderModelDocFields; problems: string[] }
  | { status: "not_found" | "parse_failed"; fields: null; problems: string[] };

const emptyFields = (): ProviderModelDocFields => ({
  displayName: null,
  contextWindowTokens: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  imageInput: null,
  inputUsdPerMillionTokens: null,
  cachedInputUsdPerMillionTokens: null,
  cacheWriteUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: null,
  longContext: { kind: "unknown" },
  promotional: null,
});

/**
 * Wording that marks a price as one that will end. Matching wrongly only
 * withholds a price.
 *
 * Deliberately not complete, and not the control: no word list catches every
 * way a provider can say a price is temporary. What stands between a
 * documented price and a live request is the operator confirming the price
 * against its source before the save, and the lifecycle's pricing validation
 * before the rollout. This list is the early warning that withholds the
 * prefill when the wording is recognisable.
 *
 * "discount" is left out on purpose: the pricing pages use it for batch,
 * volume and private-offer terms that are not the standard price at all, and
 * listing it would block every page until each of those sentences was
 * acknowledged.
 */
const PROMOTION_WORDS =
  /promotional|introductory|limited[- ]time|temporar|special (?:launch )?(?:rate|price|pricing)|launch (?:rate|price|pricing)|(?:through|until|ends?|expires?) (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The page's prose as paragraphs, soft line breaks joined. A promotion and the
 * model it applies to are often on different physical lines of one sentence,
 * and matching line by line let a formatter's wrap undo the check.
 */
const paragraphs = (markdown: string) =>
  markdown
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        // A list bullet or a quote marker is formatting, not part of the
        // sentence: the same acknowledged sentence moved into a bullet is
        // still the sentence somebody read.
        .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|>)\s+/, ""))
        .join("\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s*\n\s*/g, " ")
        .trim()
    )
    .filter(Boolean);

/**
 * Promotion sentences a person has read, with the models each one is about.
 *
 * Why a list and not matching the sentence to the model it names: which model
 * a promotion applies to is a question about prose, and every rule for it has
 * a gap -- the name in the previous paragraph, under a heading, or a whole
 * family ("Claude 5.1 models") named instead of a model. Each gap reads as
 * "no promotion" and prefills a price that will end. So the rule is the
 * fail-closed one: **any promotion sentence on a pricing page that is not on
 * this list withholds every price that page supplies**, and the daily report
 * names the sentence so somebody reads it and adds it here with what it
 * applies to.
 *
 * Matched by exact text, whitespace normalised. A sentence that changes by a
 * word is a sentence nobody has read.
 */
export const ACKNOWLEDGED_PROMOTION_SENTENCES: ReadonlyArray<{
  provider: ProviderModelDocProvider;
  sentence: string;
  /** Model ids (OpenAI) or display names (Anthropic) whose price the sentence makes promotional. */
  appliesTo: readonly string[];
  reviewedOn: string;
  reason: string;
}> = [
  {
    provider: "anthropic",
    sentence:
      "The $2/$10 per million input/output token pricing for Claude Sonnet 5, announced at launch as introductory pricing through August 31, 2026, is now the standard price.",
    appliesTo: [],
    reviewedOn: "2026-09-13",
    reason:
      "Claude Sonnet 5's introductory price became its standard price and the September increase was cancelled; AGENTS.md records the same notice. Nothing on the page is promotional because of it.",
  },
  {
    provider: "openai",
    sentence: "GPT-5.6 Sol’s promotional pricing is available at least through November 21, 2026.",
    appliesTo: ["gpt-5.6-sol"],
    reviewedOn: "2026-09-13",
    reason:
      "An active promotion for GPT-5.6 Sol alone. lib/modelPricing.ts keeps Sol at its list price; no other model on the page is affected.",
  },
];

/** Every sentence on a page that speaks of a promotional price. */
const promotionSentences = (markdown: string) =>
  paragraphs(markdown)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => PROMOTION_WORDS.test(sentence));

/**
 * A pricing page's promotion sentences, sorted into the ones nobody has read
 * (which block the page) and the models the read ones apply to.
 */
export const promotionNotices = (provider: ProviderModelDocProvider, markdown: string) => {
  const acknowledged = ACKNOWLEDGED_PROMOTION_SENTENCES.filter((entry) => entry.provider === provider);
  const unacknowledged: string[] = [];
  const promoted = new Map<string, string>();
  for (const sentence of promotionSentences(markdown)) {
    const known = acknowledged.find((entry) => entry.sentence === sentence);
    if (!known) {
      unacknowledged.push(sentence);
      continue;
    }
    for (const model of known.appliesTo) promoted.set(model, sentence);
  }
  return { unacknowledged, promoted };
};

const tokenCount = (text: string | undefined) => {
  if (!text) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** `$10`, `$0.175`, `$12.50 / MTok`, `$0.25 / MTok1` (a footnote marker). */
const dollars = (cell: string | undefined, unit: "plain" | "mtok") => {
  if (!cell) return null;
  const trimmed = cell.trim();
  const pattern =
    unit === "mtok" ? /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok(\d*)$/ : /^\$(\d+(?:\.\d+)?)$/;
  const match = trimmed.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/** Rows of the first markdown table after `start`, header and separator dropped. */
const tableAfter = (markdown: string, start: number) => {
  const lines = markdown.slice(start).split("\n");
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = line.trim().startsWith("|");
    if (!isRow) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
    );
  }
  if (rows.length < 2) return null;
  return { header: rows[0], body: rows.slice(2) };
};

/** The text of one `##`/`###` section, up to the next heading of the same or higher level. */
const section = (markdown: string, heading: RegExp) => {
  const match = markdown.match(heading);
  if (!match || match.index === undefined) return null;
  const level = match[0].match(/^#+/)?.[0].length ?? 2;
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
};

const LONG_CONTEXT_RULE =
  /Prompts with (?:more than |>\s*)(\d+)K input tokens are priced at (\d+(?:\.\d+)?)x input( and cache rates)? and (\d+(?:\.\d+)?)x output/i;

type OpenAiRates = {
  input: number | null;
  cached: number | null;
  cacheWrite: number | null;
  output: number | null;
};

export type OpenAiPricingRow = {
  short: OpenAiRates;
  long: OpenAiRates;
  /** A cell that was neither `-` nor a dollar amount. */
  unreadable: boolean;
  thresholdTokens: number | null;
};

/**
 * OpenAI's standard pricing table: every model's short and long context rates.
 *
 * Read from the `Standard pricing data` section only. The page also carries
 * Batch, Flex and Fast tables with the same columns and different numbers,
 * and Tomverse sends no processing tier (docs/policy/credit-and-cost-limits.md
 * §3), so the standard row is the only one that describes what we are billed.
 *
 * Also collects every line on the page that calls a price promotional, so a
 * promotion announced on the pricing page and not on the model page still
 * withholds that model's price.
 */
export const parseOpenAiStandardPricingTable = (markdown: string) => {
  const notices = promotionNotices("openai", markdown);
  const heading = markdown.search(/^### Standard pricing data\s*$/m);
  if (heading === -1) return { rows: null, notices, duplicates: new Set<string>(), problems: ["standard_table_missing"] };
  const table = tableAfter(markdown, heading);
  const expected = [
    "Model",
    "Short context input",
    "Short context cached input",
    "Short context cache writes",
    "Short context output",
    "Long context input",
    "Long context cached input",
    "Long context cache writes",
    "Long context output",
  ];
  if (!table || table.header.join("|") !== expected.join("|")) {
    return { rows: null, notices, duplicates: new Set<string>(), problems: ["standard_table_shape_changed"] };
  }
  const rows = new Map<string, OpenAiPricingRow>();
  // Two rows that name the same model are a contradiction the table cannot
  // settle, and keeping whichever came last would let the second silently win.
  const duplicates = new Set<string>();
  for (const cells of table.body) {
    // A row of the wrong width is a row this parser cannot place, and skipping
    // it would let a correct row for a model disappear while a wrong one for
    // the same model stayed. The whole table is refused.
    if (cells.length !== expected.length) {
      return { rows: null, notices, duplicates, problems: ["standard_table_row_malformed"] };
    }
    const [name, ...prices] = cells;
    const threshold = name.match(/\(<(\d+)K context length\)/);
    const model = name.replace(/\s*\(.*\)\s*$/, "").trim();
    if (rows.has(model)) duplicates.add(model);
    let unreadable = false;
    const cell = (value: string) => {
      if (value === "-") return null;
      const parsed = dollars(value, "plain");
      if (parsed === null) unreadable = true;
      return parsed;
    };
    rows.set(model, {
      short: { input: cell(prices[0]), cached: cell(prices[1]), cacheWrite: cell(prices[2]), output: cell(prices[3]) },
      long: { input: cell(prices[4]), cached: cell(prices[5]), cacheWrite: cell(prices[6]), output: cell(prices[7]) },
      unreadable,
      thresholdTokens: threshold ? Number(threshold[1]) * 1000 : null,
    });
  }
  return { rows, notices, duplicates, problems: rows.size ? [] : ["standard_table_empty"] };
};

/**
 * One OpenAI model page (`/api/docs/models/<id>.md`), cross-checked against
 * the standard pricing table.
 *
 * The model page is the source for everything the models API leaves out:
 * context window, input and output ceilings, modalities, the four token
 * prices and the long-context rule. The pricing table is read beside it and
 * has to agree on every rate both documents carry, short and long context:
 *
 *   - no table, no row, or a cell that is neither `-` nor a price is a problem;
 *   - a rate one document states and the other does not is a problem;
 *   - two rates that differ are a problem;
 *   - a tiered rule has to match the table's long-context cells, and "flat"
 *     needs the table's long-context cells to be `-`.
 *
 * Agreement is how a moved cell or a truncated number is caught before it
 * becomes an override: the same error in two independently maintained
 * documents is the unlikely case.
 */
export const parseOpenAiModelPage = (input: {
  apiModel: string;
  modelPage: string;
  pricingTable: ReturnType<typeof parseOpenAiStandardPricingTable> | null;
}): ProviderModelDocParse => {
  const page = input.modelPage;
  const problems: string[] = [];
  const idPattern = escapeRegExp(input.apiModel);
  // The page names its own id twice; either proves this is the page asked for
  // and not a redirect to a family overview.
  if (
    !new RegExp(`^Model ID: \`${idPattern}\``, "m").test(page) &&
    !new RegExp(`^- Default snapshot: \`${idPattern}\``, "m").test(page)
  ) {
    return { status: "parse_failed", fields: null, problems: ["model_id_not_on_page"] };
  }

  const fields = emptyFields();
  fields.displayName = page.match(/^# (.+)$/m)?.[1]?.trim() ?? null;

  const details = section(page, /^## Model details\s*$/m);
  if (!details) problems.push("model_details_missing");
  else {
    const modalities = details.match(/^- Input modalities: (.+)$/m)?.[1]?.trim();
    // A list this parser can read, or no answer. "text and image" read as a
    // comma list is ["text and image"], which contains no "image" -- and an
    // image model saved as image-blind.
    if (modalities === undefined) fields.imageInput = null;
    else if (/^[a-z]+(?:, [a-z]+)*$/i.test(modalities)) {
      fields.imageInput = modalities.split(", ").map((value) => value.toLowerCase()).includes("image");
    } else problems.push("input_modalities_unreadable");
    fields.contextWindowTokens = tokenCount(details.match(/^- ([\d,]+) context window$/m)?.[1]);
    fields.maxInputTokens = tokenCount(details.match(/^- Maximum input tokens: ([\d,]+)$/m)?.[1]);
    fields.maxOutputTokens = tokenCount(details.match(/^- ([\d,]+) max output tokens$/m)?.[1]);
  }

  // Anywhere on the page, not only the price section: a promotion announced in
  // the introduction is still a price that will end.
  // The model's own page is about this model alone, so any promotion sentence
  // on it is this model's. The pricing page is about every model: a sentence
  // nobody has read blocks all of them, and a read one marks the models it
  // names.
  const ownPromotion = promotionSentences(page)[0];
  const tablePromotion = input.pricingTable?.notices.promoted.get(input.apiModel);
  const promotionNote = ownPromotion ?? tablePromotion;
  if (promotionNote) fields.promotional = { note: promotionNote.replace(/^-\s*/, "").trim() };
  if (input.pricingTable?.notices.unacknowledged.length) {
    problems.push("unacknowledged_promotion_notice_on_pricing_page");
  }

  const textTokens = section(page, /^### Text tokens\s*$/m);
  if (!textTokens) {
    problems.push("text_token_prices_missing");
    return { status: "parsed", fields, problems };
  }
  const table = tableAfter(textTokens, 0);
  if (!table || table.header.join("|") !== "Metric|Price|Unit") {
    problems.push("text_token_table_shape_changed");
  } else {
    const price = (metric: string) => {
      const row = table.body.find((cells) => cells[0] === metric);
      if (!row) return null;
      if (row[2] !== "1M tokens") {
        problems.push(`unit_changed:${metric}`);
        return null;
      }
      const value = dollars(row[1], "plain");
      if (value === null) problems.push(`price_unreadable:${metric}`);
      return value;
    };
    fields.inputUsdPerMillionTokens = price("Input");
    fields.cachedInputUsdPerMillionTokens = price("Cached input");
    fields.cacheWriteUsdPerMillionTokens = price("Cache writes");
    fields.outputUsdPerMillionTokens = price("Output");
  }

  const rule = textTokens.match(LONG_CONTEXT_RULE);
  const mentionsPromptSize = /Prompts with|input tokens are priced/i.test(textTokens);
  if (rule) {
    fields.longContext = {
      kind: "tiered",
      thresholdTokens: Number(rule[1]) * 1000,
      inputMultiplier: Number(rule[2]),
      outputMultiplier: Number(rule[4]),
      cacheTakesInputMultiplier: Boolean(rule[3]),
    };
  } else if (mentionsPromptSize) {
    // A sentence about prompt size this parser cannot read is the one case
    // where guessing "flat" is most likely to be wrong.
    problems.push("long_context_rule_unreadable");
  }

  if (!input.pricingTable?.rows) {
    problems.push("pricing_table_unavailable");
    return { status: "parsed", fields, problems };
  }
  const row = input.pricingTable.rows.get(input.apiModel);
  if (!row) {
    problems.push("model_not_in_pricing_table");
    return { status: "parsed", fields, problems };
  }
  if (row.unreadable) problems.push("pricing_table_cell_unreadable");
  if (input.pricingTable.duplicates.has(input.apiModel)) problems.push("pricing_table_duplicate_row");

  const agree = (metric: string, a: number | null, b: number | null) => {
    if (a === null && b === null) return;
    if (a === null || b === null || !close(a, b)) problems.push(`price_disagrees_with_pricing_table:${metric}`);
  };
  agree("input", fields.inputUsdPerMillionTokens, row.short.input);
  agree("cached_input", fields.cachedInputUsdPerMillionTokens, row.short.cached);
  agree("cache_writes", fields.cacheWriteUsdPerMillionTokens, row.short.cacheWrite);
  agree("output", fields.outputUsdPerMillionTokens, row.short.output);

  const longEmpty = Object.values(row.long).every((value) => value === null);
  if (fields.longContext.kind === "tiered") {
    const lc = fields.longContext;
    if (row.thresholdTokens !== null && row.thresholdTokens !== lc.thresholdTokens) {
      problems.push("long_context_threshold_disagrees");
    }
    const scaled = (value: number | null, multiplier: number) =>
      value === null ? null : value * multiplier;
    agree("long_input", scaled(row.short.input, lc.inputMultiplier), row.long.input);
    agree("long_output", scaled(row.short.output, lc.outputMultiplier), row.long.output);
    // The table's own long-context cache cells show whether cache rates take
    // the input multiplier; a page that is silent about it is settled by them,
    // and cells that fit neither reading are a problem.
    const cacheCells: Array<[string, number | null, number | null]> = [
      ["long_cached_input", row.short.cached, row.long.cached],
      ["long_cache_writes", row.short.cacheWrite, row.long.cacheWrite],
    ];
    let cacheScales = true;
    for (const [metric, short, long] of cacheCells) {
      if (short === null && long === null) continue;
      if (short === null || long === null) {
        problems.push(`price_disagrees_with_pricing_table:${metric}`);
        cacheScales = false;
      } else if (close(short * lc.inputMultiplier, long)) {
        continue;
      } else {
        problems.push(`price_disagrees_with_pricing_table:${metric}`);
        cacheScales = false;
      }
    }
    fields.longContext = { ...lc, cacheTakesInputMultiplier: lc.cacheTakesInputMultiplier || cacheScales };
  } else if (!mentionsPromptSize) {
    if (longEmpty) fields.longContext = { kind: "flat" };
    else problems.push("long_context_columns_populated_without_rule");
  }

  return { status: "parsed", fields, problems };
};

export type AnthropicPricingPage = {
  rows: Map<string, { fields: ProviderModelDocFields; problems: string[] }> | null;
  problems: string[];
};

/**
 * Anthropic's pricing page: the `Model pricing` table, looked up by the
 * display name the models API returns (`Claude Fable 5.1`).
 *
 * Only that first table. The page carries a batch table further down with the
 * same model names at half the price, and a row matched there would be an
 * override billing every request at the batch rate.
 *
 * One document, so the check is internal: the page states its own ratios --
 * a five-minute cache write at 1.25x the base input price, an hour's at 2x, a
 * cache hit at 0.1x except where a footnote names another multiplier -- and a
 * row whose cells break them is a row whose numbers moved.
 *
 * Context window, output ceiling and image input are not read here: Anthropic's
 * models API already returns them, and a second source for the same number is
 * a conflict waiting to be resolved by whoever reads it last.
 *
 * "Flat" comes from the long-context section's own sentence -- that Claude
 * models from a stated version on bill the full window at standard pricing --
 * applied only to rows whose version the name states and which meet it.
 */
export const parseAnthropicPricingPage = (markdown: string): AnthropicPricingPage => {
  const problems: string[] = [];
  const modelPricing = section(markdown, /^## Model pricing\s*$/m);
  const table = modelPricing ? tableAfter(modelPricing, 0) : null;
  const expected = [
    "Model",
    "Base input tokens",
    "5m cache writes",
    "1h cache writes",
    "Cache hits and refreshes",
    "Output tokens",
  ];
  if (!table || table.header.join("|") !== expected.join("|")) {
    return { rows: null, problems: ["model_pricing_table_shape_changed"] };
  }

  const longContext = section(markdown, /^### Long context pricing\s*$/m) ?? "";
  const flatFrom = longContext.match(
    /Claude (\d+)\.(\d+) and later models[\s\S]*?context window\]\([^)]*\) at standard pricing/
  );
  if (!flatFrom) problems.push("long_context_statement_unreadable");

  // `*1 Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are
  // priced at 0.025x the base input price.`
  const cacheHitFootnotes = new Map<string, { names: string[]; multiplier: number }>();
  for (const match of (modelPricing ?? "").matchAll(
    /^\*(\d+) Cache hits and refreshes on (.+?) are priced at (\d+(?:\.\d+)?)x the base input price/gm
  )) {
    cacheHitFootnotes.set(match[1], {
      names: match[2].split(/,\s*|\s+and\s+/).map((name) => name.trim()).filter(Boolean),
      multiplier: Number(match[3]),
    });
  }
  const notices = promotionNotices("anthropic", markdown);
  if (notices.unacknowledged.length) problems.push("unacknowledged_promotion_notice");

  // The batch table, as an independent statement of every model's input and
  // output price: the page says batch is "a 50% discount on both input and
  // output tokens". The output price is the one the standard table's own
  // ratios do not tie to anything else, and a row whose output cell lost a
  // digit would otherwise sail through into an override.
  const batchSection = section(markdown, /^### Batch processing\s*$/m) ?? "";
  const batchDiscount = /50% discount on both input and output tokens/.test(batchSection);
  if (!batchDiscount) problems.push("batch_discount_statement_unreadable");
  const batchTable = batchSection ? tableAfter(batchSection, 0) : null;
  const batchRows = new Map<string, { input: number | null; output: number | null }>();
  const batchDuplicates = new Set<string>();
  if (!batchTable || batchTable.header.join("|") !== "Model|Batch input|Batch output") {
    problems.push("batch_table_shape_changed");
  } else {
    for (const cells of batchTable.body) {
      if (cells.length !== 3) {
        problems.push("batch_table_row_malformed");
        continue;
      }
      const name = cells[0]
        .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .trim();
      const plain = (value: string) => (/MTok\d+$/.test(value.trim()) ? null : dollars(value, "mtok"));
      if (batchRows.has(name)) batchDuplicates.add(name);
      batchRows.set(name, { input: plain(cells[1]), output: plain(cells[2]) });
    }
  }

  const rows = new Map<string, { fields: ProviderModelDocFields; problems: string[] }>();
  const duplicates = new Set<string>();
  for (const cells of table.body) {
    if (cells.length !== expected.length) {
      return { rows: null, problems: ["model_pricing_table_row_malformed"] };
    }
    const name = cells[0]
      .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    const rowProblems: string[] = [];
    const fields = emptyFields();
    fields.displayName = name;
    const mtok = (value: string, column: string) => {
      const parsed = dollars(value, "mtok");
      if (parsed === null) rowProblems.push(`price_unreadable:${column}`);
      // A footnote marker is read below for the one column whose footnote this
      // parser understands. Anywhere else it is a qualification nobody read.
      if (column !== "cache_hits" && /MTok\d+$/.test(value.trim())) {
        rowProblems.push(`footnote_unreadable:${column}`);
      }
      return parsed;
    };
    fields.inputUsdPerMillionTokens = mtok(cells[1], "base_input");
    fields.cacheWriteUsdPerMillionTokens = mtok(cells[2], "5m_cache_writes");
    const hourWrite = mtok(cells[3], "1h_cache_writes");
    fields.cachedInputUsdPerMillionTokens = mtok(cells[4], "cache_hits");
    fields.outputUsdPerMillionTokens = mtok(cells[5], "output");

    const base = fields.inputUsdPerMillionTokens;
    if (base !== null) {
      if (fields.cacheWriteUsdPerMillionTokens !== null && !close(base * 1.25, fields.cacheWriteUsdPerMillionTokens)) {
        rowProblems.push("ratio_broken:5m_cache_writes");
      }
      if (hourWrite !== null && !close(base * 2, hourWrite)) {
        rowProblems.push("ratio_broken:1h_cache_writes");
      }
      const marker = cells[4].match(/MTok(\d+)$/)?.[1];
      let hitMultiplier = 0.1;
      if (marker) {
        const footnote = cacheHitFootnotes.get(marker);
        if (!footnote || !footnote.names.includes(name)) rowProblems.push("cache_hit_footnote_unreadable");
        else hitMultiplier = footnote.multiplier;
      }
      if (fields.cachedInputUsdPerMillionTokens !== null && !close(base * hitMultiplier, fields.cachedInputUsdPerMillionTokens)) {
        rowProblems.push("ratio_broken:cache_hits");
      }
    }

    const batch = batchRows.get(name);
    if (batchDuplicates.has(name)) rowProblems.push("batch_table_duplicate_row");
    if (!batch) rowProblems.push("not_in_batch_table");
    else if (batchDiscount) {
      if (base === null || batch.input === null || !close(batch.input * 2, base)) {
        rowProblems.push("batch_disagrees:input");
      }
      const output = fields.outputUsdPerMillionTokens;
      if (output === null || batch.output === null || !close(batch.output * 2, output)) {
        rowProblems.push("batch_disagrees:output");
      }
    }

    const promotion = notices.promoted.get(name);
    if (promotion) fields.promotional = { note: promotion };

    const version = name.match(/ (\d+)(?:\.(\d+))?$/);
    if (flatFrom && version) {
      const major = Number(version[1]);
      const minor = Number(version[2] ?? 0);
      const [fromMajor, fromMinor] = [Number(flatFrom[1]), Number(flatFrom[2])];
      if (major > fromMajor || (major === fromMajor && minor >= fromMinor)) {
        fields.longContext = { kind: "flat" };
      }
    }
    if (rows.has(name)) duplicates.add(name);
    rows.set(name, { fields, problems: rowProblems });
  }
  for (const name of duplicates) rows.get(name)?.problems.push("model_pricing_duplicate_row");
  return { rows, problems: rows.size ? problems : [...problems, "model_pricing_table_empty"] };
};

/** One Anthropic row by display name, as a parse result. */
export const anthropicModelFromPricing = (
  parsed: AnthropicPricingPage,
  displayName: string | null
): ProviderModelDocParse => {
  if (!parsed.rows) return { status: "parse_failed", fields: null, problems: parsed.problems };
  if (!displayName) return { status: "not_found", fields: null, problems: ["display_name_unknown"] };
  const row = parsed.rows.get(displayName.trim());
  if (!row) return { status: "not_found", fields: null, problems: ["model_not_in_pricing_table"] };
  return { status: "parsed", fields: row.fields, problems: [...parsed.problems, ...row.problems] };
};

export type DocEvidenceSource = { url: string; digest: string | null };

/** A stored `sources` column, or null when its shape is not the one this code writes. */
export const docSourcesFromStored = (value: unknown): DocEvidenceSource[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const sources: DocEvidenceSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { url, digest } = entry as { url?: unknown; digest?: unknown };
    if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
    if (digest !== null && (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))) return null;
    sources.push({ url, digest: digest ?? null });
  }
  return sources;
};

/**
 * A stored evidence row read back as a parse, or null when it cannot be trusted.
 *
 * The row is JSON written by an earlier run, possibly by code that no longer
 * exists. It is believed only when written by this parser version and when
 * every field has exactly the shape this code writes. A field of the wrong
 * shape rejects the whole row rather than being read as "absent": a `problems`
 * that is not an array read as no problems, or a `promotional` that is not an
 * object read as no promotion, is precisely how a price this code would have
 * withheld gets prefilled.
 */
export const docParseFromStored = (row: {
  status: string;
  parserVersion: string;
  fields: unknown;
  problems: unknown;
}): ProviderModelDocParse | null => {
  if (row.parserVersion !== PROVIDER_MODEL_DOC_PARSER_VERSION) return null;
  if (!Array.isArray(row.problems) || !row.problems.every((value) => typeof value === "string")) {
    return null;
  }
  const problems = row.problems as string[];
  if (row.status === "not_found" || row.status === "parse_failed") {
    return row.fields === null || row.fields === undefined
      ? { status: row.status, fields: null, problems }
      : null;
  }
  if (row.status !== "parsed") return null;
  const f = row.fields as Record<string, unknown> | null;
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const exactKeys = (value: object, keys: readonly string[]) => {
    const present = Object.keys(value).sort();
    return present.length === keys.length && [...keys].sort().every((key, index) => key === present[index]);
  };
  if (
    !exactKeys(f, [
      "displayName",
      "contextWindowTokens",
      "maxInputTokens",
      "maxOutputTokens",
      "imageInput",
      "inputUsdPerMillionTokens",
      "cachedInputUsdPerMillionTokens",
      "cacheWriteUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
      "longContext",
      "promotional",
    ])
  ) {
    return null;
  }

  const MAX_PRICE = 100_000;
  const MAX_TOKENS = 100_000_000;
  let valid = true;
  const positiveOrNull = (value: unknown, max: number) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
      valid = false;
      return null;
    }
    return value;
  };
  const booleanOrNull = (value: unknown) => {
    if (value === null || typeof value === "boolean") return value;
    valid = false;
    return null;
  };
  const stringOrNull = (value: unknown) => {
    if (value === null || typeof value === "string") return value;
    valid = false;
    return null;
  };

  const lc = f.longContext as Record<string, unknown> | undefined;
  let longContext: DocLongContext = { kind: "unknown" };
  if (!lc || typeof lc !== "object" || Array.isArray(lc)) valid = false;
  else if ((lc.kind === "flat" || lc.kind === "unknown") && exactKeys(lc, ["kind"])) {
    longContext = { kind: lc.kind };
  } else if (
    lc.kind === "tiered" &&
    exactKeys(lc, ["kind", "thresholdTokens", "inputMultiplier", "outputMultiplier", "cacheTakesInputMultiplier"]) &&
    typeof lc.thresholdTokens === "number" &&
    Number.isSafeInteger(lc.thresholdTokens) &&
    lc.thresholdTokens > 0 &&
    typeof lc.inputMultiplier === "number" &&
    lc.inputMultiplier > 0 &&
    typeof lc.outputMultiplier === "number" &&
    lc.outputMultiplier > 0 &&
    typeof lc.cacheTakesInputMultiplier === "boolean"
  ) {
    longContext = {
      kind: "tiered",
      thresholdTokens: lc.thresholdTokens,
      inputMultiplier: lc.inputMultiplier,
      outputMultiplier: lc.outputMultiplier,
      cacheTakesInputMultiplier: lc.cacheTakesInputMultiplier,
    };
  } else valid = false;

  const promo = f.promotional as Record<string, unknown> | null | undefined;
  let promotional: ProviderModelDocFields["promotional"] = null;
  if (promo !== null) {
    if (promo && typeof promo === "object" && exactKeys(promo, ["note"]) && typeof promo.note === "string") {
      promotional = { note: promo.note };
    }
    else valid = false;
  }

  const fields: ProviderModelDocFields = {
    displayName: stringOrNull(f.displayName),
    contextWindowTokens: positiveOrNull(f.contextWindowTokens, MAX_TOKENS),
    maxInputTokens: positiveOrNull(f.maxInputTokens, MAX_TOKENS),
    maxOutputTokens: positiveOrNull(f.maxOutputTokens, MAX_TOKENS),
    imageInput: booleanOrNull(f.imageInput),
    inputUsdPerMillionTokens: positiveOrNull(f.inputUsdPerMillionTokens, MAX_PRICE),
    cachedInputUsdPerMillionTokens: positiveOrNull(f.cachedInputUsdPerMillionTokens, MAX_PRICE),
    cacheWriteUsdPerMillionTokens: positiveOrNull(f.cacheWriteUsdPerMillionTokens, MAX_PRICE),
    outputUsdPerMillionTokens: positiveOrNull(f.outputUsdPerMillionTokens, MAX_PRICE),
    longContext,
    promotional,
  };
  return valid ? { status: "parsed", fields, problems } : null;
};

/** Whether evidence read at `fetchedAt` may still prefill anything at `now`. */
export const docEvidenceIsFresh = (fetchedAt: Date | null, now: Date) =>
  fetchedAt !== null &&
  now.getTime() - fetchedAt.getTime() <= DOC_EVIDENCE_MAX_AGE_MS &&
  fetchedAt.getTime() <= now.getTime() + 5 * 60 * 1000;

/**
 * Whether a parse's prices may be written into the registry's override
 * columns, and if not, why.
 *
 * The bar is the one an override has to clear to be harmless: fresh evidence;
 * a flat price, stated as flat; both base prices present; not promotional; no
 * problem of any kind; and no pricing profile already covering the model,
 * where a null column is the correct answer.
 */
export type DocPriceRefusal =
  | "no_evidence"
  | "stale"
  | "profile_covers"
  | "problems"
  | "incomplete"
  | "tiered"
  | "long_context_unknown"
  | "promotional";

export const docPricePrefill = (input: {
  parse: ProviderModelDocParse | null;
  hasPricingProfile: boolean;
  fetchedAt: Date | null;
  now: Date;
}):
  | {
      value: {
        inputUsdPerMillionTokens: number;
        outputUsdPerMillionTokens: number;
        cachedInputPriceMultiplier: number | null;
      };
      refusal: null;
    }
  | { value: null; refusal: DocPriceRefusal } => {
  if (input.hasPricingProfile) return { value: null, refusal: "profile_covers" };
  const parse = input.parse;
  if (!parse || parse.status !== "parsed") return { value: null, refusal: "no_evidence" };
  if (!docEvidenceIsFresh(input.fetchedAt, input.now)) return { value: null, refusal: "stale" };
  const { fields } = parse;
  // A promotion first: it is the most specific reason, and the one an
  // operator can act on, even when the same parse also recorded a problem.
  if (fields.promotional) return { value: null, refusal: "promotional" };
  // Any problem at all. A page that parsed with a named problem is a page
  // whose structure has already surprised this parser once.
  if (parse.problems.length) return { value: null, refusal: "problems" };
  if (fields.longContext.kind === "tiered") return { value: null, refusal: "tiered" };
  if (fields.longContext.kind !== "flat") return { value: null, refusal: "long_context_unknown" };
  const inputPrice = fields.inputUsdPerMillionTokens;
  const outputPrice = fields.outputUsdPerMillionTokens;
  if (!inputPrice || !outputPrice) return { value: null, refusal: "incomplete" };
  const cached = fields.cachedInputUsdPerMillionTokens;
  const multiplier =
    cached !== null && cached <= inputPrice ? Math.round((cached / inputPrice) * 10_000) / 10_000 : null;
  return {
    value: {
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice,
      cachedInputPriceMultiplier: multiplier,
    },
    refusal: null,
  };
};

/**
 * A `lib/modelPricing.ts` entry written from a parse, for a person to review
 * and commit.
 *
 * Emitted for tiered models above all: the registry's override columns cannot
 * hold a tier, so a profile is the only correct home for GPT-6 Astra's price.
 *
 * Two values are left as identifiers that do not compile, on purpose. The
 * reservation is an entitlement decision. And the output cap is filled only
 * with `requestOutputCapTokens` -- the cap the adoption form's own guard
 * accepted -- never with the provider's documented ceiling: the two are the
 * same number only when the ceiling leaves room for the largest prompt, and a
 * profile carrying a ceiling that does not is Kimi K3's refused-at-every-size
 * cap, compiled.
 *
 * Every document the parse read is named with its digest, so the reviewer can
 * check the proposal against exactly what was read.
 *
 * `null` when the parse cannot support a complete entry: stale evidence,
 * missing prices, unknown long-context behaviour, a promotion, or any
 * recorded problem.
 */
export const buildPricingProfileProposal = (input: {
  modelId: string;
  provider: ProviderModelDocProvider;
  apiModel: string;
  parse: ProviderModelDocParse | null;
  sources: readonly DocEvidenceSource[];
  fetchedAt: Date;
  now: Date;
  requestOutputCapTokens: number | null;
}) => {
  const parse = input.parse;
  if (!parse || parse.status !== "parsed" || parse.problems.length) return null;
  if (!docEvidenceIsFresh(input.fetchedAt, input.now) || input.sources.length === 0) return null;
  const f = parse.fields;
  if (f.promotional || f.longContext.kind === "unknown") return null;
  if (!f.inputUsdPerMillionTokens || !f.outputUsdPerMillionTokens) return null;
  const read = input.fetchedAt.toISOString().slice(0, 10);
  const tokens = (value: number) => value.toLocaleString("en-US").replace(/,/g, "_");
  const multiplier =
    f.cachedInputUsdPerMillionTokens !== null
      ? Math.round((f.cachedInputUsdPerMillionTokens / f.inputUsdPerMillionTokens) * 10_000) / 10_000
      : 1;
  const tier = (
    maxPromptTokens: number | null,
    inputPrice: number,
    outputPrice: number,
    cacheWrite: number | null
  ) =>
    [
      "            {",
      `                maxPromptTokens: ${maxPromptTokens === null ? "null" : tokens(maxPromptTokens)},`,
      `                inputUsdPerMillionTokens: ${inputPrice},`,
      `                outputUsdPerMillionTokens: ${outputPrice},`,
      `                cachedInputPriceMultiplier: ${multiplier},`,
      ...(cacheWrite === null ? [] : [`                cacheWriteUsdPerMillionTokens: ${cacheWrite},`]),
      "            },",
    ].join("\n");
  const tiers =
    f.longContext.kind === "tiered"
      ? [
          tier(f.longContext.thresholdTokens, f.inputUsdPerMillionTokens, f.outputUsdPerMillionTokens, f.cacheWriteUsdPerMillionTokens),
          tier(
            null,
            f.inputUsdPerMillionTokens * f.longContext.inputMultiplier,
            f.outputUsdPerMillionTokens * f.longContext.outputMultiplier,
            f.cacheWriteUsdPerMillionTokens !== null && f.longContext.cacheTakesInputMultiplier
              ? f.cacheWriteUsdPerMillionTokens * f.longContext.inputMultiplier
              : null
          ),
        ]
      : [tier(null, f.inputUsdPerMillionTokens, f.outputUsdPerMillionTokens, f.cacheWriteUsdPerMillionTokens)];
  return [
    "    {",
    `        // Proposed from the provider's documentation, read ${read}:`,
    ...input.sources.map(
      (source) => `        //   ${source.url}${source.digest ? ` (sha256 ${source.digest.slice(0, 16)}…)` : ""}`
    ),
    "        // Review before committing. The *_TO_DECIDE values are decisions this",
    "        // proposal does not make -- including the billing boundary: the date",
    `        // above is when the page was read (verified), not when the price applies.`,
    `        modelId: "${input.modelId}",`,
    `        provider: "${input.provider}",`,
    `        apiModelId: "${input.apiModel}",`,
    "        ...DIRECT_STANDARD,",
    "        tiers: [",
    ...tiers,
    "        ],",
    '        reasoningTokenBilling: "billed_as_output",',
    ...(input.requestOutputCapTokens
      ? [`        maxOutputTokens: ${tokens(input.requestOutputCapTokens)},`]
      : [
          f.maxOutputTokens
            ? `        // The documented ceiling is ${tokens(f.maxOutputTokens)}; it did not pass the request-cap guard.`
            : "        // The documentation states no output ceiling.",
          "        maxOutputTokens: MAX_OUTPUT_TOKENS_TO_DECIDE,",
        ]),
    "        reservationOutputTokens: RESERVATION_TO_DECIDE,",
    '        reservationOutputBasis: "conservative_default",',
    `        cachedInputPricingVerified: ${f.cachedInputUsdPerMillionTokens !== null},`,
    `        priceSource: "${input.provider}_documentation_${input.apiModel.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}",`,
    `        pricingVersion: "${input.provider}-${input.apiModel}-${read}",`,
    "        effectiveDate: EFFECTIVE_DATE_TO_DECIDE,",
    "    },",
  ].join("\n");
};
