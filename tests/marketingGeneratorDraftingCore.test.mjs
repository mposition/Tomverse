import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionSchema,
} from "@/lib/marketingDraftIntakeCore";
import {
  MARKETING_A5_MAX_DRAFTS_PER_CALL,
  MARKETING_A5_PROMPT_VERSION,
  MARKETING_VIDEO_DAYS,
  marketingA5AssetsFor,
  marketingA5MediaKindFor,
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
    { id: "asset_hero", allowedChannels: ["linkedin"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "image" },
    { id: "asset_tiktok", allowedChannels: ["tiktok"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "video" },
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
  assert.deepEqual(data.task, { platform: "linkedin", locale: "en", posts: 3, hashtags: { min: 2, max: 3 } });
  assert.deepEqual(data.claims.map((claim) => claim.id), ["claim_compare"]);
  assert.deepEqual(data.assets.map((asset) => asset.id), ["asset_hero"]);
  assert.deepEqual(data.brief, { topics: ["topic_compare"], claimIds: [] });
  // A5 writes posts; it is told nothing about the competitor registry, so no
  // host name can reach a post -- and no market facts, so no competitor price.
  assert.equal("competitors" in data, false);
  assert.equal("marketIntel" in data, false);
  assert.doesNotMatch(user.content, /poe\.com/u);
});

test("A5 is told Tomverse has two products and which claims this account used recently", () => {
  const [system, user] = marketingA5Messages(context, SCOPE);
  assert.match(system.content, /Tomverse Chat/);
  assert.match(system.content, /fair turns/);
  assert.match(system.content, /recentClaimIds/);
  // An answer from an app deployed before the field reads as nothing used.
  assert.deepEqual(JSON.parse(user.content).recentClaimIds, []);

  const used = marketingGeneratorContextSchema.parse({
    ...context,
    channels: [{ ...context.channels[0], recentClaimIds: ["claim_compare"] }],
  });
  const data = JSON.parse(marketingA5Messages(used, SCOPE)[1].content);
  assert.deepEqual(data.recentClaimIds, ["claim_compare"]);
  // Guidance only: the claim is still offered, so a post that needs it can use it.
  assert.deepEqual(data.claims.map((claim) => claim.id), ["claim_compare"]);
});

test("a claim reaches A5 as what a post making it must say in this locale, and the brief as ids", () => {
  const withWords = marketingGeneratorContextSchema.parse({
    ...context,
    claims: [
      {
        id: "claim_compare",
        type: "feature",
        statementKey: "compare",
        locales: ["en", "ko"],
        validUntil: "2099-12-31",
        gate: null,
        planMeaning: null,
        statements: { en: "Read three answers side by side.", ko: "세 답변을 나란히 읽습니다." },
        values: null,
      },
      {
        id: "claim_price",
        type: "pricing",
        statementKey: "price",
        locales: ["en"],
        validUntil: "2099-12-31",
        gate: null,
        planMeaning: null,
        statements: {},
        values: { name: "Pro", monthlyPriceCents: 1500, currency: "USD" },
      },
    ],
    // As the context route sends it: the latest brief report.
    brief: {
      reportId: "r1",
      periodEnd: "2026-11-01T00:00:00.000Z",
      payload: { topicIds: ["side-by-side"], claimIds: ["claim_compare"], sourceDigests: [] },
    },
  });
  const [system, user] = marketingA5Messages(withWords, SCOPE);
  assert.match(system.content, /exactly as given, character for character/);
  assert.match(system.content, /Do not name another product or company/);
  const data = JSON.parse(user.content);
  assert.deepEqual(data.claims, [
    { id: "claim_compare", type: "feature", statement: "Read three answers side by side.", values: null },
    { id: "claim_price", type: "pricing", statement: null, values: { name: "Pro", monthlyPriceCents: 1500, currency: "USD" } },
  ]);
  assert.deepEqual(data.brief, { topics: ["side-by-side"], claimIds: ["claim_compare"] });
  // No brief, or one this cannot read, is no brief.
  assert.equal(JSON.parse(marketingA5Messages({ ...withWords, brief: null }, SCOPE)[1].content).brief, null);
  assert.equal(JSON.parse(marketingA5Messages({ ...withWords, brief: { payload: "x" } }, SCOPE)[1].content).brief, null);
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
  const { drafts, dropped } = readMarketingA5Answer(answer([proposal(), proposal({ claimIds: [] })]), context, SCOPE);
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
    hashtagsRemoved: {},
  });
  for (const content of [
    JSON.stringify({ drafts: [proposal()], verdict: "approve" }),
    JSON.stringify({ drafts: Array.from({ length: MARKETING_A5_MAX_DRAFTS_PER_CALL + 1 }, () => proposal()) }),
    JSON.stringify({ posts: [proposal()] }),
  ]) {
    assert.deepEqual(readMarketingA5Answer(content, context, SCOPE).dropped, { answer_shape: 1 });
  }
});

test("a draft that carries no image or video is dropped, on every platform", () => {
  // Owner decision 2026-11-03: there are no text-only posts.
  const { drafts, dropped } = readMarketingA5Answer(
    answer([proposal({ assetIds: [] }), proposal()]),
    context,
    SCOPE,
  );
  assert.deepEqual(dropped, { draft_has_no_asset: 1 });
  assert.deepEqual(drafts.map((draft) => draft.logicalDraftId), ["c0-d1"]);
});

test("an account is offered only media the publisher can send there: a stored file, and a video where only video goes", () => {
  const mixed = marketingGeneratorContextSchema.parse({
    ...context,
    assets: [
      { id: "media-card", allowedChannels: ["linkedin", "youtube"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "image" },
      { id: "media-short", allowedChannels: ["youtube"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "video" },
      // A hand-kept registry entry has no stored file and never resolves.
      { id: "asset_hand_kept", allowedChannels: ["linkedin"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31" },
    ],
  });
  assert.deepEqual(marketingA5AssetsFor(mixed, "linkedin", "en").map((asset) => asset.id), ["media-card"]);
  assert.deepEqual(marketingA5AssetsFor(mixed, "youtube", "en").map((asset) => asset.id), ["media-short"]);
  assert.deepEqual(marketingA5AssetsFor(mixed, "tiktok", "en"), []);
  assert.deepEqual(marketingA5AssetsFor(mixed, "linkedin", "ko"), []);
});

test("each platform's video days follow the owner's ratio, spread evenly, with the other kind standing in", () => {
  // Owner decision 2026-11-04: Instagram video 2 of 4, Facebook 2 of 5,
  // LinkedIn 1 of 3, X 3 of 10, Threads 2 of 7; YouTube and TikTok video only.
  const both = (channel) =>
    marketingGeneratorContextSchema.parse({
      ...context,
      assets: [
        { id: "media-card", allowedChannels: [channel], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "image" },
        { id: "media-short", allowedChannels: [channel], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "video" },
      ],
    });
  for (const [channel, video, of] of [
    ["instagram", 2, 4],
    ["facebook", 2, 5],
    ["linkedin", 1, 3],
    ["x", 3, 10],
    ["threads", 2, 7],
    ["youtube", 1, 1],
    ["tiktok", 1, 1],
  ]) {
    assert.deepEqual(MARKETING_VIDEO_DAYS[channel], { video, of }, channel);
    // Any run of `of` consecutive days holds exactly `video` video days.
    for (const start of [0, 20_400, 20_761]) {
      const kinds = Array.from({ length: of }, (_, index) => marketingA5MediaKindFor(both(channel), channel, "en", start + index));
      assert.equal(kinds.filter((kind) => kind === "video").length, video, `${channel} from day ${start}`);
    }
  }
  // Instagram alternates rather than bunching its video days.
  const instagram = Array.from({ length: 4 }, (_, index) => marketingA5MediaKindFor(both("instagram"), "instagram", "en", index));
  assert.deepEqual(instagram, ["image", "video", "image", "video"]);

  // No approved video for Facebook: its video days carry an image instead.
  const imagesOnly = marketingGeneratorContextSchema.parse({
    ...context,
    assets: [{ id: "media-card", allowedChannels: ["facebook"], altLocales: ["ko"], claimIds: [], validUntil: "2099-12-31", kind: "image" }],
  });
  for (let day = 0; day < 5; day += 1) assert.equal(marketingA5MediaKindFor(imagesOnly, "facebook", "ko", day), "image");
  // Nothing that fits at all.
  assert.equal(marketingA5MediaKindFor(imagesOnly, "facebook", "en", 0), null);
  assert.equal(marketingA5MediaKindFor(imagesOnly, "youtube", "ko", 0), null);
});

test("a call for one kind offers and accepts only assets of that kind", () => {
  const mixed = marketingGeneratorContextSchema.parse({
    ...context,
    assets: [
      { id: "media-card", allowedChannels: ["linkedin"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "image" },
      { id: "media-short", allowedChannels: ["linkedin"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind: "video" },
    ],
  });
  const videoScope = { ...SCOPE, mediaKind: "video" };
  const offered = JSON.parse(marketingA5Messages(mixed, videoScope)[1].content).assets.map((asset) => asset.id);
  assert.deepEqual(offered, ["media-short"]);
  const { drafts, dropped } = readMarketingA5Answer(
    answer([proposal({ assetIds: ["media-card"] }), proposal({ assetIds: ["media-short"] })]),
    mixed,
    videoScope,
  );
  assert.deepEqual(dropped, { draft_names_unknown_asset: 1 });
  assert.deepEqual(drafts.map((draft) => draft.assets[0].assetId), ["media-short"]);
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
  assert.match(system.content, /Every post carries one asset from the assets list, an image or a video, on every platform/);
  assert.doesNotMatch(system.content, /When no asset fits a post, return no draft/);
  assert.deepEqual(JSON.parse(user.content).assets, [
    {
      id: "media-20261031-compare-ko-short",
      kind: "video",
      description: "한 질문에 대한 세 답변을 나란히 보여 줍니다",
      claimIds: [],
      validUntil: "2099-12-31",
      publishedCopies: [],
    },
  ]);
  // An image with no alt text in this locale still reaches the model, with no description.
  const [, plain] = marketingA5Messages(context, SCOPE);
  assert.deepEqual(JSON.parse(plain.content).assets[0], {
    id: "asset_hero",
    kind: "image",
    description: null,
    claimIds: [],
    validUntil: "2099-12-31",
    publishedCopies: [],
  });
  // An asset that names no kind -- a hand-kept registry entry, or a context from an
  // app deployed before kinds were sent -- has no file the publisher can send, so it
  // is not offered at all.
  const older = marketingGeneratorContextSchema.parse({
    ...context,
    assets: context.assets.map((asset) => {
      const withoutKind = { ...asset };
      delete withoutKind.kind;
      return withoutKind;
    }),
  });
  assert.deepEqual(JSON.parse(marketingA5Messages(older, SCOPE)[1].content).assets, []);
});

test("an asset an account has already used is not offered to it again, and an account on the same platform keeps it", () => {
  // Owner decision 2026-11-04: the same video went out on one account twice.
  const asset = (id, kind) => ({ id, allowedChannels: ["instagram"], altLocales: ["en"], claimIds: [], validUntil: "2099-12-31", kind });
  const twoAccounts = marketingGeneratorContextSchema.parse({
    ...context,
    channels: [
      { id: "chn_ig1", channel: "instagram", accountSlug: "one", defaultLocale: "en", allowedLocales: ["en"], usedAssetIds: ["media-short"] },
      { id: "chn_ig2", channel: "instagram", accountSlug: "two", defaultLocale: "en", allowedLocales: ["en"], usedAssetIds: [] },
    ],
    assets: [asset("media-card", "image"), asset("media-short", "video")],
  });
  const ids = (list) => list.map((entry) => entry.id);
  assert.deepEqual(ids(marketingA5AssetsFor(twoAccounts, "instagram", "en", undefined, "chn_ig1")), ["media-card"]);
  assert.deepEqual(ids(marketingA5AssetsFor(twoAccounts, "instagram", "en", undefined, "chn_ig2")), ["media-card", "media-short"]);
  // Without an account the platform's assets are all listed, as before.
  assert.deepEqual(ids(marketingA5AssetsFor(twoAccounts, "instagram", "en")), ["media-card", "media-short"]);

  // What the model is offered, and what an answer may name.
  const offered = (channelId) =>
    JSON.parse(marketingA5Messages(twoAccounts, { ...SCOPE, channelId })[1].content).assets.map((entry) => entry.id);
  assert.deepEqual(offered("chn_ig1"), ["media-card"]);
  assert.deepEqual(offered("chn_ig2"), ["media-card", "media-short"]);
  const reuse = answer([proposal({ claimIds: [], assetIds: ["media-short"] })]);
  const first = readMarketingA5Answer(reuse, twoAccounts, { ...SCOPE, channelId: "chn_ig1" });
  assert.deepEqual(first.drafts, []);
  assert.deepEqual(first.dropped, { draft_names_unknown_asset: 1 });
  assert.equal(readMarketingA5Answer(reuse, twoAccounts, { ...SCOPE, channelId: "chn_ig2" }).drafts.length, 1);

  // The day's kind gives way to the kind that is left: the used video is not a candidate.
  const videoDay = Array.from({ length: 4 }, (_, day) => day).find(
    (day) => marketingA5MediaKindFor(twoAccounts, "instagram", "en", day, "chn_ig2") === "video",
  );
  assert.notEqual(videoDay, undefined);
  assert.equal(marketingA5MediaKindFor(twoAccounts, "instagram", "en", videoDay, "chn_ig1"), "image");

  // A context from an app deployed before the field still parses and filters nothing.
  const older = marketingGeneratorContextSchema.parse({
    ...twoAccounts,
    channels: twoAccounts.channels.map((channel) => Object.fromEntries(Object.entries(channel).filter(([key]) => key !== "usedAssetIds"))),
  });
  assert.deepEqual(ids(marketingA5AssetsFor(older, "instagram", "en", undefined, "chn_ig1")), ["media-card", "media-short"]);
});

test("the instruction tells the model to write from the assets it was given when none fits the brief", () => {
  const [system] = marketingA5Messages(context, SCOPE);
  assert.match(system.content, /When no asset fits the brief's topic, do not skip the post/);
  assert.match(system.content, /write it about what an asset you were given shows, using only its description/);
  assert.match(system.content, /Whenever the assets list holds at least one asset, write at least one post/);
  assert.match(system.content, /return no draft only when the list is empty/);
  assert.match(system.content, /Never write what an asset's description does not support/);
  assert.match(system.content, /only assets this account has not used yet/);
  assert.match(system.content, /Give each post a different asset/);
  // The old rule that skipped a post is gone, and the version says the instruction changed.
  assert.doesNotMatch(system.content, /return no draft: a post without/);
  assert.equal(MARKETING_A5_PROMPT_VERSION, "a5-social-v7");
});

test("A5 is told when hashtags help, how many each platform takes, and which tags never to write", () => {
  const [system, user] = marketingA5Messages(context, SCOPE);
  assert.equal(MARKETING_A5_PROMPT_VERSION, "a5-social-v7");
  assert.match(system.content, /task\.hashtags gives this platform's range/);
  assert.match(system.content, /fewer or none when a tag would not help/);
  assert.match(system.content, /#Tomverse once is recommended/);
  assert.match(system.content, /Traditional Chinese for zh-Hant, Simplified for zh-Hans/);
  assert.match(system.content, /names another product or company/);
  assert.match(system.content, /#best, #free, #최고 or #무료/);
  assert.match(system.content, /on youtube they go in the description, never the title line, and one of them is #Shorts/i);
  assert.match(system.content, /On threads use at most one/);
  assert.deepEqual(JSON.parse(user.content).task.hashtags, { min: 2, max: 3 });

  const ranges = Object.fromEntries(
    ["instagram", "tiktok", "youtube", "x", "linkedin", "facebook", "threads", "rednote"].map((platform) => {
      const scoped = marketingGeneratorContextSchema.parse({
        ...context,
        channels: [{ ...context.channels[0], channel: platform }],
        assets: [{ ...context.assets[0], allowedChannels: [platform], kind: "video" }],
      });
      return [platform, JSON.parse(marketingA5Messages(scoped, SCOPE)[1].content).task.hashtags];
    }),
  );
  assert.deepEqual(ranges, {
    instagram: { min: 3, max: 5 },
    tiktok: { min: 3, max: 5 },
    youtube: { min: 2, max: 3 },
    x: { min: 1, max: 2 },
    linkedin: { min: 2, max: 3 },
    facebook: { min: 0, max: 2 },
    threads: { min: 0, max: 1 },
    rednote: { min: 3, max: 5 },
  });
});

test("a draft keeps its words and allowed tags; a forbidden tag or one past the maximum is taken out and counted", () => {
  const statement = "Ask once, read three answers side by side.";
  const { drafts, dropped, hashtagsRemoved } = readMarketingA5Answer(
    answer([
      proposal({ renderedText: `${statement}\n\n#AI #ChatGPT #Tomverse #AIcomparison #AItools` }),
      // The registry's competitor, and boasts in two languages.
      proposal({ renderedText: `${statement} #Poe #bestAI #무료체험 #AI` }),
      proposal({ renderedText: statement }),
    ]),
    context,
    SCOPE,
  );
  assert.deepEqual(dropped, {});
  assert.deepEqual(
    drafts.map((draft) => draft.renderedText),
    [`${statement}\n\n#AI #Tomverse #AIcomparison`, `${statement} #AI`, statement],
  );
  assert.deepEqual(hashtagsRemoved, { hashtag_forbidden: 4, hashtag_over_limit: 1 });
});

test("a refused answer removes no hashtags", () => {
  assert.deepEqual(readMarketingA5Answer("not json", context, SCOPE).hashtagsRemoved, {});
});

test("a cross-post sees what other accounts posted with its asset, in its own locale, and is told to write fresh (owner decision 2026-11-06)", () => {
  const withCopies = marketingGeneratorContextSchema.parse({
    ...context,
    assets: context.assets.map((asset) => ({
      ...asset,
      publishedCopies: [
        { locale: SCOPE.locale, text: "Same question. Where do the answers differ?" },
        { locale: "zz-other", text: "not this locale" },
      ],
    })),
  });
  const [system, user] = marketingA5Messages(withCopies, SCOPE);
  assert.match(system.content, /publishedCopies are posts other Tomverse accounts already published with it/);
  assert.match(system.content, /write the post fresh/);
  assert.deepEqual(JSON.parse(user.content).assets[0].publishedCopies, ["Same question. Where do the answers differ?"]);
});
