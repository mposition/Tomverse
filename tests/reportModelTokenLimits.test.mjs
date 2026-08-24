import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ACTOR_ABSENT,
  ACTOR_PRESENT,
  AGREES,
  BOTH_DIVERGED,
  MAX_OUTPUT_DIVERGED,
  MISSING_IN_DB,
  RESERVATION_DIVERGED,
  UNKNOWN_TO_CODE,
  SCOPE_FULL,
  SCOPE_OUTPUT_CAP_ONLY,
  compareTokenLimits,
  formatTokenLimitRow,
  tokenLimitFindings,
} from "../scripts/report-model-token-limits-core.mjs";

const catalogue = [
  // The case that produced this script: the profile says 128,000, the row
  // serves 4,096, nobody is named on the row and nothing reconciles it.
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    enabled: true,
    maxOutputTokens: 128_000,
    reservationOutputTokens: 2_048,
  },
  // Same difference, but an operator wrote to the row. A deliberate cap and a
  // fossil look identical in the column; the actor is the only evidence.
  {
    id: "gpt-5-6-luna",
    provider: "openai",
    enabled: true,
    maxOutputTokens: 128_000,
    reservationOutputTokens: 4_096,
  },
  // Inside STATIC_CATALOG_RECONCILIATION_MODEL_IDS: differs now, corrected on
  // the next boot. A run mid-deploy must not read as a finding.
  {
    id: "gpt-5-4-mini",
    provider: "openai",
    enabled: true,
    maxOutputTokens: 128_000,
    reservationOutputTokens: 4_096,
  },
  // Only the reservation differs -- a credit and cost figure, reported for
  // review and never grouped with the request caps.
  {
    id: "gemini-3-6-flash",
    provider: "google",
    enabled: true,
    maxOutputTokens: 65_536,
    reservationOutputTokens: 8_192,
  },
  // Stores nothing, so registryRowToModel() drops the columns and the profile
  // supplies them. Agreeing, not drifting.
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    enabled: true,
    maxOutputTokens: 64_000,
    reservationOutputTokens: 1_024,
  },
  { id: "grok-4-5", provider: "xai", enabled: true, maxOutputTokens: 65_536, reservationOutputTokens: 8_192 },
  { id: "kimi-k3", provider: "moonshot", enabled: true, maxOutputTokens: 131_072, reservationOutputTokens: 16_384 },
];

const storedRows = [
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    enabled: true,
    maxOutputTokens: 4_096,
    reservationOutputTokens: 2_048,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  {
    id: "gpt-5-6-luna",
    provider: "openai",
    enabled: true,
    maxOutputTokens: 32_000,
    reservationOutputTokens: 4_096,
    updatedById: "user_1",
    updatedByEmail: "ops@tomverse.app",
    updatedAt: "2026-08-10T00:00:00.000Z",
  },
  {
    id: "gpt-5-4-mini",
    provider: "openai",
    enabled: true,
    maxOutputTokens: 8_192,
    reservationOutputTokens: 2_048,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "gemini-3-6-flash",
    provider: "google",
    enabled: true,
    maxOutputTokens: 65_536,
    reservationOutputTokens: 4_096,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    enabled: true,
    maxOutputTokens: null,
    reservationOutputTokens: null,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "grok-4-5",
    provider: "xai",
    enabled: true,
    maxOutputTokens: 65_536,
    reservationOutputTokens: 8_192,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  // A row the catalogue no longer names. It keeps answering under its stored
  // cap until somebody deals with it.
  {
    id: "groq-gpt-oss-120b",
    provider: "groq",
    enabled: true,
    maxOutputTokens: 8_192,
    reservationOutputTokens: 4_096,
    updatedById: null,
    updatedByEmail: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

const entries = compareTokenLimits({
  catalogueModels: catalogue,
  storedRows,
  reconciledModelIds: ["gpt-5-4-mini", "grok-4-5"],
});
const byId = new Map(entries.map((entry) => [entry.modelId, entry]));

test("a stored cap below the profile is reported per column", () => {
  assert.equal(byId.get("claude-sonnet-5").state, MAX_OUTPUT_DIVERGED);
  assert.equal(byId.get("claude-sonnet-5").storedMaxOutputTokens, 4_096);
  assert.equal(byId.get("claude-sonnet-5").catalogueMaxOutputTokens, 128_000);

  assert.equal(byId.get("gemini-3-6-flash").state, RESERVATION_DIVERGED);
  assert.equal(byId.get("gpt-5-4-mini").state, BOTH_DIVERGED);
  assert.equal(byId.get("grok-4-5").state, AGREES);
});

test("a NULL token column reads as inheriting the profile, not as drift", () => {
  const haiku = byId.get("claude-haiku-4-5");
  assert.equal(haiku.state, AGREES);
  assert.equal(haiku.inheritsProfile, true);
  assert.equal(haiku.storedMaxOutputTokens, null);
});

test("actor metadata separates a seeded fossil from an operator's decision", () => {
  assert.equal(byId.get("claude-sonnet-5").actorMetadata, ACTOR_ABSENT);
  assert.equal(byId.get("gpt-5-6-luna").actorMetadata, ACTOR_PRESENT);
  assert.equal(byId.get("gpt-5-6-luna").updatedByEmail, "ops@tomverse.app");

  const findings = tokenLimitFindings(entries);
  // The finding the script exists for: no operator, no reconciliation, so
  // nothing resolves it on its own.
  assert.deepEqual(
    findings.strandedRequestCaps.map((entry) => entry.modelId),
    ["claude-sonnet-5"]
  );
  assert.deepEqual(
    findings.operatorOwnedRequestCaps.map((entry) => entry.modelId),
    ["gpt-5-6-luna"]
  );
});

test("a reconciled row is listed as pending, not as a stranded cap", () => {
  const findings = tokenLimitFindings(entries);
  assert.deepEqual(
    findings.pendingReconciliation.map((entry) => entry.modelId),
    ["gpt-5-4-mini"]
  );
  assert.equal(
    findings.strandedRequestCaps.some((entry) => entry.modelId === "gpt-5-4-mini"),
    false
  );
});

test("reservation differences are reported apart from request caps", () => {
  const findings = tokenLimitFindings(entries);
  // gemini-3-6-flash (reservation only) and gpt-5-4-mini (both) -- and never
  // folded into the request-cap list, because moving a reservation is an
  // entitlement decision rather than a capability fix.
  assert.deepEqual(
    findings.reservationDifferences.map((entry) => entry.modelId).sort(),
    ["gemini-3-6-flash", "gpt-5-4-mini"]
  );
  assert.equal(
    findings.requestCapDifferences.some(
      (entry) => entry.modelId === "gemini-3-6-flash"
    ),
    false
  );
});

test("rows and models each side of the comparison are accounted for", () => {
  const findings = tokenLimitFindings(entries);
  assert.deepEqual(
    findings.unknownToCode.map((entry) => entry.modelId),
    ["groq-gpt-oss-120b"]
  );
  assert.deepEqual(
    findings.missingInDb.map((entry) => entry.modelId),
    ["kimi-k3"]
  );
  assert.equal(byId.get("kimi-k3").state, MISSING_IN_DB);
  assert.equal(byId.get("groq-gpt-oss-120b").state, UNKNOWN_TO_CODE);
});

test("an empty database reports every model as missing rather than as agreeing", () => {
  const withoutRows = compareTokenLimits({
    catalogueModels: catalogue,
    storedRows: [],
  });
  assert.equal(withoutRows.length, catalogue.length);
  assert.equal(
    withoutRows.every((entry) => entry.state === MISSING_IN_DB),
    true
  );
  assert.equal(tokenLimitFindings(withoutRows).diverged.length, 0);
});

test("each row renders both columns and its provenance on one line", () => {
  const line = formatTokenLimitRow(byId.get("claude-sonnet-5"));
  assert.match(line, /claude-sonnet-5/);
  assert.match(line, /128,000\/2,048/);
  assert.match(line, /4,096\/2,048/);
  assert.match(line, new RegExp(MAX_OUTPUT_DIVERGED));
  assert.match(line, new RegExp(ACTOR_ABSENT));

  assert.match(formatTokenLimitRow(byId.get("kimi-k3")), /\(no row\)/);
  assert.match(
    formatTokenLimitRow(byId.get("claude-haiku-4-5")),
    /inherits-profile/
  );
});

// A cap-only entry fixes the cap and deliberately leaves the reservation
// alone, so the report must not file that reservation under "corrected on the
// next boot" -- nothing is going to correct it.
test("a cap-only model's reservation difference is never reported as pending", () => {
  const scoped = compareTokenLimits({
    catalogueModels: [
      {
        id: "perplexity/sonar-reasoning-pro",
        provider: "perplexity",
        enabled: true,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
      },
      {
        id: "perplexity/sonar",
        provider: "perplexity",
        enabled: true,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
      },
      {
        id: "gpt-5-4-mini",
        provider: "openai",
        enabled: true,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 4_096,
      },
    ],
    storedRows: [
      // Cap stranded, reservation agrees: entirely fixed by the cap-only entry.
      {
        id: "perplexity/sonar-reasoning-pro",
        provider: "perplexity",
        enabled: true,
        maxOutputTokens: 4_096,
        reservationOutputTokens: 2_048,
        updatedById: null,
        updatedByEmail: null,
      },
      // Both differ, but only the cap will move.
      {
        id: "perplexity/sonar",
        provider: "perplexity",
        enabled: true,
        maxOutputTokens: 4_096,
        reservationOutputTokens: 1_024,
        updatedById: null,
        updatedByEmail: null,
      },
      // Full scope: both columns are carried, so both are pending.
      {
        id: "gpt-5-4-mini",
        provider: "openai",
        enabled: true,
        maxOutputTokens: 8_192,
        reservationOutputTokens: 2_048,
        updatedById: null,
        updatedByEmail: null,
      },
    ],
    reconciledModelIds: [
      "perplexity/sonar-reasoning-pro",
      "perplexity/sonar",
      "gpt-5-4-mini",
    ],
    outputCapOnlyModelIds: [
      "perplexity/sonar-reasoning-pro",
      "perplexity/sonar",
    ],
  });
  const byModel = new Map(scoped.map((entry) => [entry.modelId, entry]));
  assert.equal(
    byModel.get("perplexity/sonar-reasoning-pro").reconciledScope,
    SCOPE_OUTPUT_CAP_ONLY
  );
  assert.equal(byModel.get("gpt-5-4-mini").reconciledScope, SCOPE_FULL);

  const findings = tokenLimitFindings(scoped);
  // sonar-reasoning-pro's only difference is the cap, so it clears on boot.
  // sonar's cap clears too, but its reservation does not, so it is NOT
  // promised as pending -- it is reported as something nobody will fix.
  assert.deepEqual(
    findings.pendingReconciliation.map((entry) => entry.modelId).sort(),
    ["gpt-5-4-mini", "perplexity/sonar-reasoning-pro"]
  );
  assert.deepEqual(
    findings.unreconciledReservations.map((entry) => entry.modelId),
    ["perplexity/sonar"]
  );
  // And neither counts as stranded: something does lift both caps.
  assert.deepEqual(findings.strandedRequestCaps, []);
});

/**
 * A run that never opened the database must not describe one.
 *
 * `compareTokenLimits` above is pure and correct about the list it is handed:
 * given no stored rows, every model is `missing_in_db`, because that is true
 * of that list. But "no rows were supplied" and "the database has no rows" are
 * different facts, and only the second says anything about production.
 *
 * The wrapper used to collapse them. A real run on Railway's production
 * console -- where the shell had no DATABASE_URL -- ended with "41 model(s)
 * with no registry row. Seeding inserts these on next boot." Two claims about
 * a database it had never opened, three lines under a header that correctly
 * said it could find nothing, against a registry that was fully populated.
 *
 * Spawned rather than unit-tested because the defect was in what reached the
 * operator's screen, and that is the only thing that can pin it.
 */
const runReport = (extraEnv) => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/report-model-token-limits.mjs",
      ...(extraEnv.args ?? []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...extraEnv.env },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("a run with no DATABASE_URL claims nothing about registry rows", () => {
  const stdout = runReport({ env: { DATABASE_URL: "" } });

  assert.match(stdout, /No DATABASE_URL/);
  // The catalogue is still useful and needs no database to read.
  assert.match(stdout, /claude-sonnet-5\s+128,000\/2,048/);

  // None of these may appear: each is a statement about a row this run did not
  // read. The first is the exact sentence that shipped the false claim.
  assert.doesNotMatch(stdout, /Seeding inserts these on next boot/);
  assert.doesNotMatch(stdout, /with no registry row/);
  assert.doesNotMatch(stdout, /missing_in_db/);
  assert.doesNotMatch(stdout, /stranded/);
  assert.doesNotMatch(stdout, /\(no row\)/);
  assert.doesNotMatch(stdout, /agrees/);
  assert.match(stdout, /Nothing was compared/);
});

test("an unreadable DATABASE_URL is reported as unread, not as an empty registry", () => {
  const stdout = runReport({
    env: { DATABASE_URL: "postgresql://nobody@127.0.0.1:1/nope" },
  });
  assert.match(stdout, /unreadable/);
  assert.doesNotMatch(stdout, /Seeding inserts these on next boot/);
  assert.doesNotMatch(stdout, /missing_in_db/);
  assert.match(stdout, /Nothing was compared/);
});

test("the JSON form says whether a comparison happened, and omits findings when it did not", () => {
  const parsed = JSON.parse(runReport({ env: { DATABASE_URL: "" }, args: ["--json"] }));
  assert.equal(parsed.comparedAgainstDatabase, false);
  assert.equal("findings" in parsed, false);
  assert.equal("entries" in parsed, false);
  assert.ok(Array.isArray(parsed.catalogue));
  assert.ok(parsed.catalogue.length > 0);
});
