// The one write no person is present for.
//
// Contract: the private S2 plan's "Autonomous insert: complete shape" and
// "Binding and isolation matrix", and S1 r7 amendment 2 (approved 2026-09-23)
// for the trigger exception this row goes through.
//
// Everything here is about what the insert *refuses*. The happy path is one
// test and the other twenty are the ways the world can have moved between a
// Guard sealing a decision and this function writing it: the template edited,
// purged or deleted; the account paused, disconnected or reconnected; the
// switches turned off; the configuration generation advanced; a claim's prior
// publication withdrawn; the health observation stale; the build or the
// deployment no longer the one the decision was made under.

import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// TypeScript, and imported through the `@/` alias, for one reason: this is the
// first test that hands the store a decision `guardDraft()` sealed. A proof is
// membership of a module-level WeakSet, so it only survives if the Guard the
// test calls and the Guard the store calls are the same module instance -- and
// under the test runner a `.mjs` file reaching `../lib/x.ts` and a `.ts` module
// reaching `@/lib/x` are loaded twice, into two WeakSets. Every decision the
// test made then arrived at the store unsealed. Naming the modules the way
// production names them is what makes the test exercise the seal rather than
// a copy of it.

import {
  guardDraft,
  sealMarketingFacts,
  sealMarketingGuardContext,
  sealMarketingTemplateProof,
} from "@/lib/marketingGuardCore";
import type { MarketingGuardDecision } from "@/lib/marketingGuardCore";
import type { MarketingGuardFacts } from "@/lib/marketingFacts";
import type {
  MarketingChannel,
  MarketingChannelStatus,
  MarketingLocale,
  MarketingPostKind,
} from "@/lib/marketingAutomationSchema";
import {
  insertAutonomousScheduledMarketingPost,
  marketingEnvelopeDigest,
  marketingSerializationFailure,
  MarketingStoreRefusedError,
  MARKETING_PRIOR_USE_STATUSES,
  MARKETING_REFUSAL_STATUS,
  MARKETING_S2B2_ACTIONS,
  MARKETING_SERIALIZATION_RETRIES,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import {
  marketingConfigGeneration,
  marketingHealthIsFresh,
  MARKETING_HEALTH_FRESHNESS_SECONDS,
} from "@/lib/marketingAutonomousAdmission";

/**
 * The one cast in this file.
 *
 * A fake that answered every method on a Prisma client would be a second
 * implementation of Prisma, and the insert asks about a dozen questions. What
 * it must not do is drift: each fake below throws on a statement it does not
 * recognise, so a new read in the store fails the test rather than silently
 * receiving `undefined`.
 */
const asTransaction = (database: unknown): MarketingTransaction =>
  database as MarketingTransaction;

/** What a Prisma `create` handed the fake, for the assertions to read. */
type Written = Record<string, never> | Record<string, unknown>;

type ChannelRow = {
  id: string;
  channel: MarketingChannel;
  accountSlug: string;
  status: MarketingChannelStatus;
  connectionGeneration: number;
  scopesDigest: string;
  policyVersion: number;
  graduationEpoch: number;
};

type FakeOptions = {
  channel?: ChannelRow | null;
  templateHeld?: boolean;
  templateMatches?: boolean;
  usedClaimIds?: readonly string[];
  usedAssetIds?: readonly string[];
  now?: Date | null;
};

const LOCALE: MarketingLocale = "en";
const KIND: MarketingPostKind = "social";
const CHANNEL_ID = "chn_linkedin_en";
const ACCOUNT_SLUG = "linkedin-1";
const TEMPLATE_ID = "template.compare";
const TEMPLATE_TEXT = "Three answers to one question, side by side.";
const CLAIM_ID = "claim.compare";
const ASSET_ID = "asset.hero";
const ALT_KEY = "alt.hero";
const CODE_DIGEST = "c".repeat(64);
const DEPLOYMENT_ID = "deployment-1";
const COMMIT_SHA = "a".repeat(40);
const GENERATION = 7;

// The database's clock, as the fake reports it, and the slot the envelope
// names. Both come off the real clock rather than being written out, because a
// template proof is stamped with `Date.now()` and is worth
// `MARKETING_TEMPLATE_PROOF_MAX_AGE_MS` -- sixty seconds. A fixed instant in
// 2026 is outside that window the moment the proof is made, and every test
// would have failed on the binding before reaching what it was about.
const NOW = new Date();
const SLOT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

const FACT_SNAPSHOT = {
  catalogue: null,
  evidenceDigests: [],
  modelRegistryRows: [],
  priceRows: [],
};

const factSnapshotDigest = createHash("sha256")
  .update(JSON.stringify(FACT_SNAPSHOT), "utf8")
  .digest("hex");

const TEMPLATE_DIGEST = createHash("sha256")
  .update(TEMPLATE_TEXT, "utf8")
  .digest("hex");

const APPROVED_DIGEST = "e".repeat(64);

const envelope = (
  overrides: Record<string, unknown> = {},
  channel: MarketingChannel = "linkedin",
) => ({
  channel,
  accountSlug: `${channel}-1`,
  locale: LOCALE,
  renderedText: TEMPLATE_TEXT,
  claimIds: [CLAIM_ID],
  assets: [{ assetId: ASSET_ID, altKey: ALT_KEY }],
  finalUrl: null,
  scheduledAt: SLOT.toISOString(),
  disclosureFlags: [],
  ...overrides,
});

/** The facts an autonomous decision is made from: everything used before. */
const sealedFacts = (
  overrides: Record<string, unknown> = {},
  channel: MarketingChannel = "linkedin",
) =>
  sealMarketingFacts({
    channelId: CHANNEL_ID,
    channel,
    locale: "en",
    claims: [
      {
        claimId: CLAIM_ID,
        type: "feature",
        known: true,
        featurePublic: true,
        evidenceStatement: TEMPLATE_TEXT,
        usedBefore: true,
      },
    ],
    assets: [{ assetId: ASSET_ID, known: true, usedBefore: true }],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshotDigest,
    ...overrides,
  });

const templateProof = (channel: MarketingChannel = "linkedin") =>
  sealMarketingTemplateProof({
    templateId: TEMPLATE_ID,
    channelId: CHANNEL_ID,
    channel,
    locale: "en",
    historyVersion: 7,
    status: "approved",
    approvedDigest: APPROVED_DIGEST,
    renderedTextDigest: TEMPLATE_DIGEST,
    slotsFromRegistry: true,
    claimIds: [CLAIM_ID],
    assetIds: [ASSET_ID],
  });

/** A real sealed `autonomous_eligible` decision, made the only way there is. */
type AutonomousDecision = Extract<
  MarketingGuardDecision,
  { verdict: "autonomous_eligible" }
>;

const autonomousDecision = (
  facts: MarketingGuardFacts = sealedFacts(),
  channel: MarketingChannel = "linkedin",
): AutonomousDecision => {
  const decision = guardDraft({
    draft: {
      templateId: TEMPLATE_ID,
      renderedText: TEMPLATE_TEXT,
      locale: "en",
      channel,
      channelId: CHANNEL_ID,
      claimIds: [CLAIM_ID],
      assetIds: [ASSET_ID],
    },
    facts,
    templates: [templateProof(channel)],
    context: sealMarketingGuardContext({
      priceFallbackAlertReady: true,
      incidentOrSecurity: "proved_false",
      testimonial: "proved_false",
      legalOrPolicy: "proved_false",
    }),
  });
  assert.equal(
    decision.verdict,
    "autonomous_eligible",
    `fixture is not autonomous: ${JSON.stringify(
      "codes" in decision ? decision.codes : [],
    )}`,
  );
  // Narrowed by the assertion above: `assert.equal` is not an assertion
  // signature, so this says in the type what the line before it proved.
  return decision as AutonomousDecision;
};

const channelRow = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
  id: CHANNEL_ID,
  channel: "linkedin",
  accountSlug: ACCOUNT_SLUG,
  status: "autonomous_mode",
  connectionGeneration: 1,
  scopesDigest: "d".repeat(64),
  policyVersion: 1,
  graduationEpoch: 1,
  ...overrides,
});

/**
 * A database that answers the insert's questions.
 *
 * `$queryRaw` is dispatched on what the statement mentions rather than on call
 * order: the insert's four raw statements are the clock, the channel lock, the
 * template's `FOR SHARE` and the two prior-use reads, and a fake keyed on
 * position would have to be rewritten by anyone who moved one of them.
 */
/**
 * The text of a statement, whichever way it arrived.
 *
 * The store passes `Prisma.sql` objects; `lib/adminAudit.ts` uses tagged
 * templates, where the first argument is the strings array itself. Both are
 * reduced to text so the fake answers on what the statement says.
 */
const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

const fakeDatabase = (options: FakeOptions = {}) => {
  const {
    channel = channelRow(),
    templateHeld = true,
    templateMatches = true,
    usedClaimIds = [CLAIM_ID],
    usedAssetIds = [ASSET_ID],
    now = null,
  } = options;
  const writes: { post: Written | null; audit: Written | null } = {
    post: null,
    audit: null,
  };
  const database = {
    // The audit writer takes the chain lock before anything else.
    async $executeRaw() {
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      // Read when the statement runs, not when the fake was built. A template
      // proof is stamped with the real clock at the moment it is made, and the
      // fixture makes one per call; a clock captured earlier is before its own
      // proof, which the binding window reads as not yet valid.
      if (sql.includes("clock_timestamp")) {
        const at = now ?? new Date();
        return [{ now: at, createdAt: at }];
      }
      if (sql.includes("FOR UPDATE")) return channel === null ? [] : [channel];
      if (sql.includes("FOR SHARE")) {
        return templateHeld ? [{ id: TEMPLATE_ID }] : [];
      }
      if (sql.includes('unnest(post."claimIds")')) {
        return usedClaimIds.map((value) => ({ value }));
      }
      if (sql.includes('unnest(post."assetIds")')) {
        return usedAssetIds.map((value) => ({ value }));
      }
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingChannel: {
      findUnique: async () => channel,
    },
    marketingPost: {
      findFirst: async () => (templateMatches ? { id: TEMPLATE_ID } : null),
      create: async ({ data }: { data: Written }) => {
        writes.post = data;
        return { id: "post-new" };
      },
    },
    adminAuditLog: {
      findFirst: async () => null,
      create: async ({ data }: { data: Written }) => {
        writes.audit = data;
        return data;
      },
    },
  };
  return { database, writes };
};

const admission = (overrides: Record<string, unknown> = {}) => async () => ({
  autonomousPublish: true,
  admissionCodeDigest: CODE_DIGEST,
  configGeneration: GENERATION,
  deploymentId: DEPLOYMENT_ID,
  ...overrides,
});

type InputOverrides = {
  channel?: MarketingChannel;
  facts?: MarketingGuardFacts;
  decision?: AutonomousDecision;
  envelope?: Record<string, unknown>;
  input?: Record<string, unknown>;
  resolveAdmission?: () => Promise<{
    autonomousPublish: boolean;
    admissionCodeDigest: string;
    configGeneration: number;
    deploymentId: string;
  }>;
};

const insertInput = (overrides: InputOverrides = {}) => {
  const channel: MarketingChannel = overrides.channel ?? "linkedin";
  const facts = overrides.facts ?? sealedFacts({}, channel);
  const decision = overrides.decision ?? autonomousDecision(facts, channel);
  const body = envelope(overrides.envelope, channel);
  return {
    channelId: CHANNEL_ID,
    locale: LOCALE,
    kind: KIND,
    logicalKey: "linkedin-en-compare-2026-09-24",
    envelope: body,
    envelopeDigest: marketingEnvelopeDigest(body),
    rendererVersion: "1",
    templateId: TEMPLATE_ID,
    templateDigest: APPROVED_DIGEST,
    claimIds: [CLAIM_ID],
    assetIds: [ASSET_ID],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshot: FACT_SNAPSHOT,
    decision,
    draftedAt: new Date("2026-09-22T23:00:00.000Z"),
    binding: decision.templateBinding,
    facts,
    resolveAdmission: overrides.resolveAdmission ?? admission(),
    admissionCodeDigest: CODE_DIGEST,
    configGeneration: GENERATION,
    deploymentId: DEPLOYMENT_ID,
    commitSha: COMMIT_SHA,
    ...(overrides.input ?? {}),
  };
};

const refusal = async (
  databaseOptions?: FakeOptions,
  inputOverrides?: InputOverrides,
) => {
  const { database } = fakeDatabase(databaseOptions);
  try {
    await insertAutonomousScheduledMarketingPost(
      asTransaction(database),
      insertInput(inputOverrides),
    );
  } catch (error) {
    if (error instanceof MarketingStoreRefusedError) return error.code;
    throw error;
  }
  return null;
};

// ---------------------------------------------------------------------------
// The shape that is written
// ---------------------------------------------------------------------------

test("the autonomous insert writes one scheduled row and its system audit", async () => {
  const { database, writes } = fakeDatabase();
  const result = await insertAutonomousScheduledMarketingPost(
    asTransaction(database),
    insertInput(),
  );

  assert.equal(result.id, "post-new");

  // Captured once. `writes.post` is a nullable property, and narrowing it at
  // every use would say the same thing thirty times; this says it once, and
  // says it with an assertion rather than an operator, so a run in which
  // nothing was written fails here with that sentence.
  const post = writes.post;
  const audit = writes.audit;
  assert.ok(post, "no post row was written");
  assert.ok(audit, "no audit entry was written");
  const scheduledAt = post.scheduledAt;
  const history = post.history;
  assert.ok(scheduledAt instanceof Date);
  assert.ok(Array.isArray(history));
  const metadata = (audit.metadata ?? {}) as Record<string, unknown>;

  assert.equal(post.status, "scheduled");
  assert.equal(post.mode, "autonomous");
  assert.equal(post.guardDecision, "autonomous_eligible");
  assert.deepEqual(post.guardCodes, []);
  assert.equal(scheduledAt.getTime(), SLOT.getTime());
  assert.equal(post.templateId, TEMPLATE_ID);
  assert.equal(post.templateDigest, APPROVED_DIGEST);

  // Every field the plan requires absent. A post nobody approved must carry no
  // trace of an approval, no claim on a publishing slot and no outcome.
  for (const column of [
    "approvalAuditLogId",
    "approvedAt",
    "approvedDigest",
    "approvalExpiresAt",
    "slotDate",
    "claimToken",
    "leaseUntil",
    "providerRequestKey",
    "externalPostId",
    "externalUrl",
    "publishedAt",
    "verifiedPublicAt",
    "verificationMethod",
    "errorCode",
    "outcomeUnknownAt",
    "deletedAt",
    "deletionMethod",
    "contentPurgedAt",
  ]) {
    assert.ok(
      post[column] === undefined || post[column] === null,
      `${column} must not be set by the autonomous insert`,
    );
  }
  assert.ok(!post.reusableAsTemplate);
  assert.ok(!post.legalHold);

  // The first history entry is the draft and nothing else: a scheduled post
  // with no approval entry is exactly what this row is.
  assert.equal(history.length, 1);
  assert.equal((history[0] as { type?: unknown }).type, "draft");

  assert.equal(audit.action, MARKETING_S2B2_ACTIONS.postAutonomousScheduled);
  assert.equal(audit.targetType, "MarketingPost");
  assert.equal(audit.targetId, "post-new");
  assert.equal(metadata.admissionCodeDigest, CODE_DIGEST);
  assert.equal(metadata.configGeneration, GENERATION);
  assert.equal(metadata.deploymentId, DEPLOYMENT_ID);
  assert.equal(metadata.commitSha, COMMIT_SHA);
  assert.equal(metadata.templateId, TEMPLATE_ID);
});

test("the action name is its own constant, not an S2b1 entry", () => {
  assert.deepEqual(Object.values(MARKETING_S2B2_ACTIONS), [
    "marketing_post.autonomous_scheduled",
  ]);
});

// ---------------------------------------------------------------------------
// The eight refusals the plan names
// ---------------------------------------------------------------------------

test("refuses a template that was edited out from under the binding", async () => {
  // The `FOR SHARE` row is there, but the conditional read no longer matches:
  // an edit moved `historyVersion` or `envelopeDigest` on.
  assert.equal(
    await refusal({ templateMatches: false }),
    "autonomous_insert_template_changed",
  );
});

test("refuses a template that was purged or deleted", async () => {
  // Nothing to hold. Purge and delete look the same from here and should: in
  // both cases the row this decision was about is gone.
  assert.equal(
    await refusal({ templateHeld: false }),
    "autonomous_insert_template_gone",
  );
});

test("refuses a channel whose lifecycle moved off autonomous mode", async () => {
  const stopped: MarketingChannelStatus[] = [
    "approval_mode",
    "paused",
    "disconnected",
    "connect_pending",
  ];
  for (const status of stopped) {
    assert.equal(
      await refusal({ channel: channelRow({ status }) }),
      "autonomous_insert_channel_not_autonomous",
      `status ${status} must not be written to without a person`,
    );
  }
});

test("refuses a budget or switch that says no, whatever else is true", async () => {
  // The resolver's answer is the whole budget question at this layer: it is
  // what reads the provider budget, and a false from it is final here.
  assert.equal(
    await refusal({}, { resolveAdmission: admission({ autonomousPublish: false }) }),
    "autonomous_insert_not_admitted",
  );
});

test("refuses when an AppSetting generation moved after the decision", async () => {
  assert.equal(
    await refusal(
      {},
      { resolveAdmission: admission({ configGeneration: GENERATION + 1 }) },
    ),
    "autonomous_insert_config_generation_changed",
  );
});

test("refuses when a claim's prior publication is no longer there", async () => {
  // The phantom, in the direction that can actually happen: an autonomous
  // decision needs every claim used before, so a concurrent unpublish, delete
  // or retention purge is what invalidates it -- not a new use.
  assert.equal(
    await refusal({ usedClaimIds: [] }),
    "autonomous_insert_claim_no_longer_used",
  );
  assert.equal(
    await refusal({ usedAssetIds: [] }),
    "autonomous_insert_asset_no_longer_used",
  );
});

test("refuses a health observation that is stale, future or another connection", () => {
  const observedAt = new Date(NOW.getTime() - 5_000);
  const expect = { channelId: CHANNEL_ID, connectionGeneration: 1 };
  const healthy = { channelId: CHANNEL_ID, connectionGeneration: 1, healthy: true };

  assert.equal(marketingHealthIsFresh({ ...healthy, observedAt }, NOW, expect), true);
  assert.equal(marketingHealthIsFresh(null, NOW, expect), false);
  assert.equal(
    marketingHealthIsFresh(
      {
        ...healthy,
        observedAt: new Date(
          NOW.getTime() - (MARKETING_HEALTH_FRESHNESS_SECONDS + 1) * 1000,
        ),
      },
      NOW,
      expect,
    ),
    false,
    "an observation older than the threshold is about a different moment",
  );
  assert.equal(
    marketingHealthIsFresh(
      { ...healthy, observedAt: new Date(NOW.getTime() + 1_000) },
      NOW,
      expect,
    ),
    false,
    "a future observation is a clock disagreement, not a fresher answer",
  );
  assert.equal(
    marketingHealthIsFresh(
      { ...healthy, connectionGeneration: 2, observedAt },
      NOW,
      expect,
    ),
    false,
    "health observed on the previous connection is not this connection's",
  );
  assert.equal(
    marketingHealthIsFresh({ ...healthy, channelId: "chn_other", observedAt }, NOW, expect),
    false,
  );
  assert.equal(
    marketingHealthIsFresh({ ...healthy, healthy: false, observedAt }, NOW, expect),
    false,
  );
  assert.equal(
    marketingHealthIsFresh({ ...healthy, observedAt }, NOW, expect, 0),
    false,
    "a non-positive threshold admits nothing rather than everything",
  );
});

test("refuses a code digest that is not this build's", async () => {
  assert.equal(
    await refusal(
      {},
      { resolveAdmission: admission({ admissionCodeDigest: "f".repeat(64) }) },
    ),
    "autonomous_insert_code_digest_changed",
  );
});

test("refuses a deployment fence that no longer matches", async () => {
  assert.equal(
    await refusal(
      {},
      { resolveAdmission: admission({ deploymentId: "deployment-2" }) },
    ),
    "autonomous_insert_deployment_changed",
  );
});

// ---------------------------------------------------------------------------
// The rest of the shape
// ---------------------------------------------------------------------------

test("refuses a slot that is not in the future at the database's clock", async () => {
  assert.equal(
    await refusal({ now: new Date(SLOT.getTime() + 1) }),
    "autonomous_insert_slot_not_future",
  );
});

test("refuses facts that are not the ones the decision was sealed over", async () => {
  // The digests are recomputed, so this is not "a different object" but "a
  // different answer": the same claim, said to have been used before by the
  // decision and not by these facts.
  const facts = sealedFacts();
  const other = sealMarketingFacts({
    channelId: CHANNEL_ID,
    channel: "linkedin",
    locale: "en",
    claims: [
      {
        claimId: CLAIM_ID,
        type: "feature",
        known: true,
        featurePublic: true,
        evidenceStatement: TEMPLATE_TEXT,
        usedBefore: false,
      },
    ],
    assets: [{ assetId: ASSET_ID, known: true, usedBefore: true }],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshotDigest,
  });
  assert.equal(
    await refusal({}, { decision: autonomousDecision(facts), facts: other }),
    "autonomous_insert_facts_mismatch",
  );
});

test("refuses a channel that may never be autonomous, even in autonomous mode", async () => {
  // Belt and braces with the database's own CHECK. A row that reached
  // `autonomous_mode` on a channel O15 names is a bug somewhere else, and this
  // is not the write to discover it on.
  const noAutonomy: MarketingChannel[] = ["instagram", "tiktok"];
  for (const channel of noAutonomy) {
    assert.equal(
      await refusal(
        { channel: channelRow({ channel, accountSlug: `${channel}-1` }) },
        { channel },
      ),
      "autonomous_insert_channel_has_no_autonomy",
    );
  }
});

test("every refusal this function raises has an HTTP meaning", () => {
  const source = readInsertSource();
  const raised = [...source.matchAll(/"(autonomous_insert_[a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(raised.length >= 12, "the sweep found suspiciously few refusals");
  for (const code of new Set(raised)) {
    assert.ok(
      typeof MARKETING_REFUSAL_STATUS[code] === "number",
      `${code} is raised with no status`,
    );
  }
});

test("prior use is a question about publication, not about intent", () => {
  // `scheduled` and `approved` are deliberately absent: nothing has left for
  // the platform, so two posts may legitimately be queued for one claim.
  // `failed` is absent because the adapter confirmed nothing was published;
  // `outcome_unknown` is present because it confirmed nothing at all.
  assert.deepEqual(
    [...MARKETING_PRIOR_USE_STATUSES],
    ["publishing", "published", "outcome_unknown", "verified", "removed_by_platform"],
  );
});

test("a serialization failure is recognised and bounded", () => {
  assert.equal(marketingSerializationFailure({ code: "40001" }), true);
  assert.equal(marketingSerializationFailure({ code: "23505" }), false);
  assert.equal(marketingSerializationFailure(new Error("deadlock")), false);
  assert.equal(marketingSerializationFailure(null), false);
  assert.ok(MARKETING_SERIALIZATION_RETRIES > 0);
  assert.ok(Number.isSafeInteger(MARKETING_SERIALIZATION_RETRIES));
});

test("the configuration generation is a positive integer or nothing", () => {
  assert.equal(marketingConfigGeneration('{"generation":1}'), 1);
  assert.equal(marketingConfigGeneration('{"generation":42}'), 42);
  assert.equal(marketingConfigGeneration('{"generation":0}'), null);
  assert.equal(marketingConfigGeneration('{"generation":-1}'), null);
  assert.equal(marketingConfigGeneration('{"generation":1.5}'), null);
  assert.equal(marketingConfigGeneration('{"generation":"1"}'), null);
  assert.equal(marketingConfigGeneration("{}"), null);
  assert.equal(marketingConfigGeneration("not json"), null);
  assert.equal(marketingConfigGeneration(null), null);
  assert.equal(marketingConfigGeneration(undefined), null);
});

function readInsertSource() {
  const url = new URL("../lib/marketingStore.ts", import.meta.url);
  const text = readFileSync(url, "utf8");
  const at = text.indexOf("export async function insertAutonomousScheduledMarketingPost");
  assert.ok(at > 0, "the autonomous insert is not where this test looks");
  const end = text.indexOf("\nexport async function appendMarketingPostHistory", at);
  assert.ok(end > at, "the end of the autonomous insert moved");
  return text.slice(at, end);
}
