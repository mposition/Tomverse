// The marketing tables' closed lists, payload shapes and duplicated constants.
//
// Three kinds of assertion here, and the middle one is the reason this file
// exists rather than a type test:
//
//   * the strict schemas refuse what they are meant to refuse -- unknown keys,
//     free sentences where a token belongs, a link to somewhere that is not us;
//   * every constant that is duplicated in SQL still matches the SQL. The
//     posting caps, the retention periods and the post status whitelist all live
//     in plpgsql as well, because a trigger cannot import TypeScript, and a
//     duplicate nothing compares is a duplicate that drifts;
//   * no schema field is an untyped string. That is a property of the source,
//     so the test reads it.
//
// Contract: docs/policy/marketing-automation.md.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AI_VISIBILITY_ACCURACY_FLAGS,
  AI_VISIBILITY_SEARCH_MODES,
  MARKETING_CHANNELS,
  MARKETING_CHANNEL_CAPS,
  MARKETING_CHANNEL_STATUSES,
  MARKETING_DELETION_METHODS,
  MARKETING_DISPATCHED_STATUSES,
  MARKETING_GUARD_DECISIONS,
  MARKETING_LOCALES,
  MARKETING_NO_AUTONOMY_CHANNELS,
  MARKETING_PAUSABLE_MODES,
  MARKETING_POST_KINDS,
  MARKETING_POST_MODES,
  MARKETING_POST_STATUSES,
  MARKETING_POST_STATUS_TRANSITIONS,
  MARKETING_PROVIDERS,
  MARKETING_PUBLIC_HOST,
  MARKETING_REPORT_KINDS,
  MARKETING_REPORT_PAYLOAD_SCHEMAS,
  MARKETING_REPORT_RETENTION,
  MARKETING_RESUME_REASON_CODES,
  MARKETING_RETENTION_SETTING,
  MARKETING_VERIFICATION_METHODS,
  MARKET_INTEL_FACT_TOKENS,
  aiVisibilityAccuracyFlagsSchema,
  aiVisibilityCitedUrlsSchema,
  marketIntelFactProblem,
  marketingEnvelopeSchema,
  marketingFactSnapshotSchema,
  marketingHistoryEntrySchema,
  parseMarketingReportPayload,
} from "../lib/marketingAutomationSchema.ts";

const MIGRATION_PATH = new URL(
  "../prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
  import.meta.url,
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const MODULE_SOURCE = readFileSync(
  new URL("../lib/marketingAutomationSchema.ts", import.meta.url),
  "utf8",
);

const digest = "a".repeat(64);

/** The values a named CHECK constraint lists, read out of the migration. */
const constraintValues = (name) => {
  const marker = `CONSTRAINT "${name}" CHECK (`;
  const start = MIGRATION.indexOf(marker);
  assert.ok(start >= 0, `${name} is not in the migration`);
  const body = MIGRATION.slice(start + marker.length);
  const clause = body.slice(0, body.indexOf(";"));
  return [...clause.matchAll(/'([^']*)'/g)].map((match) => match[1]);
};

const validEnvelope = (overrides = {}) => ({
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Tomverse compares answers from several models side by side.",
  claimIds: ["claim.models-compared"],
  assets: [{ assetId: "asset.hero", altKey: "alt.hero" }],
  finalUrl: `https://${MARKETING_PUBLIC_HOST}/`,
  scheduledAt: "2026-09-18T01:00:00.000Z",
  disclosureFlags: ["advertising"],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The lists and constants the database repeats
// ---------------------------------------------------------------------------

test("every closed list in the migration is the list the module exports", () => {
  const pairs = [
    ["MarketingChannel_channel_check", MARKETING_CHANNELS],
    ["MarketingChannel_provider_check", MARKETING_PROVIDERS],
    ["MarketingChannel_status_check", MARKETING_CHANNEL_STATUSES],
    ["MarketingChannel_defaultLocale_check", MARKETING_LOCALES],
    ["MarketingChannel_pausedFromMode_check", MARKETING_PAUSABLE_MODES],
    ["MarketingChannel_lastResumeReasonCode_check", MARKETING_RESUME_REASON_CODES],
    ["MarketingPost_locale_check", MARKETING_LOCALES],
    ["MarketingPost_kind_check", MARKETING_POST_KINDS],
    ["MarketingPost_guardDecision_check", MARKETING_GUARD_DECISIONS],
    ["MarketingPost_status_check", MARKETING_POST_STATUSES],
    ["MarketingPost_mode_check", MARKETING_POST_MODES],
    ["MarketingPost_verificationMethod_check", MARKETING_VERIFICATION_METHODS],
    ["MarketingPost_deletionMethod_check", MARKETING_DELETION_METHODS],
    ["MarketingReport_kind_check", MARKETING_REPORT_KINDS],
    ["AiVisibilityRun_locale_check", MARKETING_LOCALES],
    ["AiVisibilityRun_searchMode_check", AI_VISIBILITY_SEARCH_MODES],
  ];

  for (const [constraint, list] of pairs) {
    assert.deepEqual(
      [...constraintValues(constraint)].sort(),
      [...list].sort(),
      `${constraint} and the module disagree`,
    );
  }
});

test("the channels with no autonomy are the ones the O15 constraint names", () => {
  const named = constraintValues("MarketingChannel_no_autonomy_channels_check").filter(
    (value) => MARKETING_CHANNELS.includes(value),
  );
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...MARKETING_NO_AUTONOMY_CHANNELS].sort(),
  );
});

test("the statuses that require a provider request key are the dispatched ones", () => {
  const named = constraintValues(
    "MarketingPost_dispatched_has_request_key_check",
  ).filter((value) => MARKETING_POST_STATUSES.includes(value));
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...MARKETING_DISPATCHED_STATUSES].sort(),
  );
});

test("the posting caps in the trigger are the caps in the module", () => {
  const body = MIGRATION.split('CASE NEW."channel"')[1].split("END CASE;")[0];
  const fromSql = {};
  for (const match of body.matchAll(
    /WHEN '([a-z]+)' THEN daily_cap := (NULL|\d+); weekly_cap := (NULL|\d+);/g,
  )) {
    fromSql[match[1]] =
      match[2] === "NULL"
        ? null
        : { daily: Number(match[2]), weekly: Number(match[3]) };
  }
  assert.deepEqual(fromSql, { ...MARKETING_CHANNEL_CAPS });
});

test("both retention CASE blocks in the migration match the retention table", () => {
  // One is the CHECK constraint and one is the trigger that sets the column.
  // They have to agree with each other as well as with the module, or an insert
  // the trigger wrote would fail the constraint it wrote it for.
  const blocks = [...MIGRATION.matchAll(/CASE "kind"|CASE NEW\."kind"/g)];
  assert.equal(blocks.length, 2, "the retention period is stated twice");

  for (const block of blocks) {
    const body = MIGRATION.slice(block.index, MIGRATION.indexOf("END", block.index));
    const fromSql = {};
    for (const match of body.matchAll(
      /WHEN '([a-z0-9_]+)' THEN INTERVAL '(\d+) (months|days)'/g,
    )) {
      fromSql[match[1]] = {
        unit: match[3] === "months" ? "month" : "day",
        amount: Number(match[2]),
      };
    }
    assert.deepEqual(fromSql, { ...MARKETING_REPORT_RETENTION });
  }
});

test("the post status whitelist in the trigger is the one the module states", () => {
  const body = MIGRATION.split("-- The status whitelist")[1].split(
    "RAISE EXCEPTION 'MarketingPost % cannot move from",
  )[0];
  const fromSql = {};
  for (const match of body.matchAll(
    /OLD\."status" = '([a-z_]+)' AND NEW\."status" (?:IN \(([^)]*)\)|= '([a-z_]+)')/g,
  )) {
    const targets = match[2]
      ? [...match[2].matchAll(/'([a-z_]+)'/g)].map((value) => value[1])
      : [match[3]];
    fromSql[match[1]] = targets;
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(fromSql).map(([from, to]) => [from, [...to].sort()]),
    ),
    Object.fromEntries(
      Object.entries(MARKETING_POST_STATUS_TRANSITIONS).map(([from, to]) => [
        from,
        [...to].sort(),
      ]),
    ),
  );
});

test("the retention setting is spelled the same in both places", () => {
  assert.ok(MIGRATION.includes(`'${MARKETING_RETENTION_SETTING}'`));
});

test("every report kind has a payload schema and a retention period", () => {
  for (const kind of MARKETING_REPORT_KINDS) {
    assert.ok(MARKETING_REPORT_PAYLOAD_SCHEMAS[kind], `${kind} has no payload schema`);
    assert.ok(MARKETING_REPORT_RETENTION[kind], `${kind} has no retention period`);
  }
  assert.equal(
    Object.keys(MARKETING_REPORT_PAYLOAD_SCHEMAS).length,
    MARKETING_REPORT_KINDS.length,
  );
});

// ---------------------------------------------------------------------------
// No untyped strings
// ---------------------------------------------------------------------------

test("no schema field is an untyped string", () => {
  // Everything between the two markers is the typed-field vocabulary; a
  // `z.string()` outside it is a field somebody described instead of typing.
  const start = MODULE_SOURCE.indexOf("// TYPED FIELDS BEGIN");
  const end = MODULE_SOURCE.indexOf("// TYPED FIELDS END");
  assert.ok(start >= 0 && end > start, "the typed-field block is not marked");

  const outside =
    MODULE_SOURCE.slice(0, start) + MODULE_SOURCE.slice(end);
  const offenders = outside
    .split("\n")
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => {
      if (!line.includes("z.string(")) return false;
      // A comment explaining the rule is not a field that breaks it.
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*")
      );
    });

  assert.deepEqual(
    offenders,
    [],
    "every string field is built from the typed helpers",
  );
});

// ---------------------------------------------------------------------------
// The schemas refuse what they are for
// ---------------------------------------------------------------------------

test("an envelope with an unknown key is refused", () => {
  assert.ok(marketingEnvelopeSchema.safeParse(validEnvelope()).success);
  assert.equal(
    marketingEnvelopeSchema.safeParse({ ...validEnvelope(), comment: "looks good" })
      .success,
    false,
  );
});

test("alt text is a registry key, not a sentence written here", () => {
  assert.equal(
    marketingEnvelopeSchema.safeParse({
      ...validEnvelope(),
      assets: [{ assetId: "asset.hero", alt: "A comparison of three answers" }],
    }).success,
    false,
  );
  assert.equal(
    marketingEnvelopeSchema.safeParse({
      ...validEnvelope(),
      assets: [{ assetId: "asset.hero", altKey: "A comparison of three answers" }],
    }).success,
    false,
    "a key has no spaces; a sentence in the key field is still a sentence",
  );
});

test("rendered text has a ceiling", () => {
  assert.equal(
    marketingEnvelopeSchema.safeParse({
      ...validEnvelope(),
      renderedText: "x".repeat(3001),
    }).success,
    false,
  );
});

test("an account slug is generated-looking, never a handle", () => {
  for (const slug of ["@tomverse", "tomverse", "linkedin-", "linkedin-1234", "LinkedIn-1"]) {
    assert.equal(
      marketingEnvelopeSchema.safeParse({ ...validEnvelope(), accountSlug: slug }).success,
      false,
      `${slug} should be refused`,
    );
  }
  assert.ok(
    marketingEnvelopeSchema.safeParse({ ...validEnvelope(), accountSlug: "instagram-3" })
      .success,
  );
});

test("a post's link goes to our own site over https", () => {
  for (const url of [
    `http://${MARKETING_PUBLIC_HOST}/`,
    "https://example.test/",
    `https://evil.test/?u=https://${MARKETING_PUBLIC_HOST}/`,
  ]) {
    assert.equal(
      marketingEnvelopeSchema.safeParse({ ...validEnvelope(), finalUrl: url }).success,
      false,
      `${url} should be refused`,
    );
  }
});

test("a fact snapshot carries row references, not the values they held", () => {
  const snapshot = {
    priceRows: [{ rowId: "price.pro-monthly", updatedAt: "2026-09-01T00:00:00.000Z" }],
    catalogue: { source: "stored_row", updatedAt: "2026-09-01T00:00:00.000Z" },
    modelRegistryRows: [],
    evidenceDigests: [digest],
  };
  assert.ok(marketingFactSnapshotSchema.safeParse(snapshot).success);
  assert.equal(
    marketingFactSnapshotSchema.safeParse({
      ...snapshot,
      priceRows: [
        {
          rowId: "price.pro-monthly",
          updatedAt: "2026-09-01T00:00:00.000Z",
          amountCents: 2000,
        },
      ],
    }).success,
    false,
    "a stored price would be a second copy of the catalogue",
  );
});

test("a history entry records digests and codes, never the text", () => {
  assert.ok(
    marketingHistoryEntrySchema.safeParse({
      at: "2026-09-18T00:00:00.000Z",
      type: "draft",
      envelopeDigest: digest,
    }).success,
  );
  assert.equal(
    marketingHistoryEntrySchema.safeParse({
      at: "2026-09-18T00:00:00.000Z",
      type: "draft",
      envelopeDigest: digest,
      renderedText: "the post",
    }).success,
    false,
  );
  assert.equal(
    marketingHistoryEntrySchema.safeParse({
      at: "2026-09-18T00:00:00.000Z",
      type: "operator_note",
      note: "looks fine",
    }).success,
    false,
  );
});

test("a comment alert carries counts and a host, never a comment", () => {
  const payload = {
    postId: "post.123",
    alertCount: 2,
    riskCodes: ["risk.legal"],
    firstDetectedAt: "2026-09-18T00:00:00.000Z",
    externalUrlHost: "www.linkedin.com",
  };
  assert.ok(parseMarketingReportPayload("comment_alerts", payload));
  for (const extra of [
    { commentText: "this product is bad" },
    { authorHandle: "@someone" },
    { externalUrl: "https://www.linkedin.com/posts/123" },
  ]) {
    assert.throws(
      () => parseMarketingReportPayload("comment_alerts", { ...payload, ...extra }),
      `${Object.keys(extra)[0]} should be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Market intelligence: no free sentences about anybody else
// ---------------------------------------------------------------------------

const intelFact = (value) => ({
  facts: [
    {
      competitorId: "competitor.acme",
      factType: "plan_tier",
      value,
      sourceUrl: "https://acme.example/pricing",
      checkedAt: "2026-09-18T00:00:00.000Z",
    },
  ],
  unrepresentableFactCount: 0,
});

test("a competitor fact is a tagged value, never a sentence", () => {
  assert.ok(
    parseMarketingReportPayload("market_intel", intelFact({ kind: "token", value: "pro" })),
  );
  assert.ok(
    parseMarketingReportPayload(
      "market_intel",
      intelFact({ kind: "money", amountMinor: 2000, currency: "USD" }),
    ),
  );
  assert.throws(
    () => parseMarketingReportPayload("market_intel", intelFact("their plan is better")),
    "a bare string is not a fact",
  );
  assert.throws(() =>
    parseMarketingReportPayload(
      "market_intel",
      intelFact({ kind: "note", value: "their plan is better" }),
    ),
  );
});

test("a token has to belong to its fact type's vocabulary", () => {
  assert.equal(marketIntelFactProblem("plan_tier", { kind: "token", value: "pro" }), null);
  assert.match(
    marketIntelFactProblem("plan_tier", { kind: "token", value: "platinum" }) ?? "",
    /not a token of plan_tier/,
  );
  assert.match(
    marketIntelFactProblem("mood", { kind: "token", value: "good" }) ?? "",
    /no token vocabulary/,
  );
  assert.throws(() =>
    parseMarketingReportPayload(
      "market_intel",
      intelFact({ kind: "token", value: "platinum" }),
    ),
  );
  // A number needs no vocabulary: it is not a word somebody chose.
  assert.equal(
    marketIntelFactProblem("mood", { kind: "number", value: 3, unit: null }),
    null,
  );
});

test("every fact-type vocabulary is a list of tokens, not of sentences", () => {
  for (const [factType, tokens] of Object.entries(MARKET_INTEL_FACT_TOKENS)) {
    assert.ok(tokens.length > 0, `${factType} has an empty vocabulary`);
    for (const token of tokens) {
      assert.match(token, /^[a-z0-9_]+$/, `${factType} token ${token}`);
    }
  }
});

test("an unknown report kind has no fallback schema", () => {
  assert.throws(() => parseMarketingReportPayload("not_a_kind", {}), /No marketing report/);
});

test("accuracy flags are enumerated, never free text", () => {
  assert.ok(
    aiVisibilityAccuracyFlagsSchema.safeParse({ flags: [AI_VISIBILITY_ACCURACY_FLAGS[0]] })
      .success,
  );
  assert.equal(
    aiVisibilityAccuracyFlagsSchema.safeParse({ flags: ["it said something odd"] }).success,
    false,
  );
});

test("a citation may be anywhere, as long as it is https", () => {
  assert.ok(aiVisibilityCitedUrlsSchema.safeParse(["https://acme.example/answer"]).success);
  assert.equal(
    aiVisibilityCitedUrlsSchema.safeParse(["http://acme.example/answer"]).success,
    false,
  );
});
