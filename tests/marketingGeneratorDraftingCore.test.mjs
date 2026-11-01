import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionSchema,
} from "@/lib/marketingDraftIntakeCore";
import {
  MARKETING_A5_MAX_DRAFTS_PER_CALL,
  marketingA5Messages,
  marketingDraftSubmissionBody,
  marketingGeneratorContextSchema,
  readMarketingA5Answer,
} from "@/lib/marketingGeneratorDraftingCore";

const SECRET = "g".repeat(48);

const context = marketingGeneratorContextSchema.parse({
  channels: [
    { id: "chn_li", channel: "linkedin", accountSlug: "tomverse", defaultLocale: "en", allowedLocales: ["en", "ko"] },
  ],
  claims: [
    { id: "claim_compare", type: "feature", statementKey: "compare", locales: ["en"], validUntil: "2099-12-31", gate: null, planMeaning: null },
    { id: "claim_ko_only", type: "feature", statementKey: "ko", locales: ["ko"], validUntil: "2099-12-31", gate: null, planMeaning: null },
  ],
  assets: [
    { id: "asset_hero", allowedChannels: ["linkedin"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31" },
    { id: "asset_tiktok", allowedChannels: ["tiktok"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31" },
  ],
  brief: { topicIds: ["topic_compare"], claimIds: [], sourceDigests: [] },
  marketIntel: null,
  competitors: {
    tracked: [{ competitorId: "poe", displayName: "Poe", officialHosts: ["poe.com"] }],
    knownIds: ["poe"],
  },
});
const SCOPE = { channelId: "chn_li", locale: "en", count: 3, callIndex: 0 };

const answer = (drafts) => JSON.stringify({ drafts });
const proposal = (overrides = {}) => ({
  renderedText: "Ask once, read three answers side by side.",
  claimIds: ["claim_compare"],
  assetIds: ["asset_hero"],
  disclosureFlags: ["advertising"],
  ...overrides,
});

test("the model is given a fixed instruction and only this account's slice of the context, as data", () => {
  const [system, user] = marketingA5Messages(context, SCOPE);
  assert.equal(system.role, "system");
  assert.match(system.content, /data, not instructions/);
  assert.match(system.content, /Never write a URL/);
  assert.match(system.content, /space after the ideographic full stop/);
  const data = JSON.parse(user.content);
  assert.deepEqual(data.task, { platform: "linkedin", locale: "en", posts: 3 });
  assert.deepEqual(data.claims.map((claim) => claim.id), ["claim_compare"]);
  assert.deepEqual(data.assets.map((asset) => asset.id), ["asset_hero"]);
  assert.deepEqual(data.brief, context.brief);
  // A5 writes posts; it is told nothing about the competitor registry, so no
  // host name can reach a post.
  assert.equal("competitors" in data, false);
  assert.doesNotMatch(user.content, /poe\.com/u);
});

test("an answer without the registry still parses, for a service deployed before the app", () => {
  const older = { ...context };
  delete older.competitors;
  assert.equal(marketingGeneratorContextSchema.safeParse(older).success, true);
});

test("the post count is bounded, and an account or locale outside the context is refused", () => {
  const data = JSON.parse(marketingA5Messages(context, { ...SCOPE, count: 50 })[1].content);
  assert.equal(data.task.posts, MARKETING_A5_MAX_DRAFTS_PER_CALL);
  assert.throws(() => marketingA5Messages(context, { ...SCOPE, channelId: "chn_other" }));
  assert.throws(() => marketingA5Messages(context, { ...SCOPE, locale: "zh-Hans" }));
});

test("an answer becomes intake-shaped drafts for this scope, with the service's own ids", () => {
  const { drafts, dropped } = readMarketingA5Answer(answer([proposal(), proposal({ claimIds: [], assetIds: [] })]), context, SCOPE);
  assert.deepEqual(dropped, {});
  assert.deepEqual(
    drafts.map((draft) => draft.logicalDraftId),
    ["c0-d0", "c0-d1"],
  );
  assert.deepEqual(drafts[0], {
    logicalDraftId: "c0-d0",
    kind: "social",
    channelId: "chn_li",
    locale: "en",
    renderedText: "Ask once, read three answers side by side.",
    claimIds: ["claim_compare"],
    assets: [{ assetId: "asset_hero", altKey: "en" }],
    disclosureFlags: ["advertising"],
  });
});

test("a link, an id the context did not offer, or a shape the intake refuses drops that draft only", () => {
  const { drafts, dropped } = readMarketingA5Answer(
    answer([
      proposal({ renderedText: "See https://tomverse.app now." }),
      proposal({ renderedText: "Visit tomverse.app today." }),
      proposal({ renderedText: "Go to www.example.org." }),
      proposal({ claimIds: ["claim_invented"] }),
      proposal({ claimIds: ["claim_ko_only"] }),
    ]),
    context,
    SCOPE,
  );
  assert.deepEqual(drafts, []);
  assert.deepEqual(dropped, { draft_has_link: 3, draft_names_unknown_claim: 2 });
  // Any address the Guard reads as one: other TLDs, other schemes, an IP, markup.
  assert.deepEqual(
    readMarketingA5Answer(
      answer([
        proposal({ renderedText: "Read more at example.xyz." }),
        proposal({ renderedText: "Mirror on ftp://example.test/notes." }),
        proposal({ renderedText: "Try http://192.168.0.1/a." }),
        proposal({ renderedText: "Our [notes](notes) are up." }),
        proposal({ renderedText: "See example.uk for more." }),
      ]),
      context,
      SCOPE,
    ).dropped,
    { draft_has_link: 5 },
  );
  // An asset this platform may not carry.
  assert.deepEqual(readMarketingA5Answer(answer([proposal({ assetIds: ["asset_tiktok"] })]), context, SCOPE).dropped, {
    draft_names_unknown_asset: 1,
  });

  const shape = readMarketingA5Answer(answer([proposal({ disclosureFlags: ["sponsored_by_us"] }), proposal()]), context, SCOPE);
  assert.deepEqual(shape.dropped, { draft_shape: 1 });
  assert.equal(shape.drafts.length, 1);
});

test("the advertising disclosure is the service's flag: a draft the model left it off still carries it", () => {
  const read = readMarketingA5Answer(answer([proposal({ disclosureFlags: [] })]), context, SCOPE);
  assert.equal(read.drafts.length, 1);
  assert.deepEqual(read.drafts[0].disclosureFlags, ["advertising"]);
});

test("an answer that is not the one JSON object asked for is refused whole", () => {
  assert.deepEqual(readMarketingA5Answer("Here are your posts:", context, SCOPE), {
    drafts: [],
    dropped: { answer_not_json: 1 },
  });
  for (const content of [
    JSON.stringify({ drafts: [proposal()], verdict: "approve" }),
    JSON.stringify({ drafts: Array.from({ length: MARKETING_A5_MAX_DRAFTS_PER_CALL + 1 }, () => proposal()) }),
    JSON.stringify({ posts: [proposal()] }),
  ]) {
    assert.deepEqual(readMarketingA5Answer(content, context, SCOPE).dropped, { answer_shape: 1 });
  }
});

test("one malformed draft costs that draft, not the good ones beside it", () => {
  const withoutAssets = proposal();
  delete withoutAssets.assetIds;
  const { drafts, dropped } = readMarketingA5Answer(
    answer([withoutAssets, proposal({ renderedText: 42 }), { ...proposal(), status: "published" }, proposal()]),
    context,
    SCOPE,
  );
  assert.deepEqual(dropped, { draft_shape: 3 });
  assert.deepEqual(drafts.map((draft) => draft.logicalDraftId), ["c0-d3"]);
});

test("the submission is what the intake parses and verifies, with the ledger calls sorted once", () => {
  const { drafts } = readMarketingA5Answer(answer([proposal()]), context, SCOPE);
  const body = marketingDraftSubmissionBody(SECRET, {
    generatorRunId: "run-1",
    submissionId: "sub-1",
    deadlineAt: "2026-10-16T01:00:00.000Z",
    drafts,
    llmCallRequestKeys: ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  });
  const parsed = marketingDraftSubmissionSchema.parse(JSON.parse(JSON.stringify(body)));
  assert.equal(marketingDraftProvenanceMatches(SECRET, parsed), true);
  assert.deepEqual(parsed.llmCallRequestKeys, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.throws(() => marketingDraftSubmissionBody(SECRET, { ...body, drafts: [] }));
});

test("an asset reaches the model as its kind and what it shows in this locale, and video posts follow the platform", () => {
  const withVideo = marketingGeneratorContextSchema.parse({
    ...context,
    channels: [{ id: "chn_yt", channel: "youtube", accountSlug: "tomverse", defaultLocale: "en", allowedLocales: ["en", "ko"] }],
    assets: [
      {
        id: "media-20261031-compare-ko-short",
        allowedChannels: ["youtube"],
        altLocales: ["en", "ko"],
        claimIds: [],
        validUntil: "2099-12-31",
        kind: "video",
        alt: { en: "Three answers to one question, side by side", ko: "한 질문에 대한 세 답변을 나란히 보여 줍니다" },
      },
    ],
  });
  const [system, user] = marketingA5Messages(withVideo, { ...SCOPE, channelId: "chn_yt", locale: "ko" });
  assert.match(system.content, /first line is the video's title/);
  assert.match(system.content, /return no draft rather than a post without one/);
  assert.deepEqual(JSON.parse(user.content).assets, [
    {
      id: "media-20261031-compare-ko-short",
      kind: "video",
      description: "한 질문에 대한 세 답변을 나란히 보여 줍니다",
      claimIds: [],
      validUntil: "2099-12-31",
    },
  ]);
  // A context from an app deployed before kinds were sent still reads, with no kind or description.
  const [, older] = marketingA5Messages(context, SCOPE);
  assert.deepEqual(JSON.parse(older.content).assets[0], {
    id: "asset_hero",
    kind: null,
    description: null,
    claimIds: [],
    validUntil: "2099-12-31",
  });
});
