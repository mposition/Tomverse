import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DOC_EVIDENCE_MAX_AGE_MS,
  PROVIDER_MODEL_DOC_PARSER_VERSION,
  anthropicModelFromPricing,
  buildPricingProfileProposal,
  docEvidenceReportLines,
  docParseFromStored,
  docPricePrefill,
  docSourcesFromStored,
  parseAnthropicPricingPage,
  parseOpenAiModelPage,
  parseOpenAiStandardPricingTable,
  type ProviderModelDocParse,
} from "../lib/providerModelDocsCore.ts";

// Every fixture is the document the provider served on 2026-09-13, saved
// unmodified. The normal path is tested against real pages rather than pages
// this file wrote: a parser checked only against its own imagination proves
// that the two agree, not that either matches what the provider publishes.
// The failure paths edit a real page in the one place under test.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/providerModelDocs/${name}`, import.meta.url), "utf8");

const PRICING = fixture("openai-pricing-2026-09-13.md");
const openAiTable = parseOpenAiStandardPricingTable(PRICING);
const openAiModel = (
  apiModel: string,
  page = fixture(`openai-model-${apiModel}-2026-09-13.md`),
  table: ReturnType<typeof parseOpenAiStandardPricingTable> | null = openAiTable
) => parseOpenAiModelPage({ apiModel, modelPage: page, pricingTable: table });
const ANTHROPIC = fixture("anthropic-pricing-2026-09-13.md");
const anthropic = parseAnthropicPricingPage(ANTHROPIC);

const readAt = new Date("2026-09-13T01:00:00Z");
const soon = new Date("2026-09-13T06:00:00Z");
const prefill = (parse: ProviderModelDocParse | null, hasPricingProfile = false) =>
  docPricePrefill({ parse, hasPricingProfile, fetchedAt: readAt, now: soon });
const SOURCES = [{ url: "https://developers.openai.com/api/docs/models/x.md", digest: "a".repeat(64) }];
const proposal = (parse: ProviderModelDocParse, overrides: Partial<Parameters<typeof buildPricingProfileProposal>[0]> = {}) =>
  buildPricingProfileProposal({
    modelId: "gpt-6-astra",
    provider: "openai",
    apiModel: "gpt-6-astra",
    parse,
    sources: SOURCES,
    fetchedAt: readAt,
    now: soon,
    requestOutputCapTokens: 128_000,
    ...overrides,
  });

const parsedFields = (parse: ProviderModelDocParse) => {
  assert.equal(parse.status, "parsed", JSON.stringify(parse.problems));
  return parse.status === "parsed" ? parse.fields : (null as never);
};

// ---- OpenAI, the normal path ----

test("OpenAI's pricing table is read from the standard section only", () => {
  // The page repeats the same columns for Batch, Flex and Fast at other prices.
  // GPT-6 Astra is $10 standard and $5 batch; reading the wrong table is an
  // override billing every request at half price.
  assert.deepEqual(openAiTable.problems, []);
  assert.equal(openAiTable.rows?.get("gpt-6-astra")?.short.input, 10);
  assert.equal(openAiTable.rows?.get("gpt-6-astra")?.long.output, 75);
  assert.equal(openAiTable.rows?.get("gpt-5.2")?.long.input, null);
});

test("GPT-6 Astra: every field the models API leaves out, with both documents agreeing", () => {
  const parse = openAiModel("gpt-6-astra");
  assert.deepEqual(parse.problems, []);
  const fields = parsedFields(parse);
  assert.equal(fields.contextWindowTokens, 1_050_000);
  assert.equal(fields.maxInputTokens, 922_000);
  assert.equal(fields.maxOutputTokens, 128_000);
  assert.equal(fields.imageInput, true);
  assert.equal(fields.inputUsdPerMillionTokens, 10);
  assert.equal(fields.cachedInputUsdPerMillionTokens, 1);
  assert.equal(fields.cacheWriteUsdPerMillionTokens, 12.5);
  assert.equal(fields.outputUsdPerMillionTokens, 50);
  assert.deepEqual(fields.longContext, {
    kind: "tiered",
    thresholdTokens: 272_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
    cacheTakesInputMultiplier: true,
  });
});

test("a tiered price is never an override", () => {
  // The override columns cannot hold a tier. A flat $10/$50 on Astra would bill
  // every request above 272K input at the short-context rate.
  assert.deepEqual(prefill(openAiModel("gpt-6-astra")), { value: null, refusal: "tiered" });
});

test("a tiered model gets a profile proposal with both tiers and every source", () => {
  const text = proposal(openAiModel("gpt-6-astra"));
  assert.ok(text);
  assert.match(text, /maxPromptTokens: 272_000,[\s\S]*inputUsdPerMillionTokens: 10,[\s\S]*outputUsdPerMillionTokens: 50,/);
  assert.match(text, /maxPromptTokens: null,[\s\S]*inputUsdPerMillionTokens: 20,[\s\S]*outputUsdPerMillionTokens: 75,[\s\S]*cacheWriteUsdPerMillionTokens: 25,/);
  assert.match(text, /reservationOutputTokens: RESERVATION_TO_DECIDE,/);
  assert.match(text, /developers\.openai\.com\/api\/docs\/models\/x\.md \(sha256 aaaaaaaaaaaaaaaa…\)/);
});

test("the proposal's output cap is the guarded request cap, never the documented ceiling", () => {
  // Review round 1: a ceiling that leaves no room for input compiled into a
  // profile is Kimi K3's refused-at-every-size cap again.
  const text = proposal(openAiModel("gpt-6-astra"), { requestOutputCapTokens: null });
  assert.ok(text);
  assert.match(text, /maxOutputTokens: MAX_OUTPUT_TOKENS_TO_DECIDE,/);
  assert.match(text, /documented ceiling is 128_000; it did not pass the request-cap guard/);
});

test("a promotional price is never prefilled and never proposed", () => {
  // GPT-5.6 Sol's page advertises $4/$20 "at least through November 21, 2026".
  // lib/modelPricing.ts keeps it at list price.
  const parse = openAiModel("gpt-5.6-sol");
  assert.match(parsedFields(parse).promotional?.note ?? "", /promotional pricing/);
  assert.equal(prefill(parse).refusal, "promotional");
  assert.equal(proposal(parse, { apiModel: "gpt-5.6-sol" }), null);
});

test("an unreviewed promotion sentence on the pricing page withholds every price on it", () => {
  // Review rounds 1-3: tying a promotion to the model it names always left a
  // gap. Any sentence nobody has read now blocks the whole page.
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace(
      "Regional processing",
      "Selected GPT-5 models are available at promotional pricing through December 31, 2026.\n\nRegional processing"
    )
  );
  const parse = openAiModel("gpt-5.2", undefined, table);
  assert.ok(parse.problems.includes("unacknowledged_promotion_notice_on_pricing_page"));
  assert.equal(prefill(parse).value, null);
  assert.equal(proposal(openAiModel("gpt-6-astra", undefined, table)), null);
});

test("a reviewed promotion sentence marks only the models it applies to", () => {
  // The real pricing page carries GPT-5.6 Sol's promotion in a paragraph of
  // unrelated notes. Reviewed, it marks Sol and leaves GPT-5.2 alone.
  assert.deepEqual(openAiTable.notices.unacknowledged, []);
  assert.match(openAiTable.notices.promoted.get("gpt-5.6-sol") ?? "", /Sol/);
  assert.deepEqual(openAiModel("gpt-5.2").problems, []);
});

test("a reviewed sentence that changes by a word is unreviewed again", () => {
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace("available at least through November 21, 2026", "available at least through December 21, 2026")
  );
  assert.equal(table.notices.unacknowledged.length, 1);
});

test("flat is a positive statement: no rule on the page and '-' in the table", () => {
  const parse = openAiModel("gpt-5.2");
  assert.deepEqual(parse.problems, []);
  assert.deepEqual(parsedFields(parse).longContext, { kind: "flat" });
  assert.deepEqual(prefill(parse), {
    value: { inputUsdPerMillionTokens: 1.75, outputUsdPerMillionTokens: 14, cachedInputPriceMultiplier: 0.1 },
    refusal: null,
  });
});

// ---- OpenAI, review round 1 mutations ----

test("a model the pricing table does not list has nothing to agree with", () => {
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace(/^\| gpt-6-astra \|.*\n/m, "")
  );
  const parse = openAiModel("gpt-6-astra", undefined, table);
  assert.ok(parse.problems.includes("model_not_in_pricing_table"));
  assert.equal(proposal(parse), null);
});

test("without the pricing table there is no price", () => {
  const parse = openAiModel("gpt-5.2", undefined, null);
  assert.ok(parse.problems.includes("pricing_table_unavailable"));
  assert.equal(prefill(parse).refusal, "problems");
});

test("a pricing table cell that is not a price is a problem, not a missing number", () => {
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace("| gpt-5.2 | $1.75 |", "| gpt-5.2 | $1.75 / MTok |")
  );
  const parse = openAiModel("gpt-5.2", undefined, table);
  assert.ok(parse.problems.includes("pricing_table_cell_unreadable"));
  assert.equal(prefill(parse).value, null);
});

test("the cached price has to agree between the documents", () => {
  const page = fixture("openai-model-gpt-5.2-2026-09-13.md").replace(
    "| Cached input | $0.175 | 1M tokens |",
    "| Cached input | $0.0175 | 1M tokens |"
  );
  const parse = openAiModel("gpt-5.2", page);
  assert.ok(parse.problems.includes("price_disagrees_with_pricing_table:cached_input"));
  assert.equal(prefill(parse).value, null);
});

test("the input price has to agree between the documents", () => {
  const page = fixture("openai-model-gpt-5.2-2026-09-13.md").replace(
    "| Input | $1.75 | 1M tokens |",
    "| Input | $1.25 | 1M tokens |"
  );
  assert.ok(openAiModel("gpt-5.2", page).problems.includes("price_disagrees_with_pricing_table:input"));
});

test("the long-context cells have to match the rule the model page states", () => {
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace("| $20.00 | $2.00 | $25.00 | $75.00 |", "| $20.00 | $2.00 | $25.00 | $100.00 |")
  );
  const parse = openAiModel("gpt-6-astra", undefined, table);
  assert.ok(parse.problems.includes("price_disagrees_with_pricing_table:long_output"));
  assert.equal(proposal(parse), null);
});

test("a prompt-size sentence the parser cannot read blocks the price", () => {
  const page = fixture("openai-model-gpt-5.2-2026-09-13.md").replace(
    "| Output | $14 | 1M tokens |",
    "| Output | $14 | 1M tokens |\n\n- Prompts with very long inputs are priced differently."
  );
  const parse = openAiModel("gpt-5.2", page);
  assert.ok(parse.problems.includes("long_context_rule_unreadable"));
  assert.equal(prefill(parse).value, null);
});

test("a page for a different model is a failed parse, not that model's numbers", () => {
  const parse = parseOpenAiModelPage({
    apiModel: "gpt-6-astra-mini",
    modelPage: fixture("openai-model-gpt-6-astra-2026-09-13.md"),
    pricingTable: openAiTable,
  });
  assert.equal(parse.status, "parse_failed");
  assert.deepEqual(parse.problems, ["model_id_not_on_page"]);
});

test("a unit that changed is a price nobody reads", () => {
  const page = fixture("openai-model-gpt-5.2-2026-09-13.md").replace(
    "| Output | $14 | 1M tokens |",
    "| Output | $14 | 1K tokens |"
  );
  const parse = openAiModel("gpt-5.2", page);
  assert.equal(parsedFields(parse).outputUsdPerMillionTokens, null);
  assert.ok(parse.problems.includes("unit_changed:Output"));
});

test("a reshaped pricing table fails every model closed", () => {
  const broken = parseOpenAiStandardPricingTable(PRICING.replace("| Short context input |", "| Input |"));
  assert.equal(broken.rows, null);
  assert.deepEqual(broken.problems, ["standard_table_shape_changed"]);
  assert.ok(openAiModel("gpt-5.2", undefined, broken).problems.includes("pricing_table_unavailable"));
});

// ---- Anthropic ----

test("Anthropic: Claude Fable 5.1 from the model pricing table, not the batch one", () => {
  // The batch table lists Fable 5.1 at $5/$25 further down the same page.
  const parse = anthropicModelFromPricing(anthropic, "Claude Fable 5.1");
  assert.deepEqual(parse.problems, []);
  const fields = parsedFields(parse);
  assert.equal(fields.inputUsdPerMillionTokens, 10);
  assert.equal(fields.outputUsdPerMillionTokens, 50);
  assert.equal(fields.cacheWriteUsdPerMillionTokens, 12.5);
  // "$0.25 / MTok1": the trailing 1 is a footnote marker, not a digit.
  assert.equal(fields.cachedInputUsdPerMillionTokens, 0.25);
  assert.deepEqual(fields.longContext, { kind: "flat" });
  assert.deepEqual(prefill(parse).value, {
    inputUsdPerMillionTokens: 10,
    outputUsdPerMillionTokens: 50,
    // Fable 5.1's cache hit is 0.025x, not the family's 0.1x -- the footnote
    // says so, and the ratio check reads it.
    cachedInputPriceMultiplier: 0.025,
  });
});

test("every Anthropic row obeys the page's own stated ratios", () => {
  for (const [name, row] of anthropic.rows ?? []) {
    assert.deepEqual(row.problems, [], name);
  }
});

test("an Anthropic cell that breaks the page's ratios is caught", () => {
  // Review round 1: a truncated five-minute write went straight into a proposal.
  const page = parseAnthropicPricingPage(
    ANTHROPIC.replace(
      "| Claude Fable 5.1                                                                                                                      | $10 / MTok        | $12.50 / MTok",
      "| Claude Fable 5.1                                                                                                                      | $10 / MTok        | $1.25 / MTok"
    )
  );
  const parse = anthropicModelFromPricing(page, "Claude Fable 5.1");
  assert.ok(parse.problems.includes("ratio_broken:5m_cache_writes"));
  assert.equal(prefill(parse).value, null);
});

test("Anthropic's reviewed Sonnet 5 notice blocks nothing", () => {
  // The note says Sonnet 5's introductory price is now its standard price;
  // AGENTS.md records the same. Reviewed, it applies to no model.
  assert.deepEqual(parseAnthropicPricingPage(ANTHROPIC).problems, []);
  assert.equal(parsedFields(anthropicModelFromPricing(anthropic, "Claude Sonnet 5")).promotional, null);
});

test("an unreviewed Anthropic promotion sentence withholds every row, wherever it sits", () => {
  // Round 3: a promotion in its own paragraph under the model's name, or for a
  // family, did not reach the model. Page-level, it cannot be missed.
  const page = parseAnthropicPricingPage(
    ANTHROPIC.replace("### Long context pricing", "Claude Fable 5.1\n\nPromotional pricing through December 31, 2026.\n\n### Long context pricing")
  );
  assert.ok(page.problems.includes("unacknowledged_promotion_notice"));
  for (const name of ["Claude Fable 5.1", "Claude Opus 5"]) {
    assert.equal(prefill(anthropicModelFromPricing(page, name)).value, null, name);
  }
});

test("Anthropic flat pricing applies only from the version the page names", () => {
  const haiku = anthropicModelFromPricing(anthropic, "Claude Haiku 4.5");
  assert.deepEqual(parsedFields(haiku).longContext, { kind: "unknown" });
  assert.equal(prefill(haiku).refusal, "long_context_unknown");
  assert.ok(anthropic.rows?.has("Claude Opus 4.1"));
});

test("Anthropic rows are found by display name, and a missing one is not_found", () => {
  assert.equal(anthropicModelFromPricing(anthropic, "Claude Nonexistent 9").status, "not_found");
  assert.equal(anthropicModelFromPricing(anthropic, null).status, "not_found");
});

test("without the long-context statement no Anthropic price is flat", () => {
  const page = parseAnthropicPricingPage(ANTHROPIC.replace("at standard pricing", "at the listed rates"));
  const parse = anthropicModelFromPricing(page, "Claude Fable 5.1");
  assert.ok(parse.problems.includes("long_context_statement_unreadable"));
  assert.equal(prefill(parse).value, null);
});

// ---- the gate ----

test("a profile already covering the model always wins over the documentation", () => {
  assert.deepEqual(prefill(anthropicModelFromPricing(anthropic, "Claude Fable 5.1"), true), {
    value: null,
    refusal: "profile_covers",
  });
});

test("old evidence prefills nothing and proposes nothing", () => {
  // Review round 1: a row the cap left out kept yesterday's -- or last month's --
  // price, and the form kept filling it in.
  const parse = anthropicModelFromPricing(anthropic, "Claude Fable 5.1");
  const later = new Date(readAt.getTime() + DOC_EVIDENCE_MAX_AGE_MS + 1);
  assert.equal(
    docPricePrefill({ parse, hasPricingProfile: false, fetchedAt: readAt, now: later }).refusal,
    "stale"
  );
  assert.equal(proposal(openAiModel("gpt-6-astra"), { now: later }), null);
  assert.equal(docPricePrefill({ parse, hasPricingProfile: false, fetchedAt: null, now: soon }).refusal, "stale");
});

// ---- stored rows ----

const storedAstra = () => {
  const parse = openAiModel("gpt-6-astra");
  return {
    status: "parsed",
    parserVersion: PROVIDER_MODEL_DOC_PARSER_VERSION,
    fields: JSON.parse(JSON.stringify(parse.status === "parsed" ? parse.fields : null)) as Record<string, unknown>,
    problems: [] as unknown,
  };
};

test("a stored row reads back as the parse that wrote it", () => {
  assert.deepEqual(docParseFromStored(storedAstra()), openAiModel("gpt-6-astra"));
});

test("a stored row is believed only from this parser version", () => {
  assert.equal(docParseFromStored({ ...storedAstra(), parserVersion: "2020-01-01.1" }), null);
  assert.equal(docParseFromStored({ ...storedAstra(), status: "fetch_failed" }), null);
});

test("a wrongly shaped stored field rejects the row instead of reading as absent", () => {
  // Review round 1: a non-array `problems` read as no problems, and a
  // non-object `promotional` read as no promotion -- and the price prefilled.
  const row = storedAstra();
  assert.equal(docParseFromStored({ ...row, problems: { code: "shape_changed" } }), null);
  assert.equal(docParseFromStored({ ...row, problems: ["ok", 3] }), null);
  assert.equal(
    docParseFromStored({ ...row, fields: { ...row.fields, promotional: "introductory through December" } }),
    null
  );
  assert.equal(docParseFromStored({ ...row, fields: { ...row.fields, inputUsdPerMillionTokens: -1 } }), null);
  assert.equal(docParseFromStored({ ...row, fields: { ...row.fields, inputUsdPerMillionTokens: "10" } }), null);
  assert.equal(
    docParseFromStored({ ...row, fields: { ...row.fields, longContext: { kind: "tiered", thresholdTokens: 272000 } } }),
    null
  );
  assert.equal(docParseFromStored({ ...row, fields: "nonsense" }), null);
});

test("stored sources must be https URLs with a SHA-256 or null digest", () => {
  assert.deepEqual(docSourcesFromStored(SOURCES), SOURCES);
  assert.deepEqual(docSourcesFromStored([{ url: "https://x.test/a.md", digest: null }]), [
    { url: "https://x.test/a.md", digest: null },
  ]);
  assert.equal(docSourcesFromStored([]), null);
  assert.equal(docSourcesFromStored([{ url: "http://x.test/a.md", digest: null }]), null);
  assert.equal(docSourcesFromStored([{ url: "https://x.test/a.md", digest: "abc" }]), null);
  assert.equal(docSourcesFromStored({ url: "https://x.test/a.md" }), null);
});

// ---- report ----

test("the daily report prints failures, degraded parses and unread models", () => {
  const lines = docEvidenceReportLines({
    attempted: 3,
    byStatus: { parsed: 2, not_found: 1, fetch_failed: 0, parse_failed: 0 },
    degraded: 1,
    failures: [
      { provider: "openai", apiModel: "gpt-7", status: "not_found", problems: ["http_404"] },
      { provider: "openai", apiModel: "gpt-5.2", status: "parsed_with_problems", problems: ["pricing_table:standard_table_shape_changed"] },
    ],
    notAttempted: [{ provider: "openai", apiModel: "gpt-8", reason: "cap" }],
    unacknowledgedNotices: [{ provider: "anthropic", sentence: "Promotional pricing through December 31, 2026." }],
  });
  assert.match(lines.failures.join("\n"), /unreviewed promotion sentence withholds every documented price/);
  // Review round 1: "parsed 12/12" over twelve rows that each refused a price.
  assert.equal(lines.summary, " · docs clean 1/3 · docs not read 1");
  assert.match(lines.failures.join("\n"), /parsed_with_problems \(pricing_table:standard_table_shape_changed\)/);
  assert.match(lines.failures.join("\n"), /gpt-8`: cap/);
  assert.match(docEvidenceReportLines(undefined).failures[0], /did not run/);
  assert.deepEqual(
    docEvidenceReportLines({
      attempted: 0,
      byStatus: { parsed: 0, not_found: 0, fetch_failed: 0, parse_failed: 0 },
      degraded: 0,
      failures: [],
      notAttempted: [],
      unacknowledgedNotices: [],
    }),
    { summary: "", failures: [] }
  );
});

// ---- review round 2 ----

const FABLE_ROW_START =
  "| Claude Fable 5.1                                                                                                                      | $10 / MTok        | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok1            | ";

test("an Anthropic output price is checked against the batch table", () => {
  // The standard table's own ratios tie input and cache prices together but
  // say nothing about output. A dropped digit there was a 10x under-billing
  // override. The batch table states output again at half.
  const page = parseAnthropicPricingPage(ANTHROPIC.replace(`${FABLE_ROW_START}$50 / MTok`, `${FABLE_ROW_START}$5 / MTok `));
  const parse = anthropicModelFromPricing(page, "Claude Fable 5.1");
  assert.equal(parsedFields(parse).outputUsdPerMillionTokens, 5);
  assert.ok(parse.problems.includes("batch_disagrees:output"));
  assert.equal(prefill(parse).value, null);
});

test("a footnote marker on any column but cache hits is a problem", () => {
  const page = parseAnthropicPricingPage(ANTHROPIC.replace(`${FABLE_ROW_START}$50 / MTok `, `${FABLE_ROW_START}$50 / MTok2`));
  const parse = anthropicModelFromPricing(page, "Claude Fable 5.1");
  assert.ok(parse.problems.includes("footnote_unreadable:output"));
  assert.equal(prefill(parse).value, null);
});

test("a model missing from the batch table has nothing to check its output against", () => {
  const page = parseAnthropicPricingPage(
    ANTHROPIC.replace(/^\| Claude Fable 5\.1 +\| \$5 \/ MTok +\| \$25 \/ MTok +\|\n/m, "")
  );
  assert.ok(anthropicModelFromPricing(page, "Claude Fable 5.1").problems.includes("not_in_batch_table"));
});

test("a promotion wrapped across lines is still read as one sentence", () => {
  const anthropicPage = parseAnthropicPricingPage(
    ANTHROPIC.replace(
      "### Long context pricing",
      "Claude Fable 5.1 is available at\npromotional pricing through December 31, 2026.\n\n### Long context pricing"
    )
  );
  assert.equal(prefill(anthropicModelFromPricing(anthropicPage, "Claude Fable 5.1")).value, null);
  const table = parseOpenAiStandardPricingTable(
    PRICING.replace("Regional processing", "gpt-5.2 is available at\npromotional pricing until further notice.\n\nRegional processing")
  );
  assert.equal(prefill(openAiModel("gpt-5.2", undefined, table)).value, null);
});

test("duplicate rows for one model are a contradiction, not last-one-wins", () => {
  // Round 3: a second batch row at $2.50 overwrote the real $25 and made a
  // mistyped $5 standard output agree with it.
  const batchDup = parseAnthropicPricingPage(
    ANTHROPIC.replace(
      /^(\| Claude Fable 5\.1 +\| \$5 \/ MTok +\| \$25 \/ MTok +\|)$/m,
      "$1\n| Claude Fable 5.1 | $5 / MTok | $2.50 / MTok |"
    )
  );
  assert.ok(anthropicModelFromPricing(batchDup, "Claude Fable 5.1").problems.includes("batch_table_duplicate_row"));

  const tableDup = parseOpenAiStandardPricingTable(
    PRICING.replace(/^(\| gpt-5\.2 \|.*)$/m, "$1\n| gpt-5.2 | $0.10 | $0.01 | - | $0.50 | - | - | - | - |")
  );
  assert.ok(openAiModel("gpt-5.2", undefined, tableDup).problems.includes("pricing_table_duplicate_row"));
});

test("an input modality line this parser cannot read is not read as text-only", () => {
  const page = fixture("openai-model-gpt-6-astra-2026-09-13.md").replace(
    "- Input modalities: text, image",
    "- Input modalities: text and image"
  );
  const parse = openAiModel("gpt-6-astra", page);
  assert.equal(parsedFields(parse).imageInput, null);
  assert.ok(parse.problems.includes("input_modalities_unreadable"));
});

test("a stored row with extra or mixed keys is rejected, not narrowed", () => {
  const row = storedAstra();
  assert.equal(
    docParseFromStored({
      ...row,
      fields: {
        ...row.fields,
        longContext: { kind: "flat", thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, cacheTakesInputMultiplier: true },
      },
    }),
    null
  );
  assert.equal(docParseFromStored({ ...row, fields: { ...row.fields, surprise: true } }), null);
  assert.equal(
    docParseFromStored({ ...row, fields: { ...row.fields, promotional: { note: "x", until: "2026-12-31" } } }),
    null
  );
  const withoutPromotional = { ...row.fields };
  delete withoutPromotional.promotional;
  assert.equal(docParseFromStored({ ...row, fields: withoutPromotional }), null);
});

test("a proposal leaves the billing boundary to a person", () => {
  const text = proposal(openAiModel("gpt-6-astra"));
  assert.match(text ?? "", /effectiveDate: EFFECTIVE_DATE_TO_DECIDE,/);
  assert.match(text ?? "", /read 2026-09-13/);
});

test("the daily email carries each provider's documentation result on its own row", async () => {
  const { docEvidenceProviderNote } = await import("../lib/providerModelDocsCore.ts");
  const summary = {
    attempted: 2,
    byStatus: { parsed: 1, not_found: 1, fetch_failed: 0, parse_failed: 0 },
    degraded: 0,
    failures: [{ provider: "openai", apiModel: "gpt-7", status: "not_found", problems: ["http_404"] }],
    notAttempted: [{ provider: "anthropic", apiModel: "claude-x", reason: "cap" as const }],
    unacknowledgedNotices: [{ provider: "openai", sentence: "Promotional pricing for all models." }],
  };
  assert.match(docEvidenceProviderNote(summary, "openai") ?? "", /unreviewed promotion sentence/);
  assert.match(docEvidenceProviderNote(summary, "openai") ?? "", /gpt-7 not_found \(http_404\)/);
  assert.match(docEvidenceProviderNote(summary, "anthropic") ?? "", /not read for 1 queued model/);
  assert.equal(docEvidenceProviderNote(summary, "groq"), null);
  assert.equal(docEvidenceProviderNote(undefined, "openai"), "documentation read did not run");
  assert.equal(docEvidenceProviderNote(null, "openai"), null);
});

// ---- review round 4 ----

test("temporary pricing in other words is still caught on the model's own page", () => {
  // Round 4: only three words were recognised. The list is a warning, not the
  // control -- the operator confirms documented prices -- but the common
  // phrasings withhold the prefill outright.
  for (const sentence of [
    "GPT-5.2 has temporary pricing through December 31, 2026.",
    "A special launch rate applies to GPT-5.2.",
    "This price ends March 1, 2027.",
  ]) {
    const page = fixture("openai-model-gpt-5.2-2026-09-13.md").replace(
      "## Endpoints",
      `${sentence}\n\n## Endpoints`
    );
    assert.equal(prefill(openAiModel("gpt-5.2", page)).refusal, "promotional", sentence);
  }
});

test("an acknowledged sentence moved into a bullet is still acknowledged", () => {
  const moved = PRICING.replace(
    "GPT-5.6 Sol’s promotional pricing is available at least through November 21, 2026.",
    "\n\n- GPT-5.6 Sol’s promotional pricing is available at least through November 21, 2026."
  );
  assert.deepEqual(parseOpenAiStandardPricingTable(moved).notices.unacknowledged, []);
});

test("a table row of the wrong width refuses the table instead of vanishing", () => {
  // Round 4: a malformed correct row was skipped while a well-formed wrong row
  // for the same model stayed and was believed.
  const openAi = parseOpenAiStandardPricingTable(PRICING.replace(/^(\| gpt-5\.2 \|.*)$/m, "$1\n| gpt-5.2 | $1.75 | $0.175 |"));
  assert.deepEqual(openAi.problems, ["standard_table_row_malformed"]);

  const standard = parseAnthropicPricingPage(ANTHROPIC.replace(`${FABLE_ROW_START}$50 / MTok `, `${FABLE_ROW_START}`.replace(/\| $/, "")));
  assert.deepEqual(standard.problems, ["model_pricing_table_row_malformed"]);

  const batch = parseAnthropicPricingPage(
    ANTHROPIC.replace(/^(\| Claude Fable 5\.1 +\| \$5 \/ MTok +\| \$25 \/ MTok +\|)$/m, "$1\n| Claude Fable 5.1 | $5 / MTok |")
  );
  assert.ok(batch.problems.includes("batch_table_row_malformed"));
  assert.equal(prefill(anthropicModelFromPricing(batch, "Claude Fable 5.1")).value, null);
});
