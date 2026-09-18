// The marketing tables' closed lists, payload shapes and retention arithmetic.
//
// Three kinds of assertion here, and the middle one is the reason this file
// exists rather than a type test:
//
//   * the strict schemas refuse what they are meant to refuse -- unknown keys,
//     over-length strings, prose where a token belongs;
//   * the constants that are duplicated in SQL still match the SQL. The posting
//     caps live in a plpgsql CASE because a trigger cannot import TypeScript,
//     and a duplicate nothing compares is a duplicate that drifts;
//   * month arithmetic matches Postgres's, which is what the retention CHECK
//     compares against.
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
  MARKETING_LOCALES,
  MARKETING_NO_AUTONOMY_CHANNELS,
  MARKETING_PAUSABLE_MODES,
  MARKETING_POST_KINDS,
  MARKETING_POST_MODES,
  MARKETING_POST_STATUSES,
  MARKETING_PROVIDERS,
  MARKETING_REPORT_KINDS,
  MARKETING_REPORT_PAYLOAD_SCHEMAS,
  MARKETING_REPORT_RETENTION,
  MARKETING_RETENTION_SETTING,
  addMonthsLikePostgres,
  aiVisibilityAccuracyFlagsSchema,
  aiVisibilityRetentionUntil,
  marketingEnvelopeSchema,
  marketingFactSnapshotSchema,
  marketingHistoryEntrySchema,
  marketingReportRetentionUntil,
  parseMarketingReportPayload,
} from "../lib/marketingAutomationSchema.ts";

const MIGRATION = readFileSync(
  new URL(
    "../prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const digest = "a".repeat(64);

const validEnvelope = () => ({
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Tomverse compares answers from several models side by side.",
  claimIds: ["claim.models-compared"],
  assets: [{ assetId: "asset.hero", alt: "A comparison of three answers" }],
  finalUrl: "https://tomverse.app/",
  scheduledAt: "2026-09-18T01:00:00.000Z",
  disclosureFlags: ["advertising"],
});

// ---------------------------------------------------------------------------
// The lists the database repeats
// ---------------------------------------------------------------------------

test("every closed list in the migration is the list the module exports", () => {
  const pairs = [
    ["MarketingChannel_channel_check", MARKETING_CHANNELS],
    ["MarketingChannel_provider_check", MARKETING_PROVIDERS],
    ["MarketingChannel_status_check", MARKETING_CHANNEL_STATUSES],
    ["MarketingChannel_defaultLocale_check", MARKETING_LOCALES],
    ["MarketingChannel_pausedFromMode_check", MARKETING_PAUSABLE_MODES],
    ["MarketingPost_locale_check", MARKETING_LOCALES],
    ["MarketingPost_kind_check", MARKETING_POST_KINDS],
    ["MarketingPost_status_check", MARKETING_POST_STATUSES],
    ["MarketingPost_mode_check", MARKETING_POST_MODES],
    ["MarketingReport_kind_check", MARKETING_REPORT_KINDS],
    ["AiVisibilityRun_locale_check", MARKETING_LOCALES],
    ["AiVisibilityRun_searchMode_check", AI_VISIBILITY_SEARCH_MODES],
  ];

  for (const [constraint, list] of pairs) {
    const clause = MIGRATION.split(`CONSTRAINT "${constraint}" CHECK (`)[1];
    assert.ok(clause, `${constraint} is not in the migration`);
    const values = [...clause.slice(0, clause.indexOf("))")).matchAll(/'([^']*)'/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      [...values].sort(),
      [...list].sort(),
      `${constraint} and the module disagree`,
    );
  }
});

test("the channels with no autonomy are the ones the O15 constraint names", () => {
  for (const channel of MARKETING_NO_AUTONOMY_CHANNELS) {
    assert.ok(
      MARKETING_CHANNELS.includes(channel),
      `${channel} is not a channel at all`,
    );
    assert.ok(
      MIGRATION.includes(`'${channel}'`),
      `${channel} is not named in the migration`,
    );
  }
  const clause = MIGRATION.split(
    'CONSTRAINT "MarketingChannel_no_autonomy_channels_check" CHECK (',
  )[1];
  const named = [...clause.slice(0, clause.indexOf("))")).matchAll(/'([a-z_]+)'/g)]
    .map((match) => match[1])
    .filter((value) => MARKETING_CHANNELS.includes(value));
  assert.deepEqual([...new Set(named)].sort(), [...MARKETING_NO_AUTONOMY_CHANNELS].sort());
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

test("the retention CASE in the migration matches the retention table", () => {
  const clause = MIGRATION.split(
    'CONSTRAINT "MarketingReport_retentionUntil_check" CHECK (',
  )[1];
  const fromSql = {};
  for (const match of clause.matchAll(
    /WHEN '([a-z0-9_]+)' THEN INTERVAL '(\d+) (months|days)'/g,
  )) {
    fromSql[match[1]] = {
      unit: match[3] === "months" ? "month" : "day",
      amount: Number(match[2]),
    };
  }
  assert.deepEqual(fromSql, { ...MARKETING_REPORT_RETENTION });
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

test("rendered text has a ceiling and everything else is shorter still", () => {
  const long = { ...validEnvelope(), renderedText: "x".repeat(3001) };
  assert.equal(marketingEnvelopeSchema.safeParse(long).success, false);
  const alt = {
    ...validEnvelope(),
    assets: [{ assetId: "asset.hero", alt: "x".repeat(401) }],
  };
  assert.equal(marketingEnvelopeSchema.safeParse(alt).success, false);
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

test("a final url must be https", () => {
  assert.equal(
    marketingEnvelopeSchema.safeParse({
      ...validEnvelope(),
      finalUrl: "http://tomverse.app/",
    }).success,
    false,
  );
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

test("a market intel value is short and single-line", () => {
  const fact = {
    competitorId: "competitor.acme",
    factType: "list_price_usd",
    sourceUrl: "https://acme.example/pricing",
    checkedAt: "2026-09-18T00:00:00.000Z",
  };
  assert.ok(parseMarketingReportPayload("market_intel", { facts: [{ ...fact, value: 20 }] }));
  assert.ok(
    parseMarketingReportPayload("market_intel", { facts: [{ ...fact, value: "usd" }] }),
  );
  assert.throws(() =>
    parseMarketingReportPayload("market_intel", {
      facts: [{ ...fact, value: "x".repeat(81) }],
    }),
  );
  assert.throws(() =>
    parseMarketingReportPayload("market_intel", {
      facts: [{ ...fact, value: "line one\nline two" }],
    }),
  );
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

// ---------------------------------------------------------------------------
// Retention arithmetic
// ---------------------------------------------------------------------------

test("adding months clamps to the end of a shorter month, as Postgres does", () => {
  assert.equal(
    addMonthsLikePostgres(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(),
    "2026-02-28T00:00:00.000Z",
  );
  assert.equal(
    addMonthsLikePostgres(new Date("2024-01-31T00:00:00.000Z"), 1).toISOString(),
    "2024-02-29T00:00:00.000Z",
  );
  assert.equal(
    addMonthsLikePostgres(new Date("2026-08-31T12:34:56.789Z"), 24).toISOString(),
    "2028-08-31T12:34:56.789Z",
  );
  assert.equal(
    addMonthsLikePostgres(new Date("2026-03-31T00:00:00.000Z"), 36).toISOString(),
    "2029-03-31T00:00:00.000Z",
  );
});

test("a report's retention comes from its kind, and a run's is two years", () => {
  assert.equal(
    marketingReportRetentionUntil(
      "comment_alerts",
      new Date("2026-09-18T00:00:00.000Z"),
    ).toISOString(),
    "2026-12-17T00:00:00.000Z",
  );
  assert.equal(
    marketingReportRetentionUntil(
      "weekly_kpi",
      new Date("2026-09-18T00:00:00.000Z"),
    ).toISOString(),
    "2028-09-18T00:00:00.000Z",
  );
  assert.equal(
    aiVisibilityRetentionUntil(new Date("2026-09-18T00:00:00.000Z")).toISOString(),
    "2028-09-18T00:00:00.000Z",
  );
});
