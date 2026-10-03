// The Zernio adapter: what it does with each answer, and what it refuses to call.
//
// Contract: the S2 plan's "S2d2", plus amendment 4 (approved 2026-09-28) which
// records that Zernio cannot be asked about our own request key and what the
// adapter does instead.
//
// Two response shapes carry most of the risk, and both come from the S0
// verification record rather than from guesswork:
//
//   * **207 is a 2xx.** Zernio returns it for a partial publish. Reading
//     `response.ok` would file a half-published post as published.
//   * **200 is ambiguous.** The spec calls it an `x-request-id` replay in one
//     place and always a TikTok dry-run verdict in another, and the S0 record
//     flags the contradiction as part of C6.

import assert from "node:assert/strict";
import test from "node:test";

import {
  zernioPublishAdapter,
  zernioRequestUuid,
  type ZernioAdapterPorts,
} from "@/lib/zernioPublishAdapter";
import type { MarketingPublishRequest } from "@/lib/marketingPublishAdapter";

const API_KEY = "sk_" + "a".repeat(64);
// Shaped like the real origin, path prefix included. The fixture used to be a
// bare origin, which had no `/api` to lose -- so the URL bug that dropped it
// passed every test here.
const BASE = "https://zernio.test/api";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const adapterWith = (
  responses: Array<{ status: number; body?: unknown } | { throws: Error }>,
  overrides: Partial<ZernioAdapterPorts> = {},
) => {
  const calls: Call[] = [];
  let index = 0;
  const ports: ZernioAdapterPorts = {
    apiKey: API_KEY,
    baseUrl: BASE,
    callBudgetMs: 30_000,
    resolveAssetUrl: async (assetId) => `https://assets.test/${assetId}.jpg`,
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (next && "throws" in next) throw next.throws;
      return {
        status: next?.status ?? 200,
        json: async () => next?.body ?? null,
      } as Response;
    }) as typeof fetch,
    ...overrides,
  };
  return { adapter: zernioPublishAdapter(ports), calls };
};

const request: MarketingPublishRequest = {
  requestKey: "linkedin/linkedin-1/en/2026-09-24/launch",
  channel: "linkedin",
  externalAccountRef: "acct_9",
  locale: "en",
  renderedText: "A sentence about the product.",
  assetIds: [],
  finalUrl: null,
};

const created = (overrides: Record<string, unknown> = {}) => ({
  post: {
    _id: "zpost_1",
    status: "published",
    platforms: [
      {
        platform: "linkedin",
        accountId: "acct_9",
        status: "published",
        platformPostId: "urn:li:share:7100",
        platformPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
      },
    ],
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

test("a 201 with an identified object is published", async () => {
  const { adapter, calls } = adapterWith([{ status: 201, body: created() }]);
  const result = await adapter.publish(request);
  assert.deepEqual(result, {
    outcome: "published",
    // Zernio's id, which is what a later status query must name.
    externalPostId: "zpost_1",
    externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  // The whole URL and the whole body, not their ends: checking a suffix is how
  // a lost `/api` prefix and a missing `publishNow` both passed.
  assert.equal(calls[0]?.url, "https://zernio.test/api/v1/posts");
  assert.deepEqual(calls[0]?.body, {
    content: request.renderedText,
    platforms: [{ platform: "linkedin", accountId: "acct_9" }],
    publishNow: true,
    metadata: { requestKey: request.requestKey, locale: "en" },
  });
  // The post's own logical key is the idempotency key end to end -- as the
  // UUID the headers are documented to take, derived from it deterministically.
  const uuid = zernioRequestUuid(request.requestKey);
  assert.equal(calls[0]?.headers["x-request-id"], uuid);
  assert.equal(calls[0]?.headers["Idempotency-Key"], uuid);
});

test("a 201 whose post or platform is not published is not proof", async () => {
  for (const body of [
    created({ status: "publishing" }),
    created({ status: "draft" }),
    created({
      platforms: [
        {
          platform: "linkedin",
          status: "failed",
          platformPostId: "urn:li:share:7100",
          platformPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
        },
      ],
    }),
  ]) {
    const { adapter } = adapterWith([{ status: 201, body }]);
    assert.deepEqual(await adapter.publish(request), {
      outcome: "outcome_unknown",
      errorCode: "provider_unreadable_response",
    });
  }
});

test("the post id falls back to `id` when `_id` is absent, as the S0 probe reads it", async () => {
  const body = created();
  const { _id: _ignored, ...rest } = body.post;
  void _ignored;
  const { adapter } = adapterWith([{ status: 201, body: { post: { ...rest, id: "zpost_2" } } }]);
  const result = await adapter.publish(request);
  assert.equal(result.outcome === "published" ? result.externalPostId : null, "zpost_2");
});

// ---------------------------------------------------------------------------
// observeHealth
// ---------------------------------------------------------------------------

const healthy = {
  status: "healthy",
  tokenStatus: { valid: true },
  permissions: { canPost: true },
};

test("health asks the account-health endpoint and needs all three answers", async () => {
  const { adapter, calls } = adapterWith([{ status: 200, body: healthy }]);
  assert.deepEqual(await adapter.observeHealth("acct_9", "publish"), {
    capability: "publish",
    healthy: true,
    reason: null,
  });
  assert.equal(calls[0]?.url, "https://zernio.test/api/v1/accounts/acct_9/health");
  assert.equal(calls[0]?.method, "GET");

  for (const body of [
    { ...healthy, status: "warning" },
    { ...healthy, tokenStatus: { valid: false } },
    { ...healthy, permissions: { canPost: false } },
    { status: "healthy" },
    null,
  ]) {
    const { adapter: other } = adapterWith([{ status: 200, body }]);
    const answer = await other.observeHealth("acct_9", "publish");
    assert.equal(answer.healthy, false, JSON.stringify(body));
  }
});

test("a 200 from the health endpoint does not make comments healthy", async () => {
  // Nothing in the response answers for comments, so a post permission is not
  // stretched to cover them.
  const { adapter } = adapterWith([{ status: 200, body: healthy }]);
  assert.deepEqual(await adapter.observeHealth("acct_9", "comments"), {
    capability: "comments",
    healthy: false,
    reason: "capability_not_reported",
  });
});

test("a 207 is a 2xx and is not a success", async () => {
  // The trap the S0 record names: reading `response.ok` here would record a
  // half-published post as published, and one of those platforms may be a channel
  // that cannot retract.
  const { adapter } = adapterWith([{ status: 207, body: created({ status: "partial" }) }]);
  assert.deepEqual(await adapter.publish(request), {
    outcome: "outcome_unknown",
    errorCode: "provider_partial_publish",
  });
});

test("a 200 is ambiguous and is never read as already published", async () => {
  // The spec says a matching x-request-id replays with 200, and also says 200 is
  // always a TikTok dry-run verdict. Nothing in the body separates the two and
  // their consequences are opposite.
  const { adapter } = adapterWith([{ status: 200, body: created() }]);
  assert.deepEqual(await adapter.publish(request), {
    outcome: "outcome_unknown",
    errorCode: "provider_ambiguous_success",
  });
});

test("a 409 is a confirmed failure, and its existing id is not adopted", async () => {
  // Content-hash duplication says *some* post with the same content and media
  // exists on that account within 24 hours. That is not "we already published
  // this", so the id it offers must not become our `externalPostId`.
  const { adapter } = adapterWith([
    { status: 409, body: { details: { existingPostId: "zpost_other" } } },
  ]);
  const result = await adapter.publish(request);
  assert.deepEqual(result, { outcome: "failed", errorCode: "provider_duplicate_content" });
  assert.equal("externalPostId" in result, false);
});

test("a 201 that does not identify what it created is unknown, not published", async () => {
  for (const body of [
    created({ platforms: [{ platform: "linkedin", status: "published" }] }),
    created({ platforms: [] }),
    created({ platforms: [{ platform: "linkedin", platformPostId: "x", platformPostUrl: "http://insecure.test/1" }] }),
    null,
  ]) {
    const { adapter } = adapterWith([{ status: 201, body }]);
    const result = await adapter.publish(request);
    assert.equal(result.outcome, "outcome_unknown");
  }
});

test("a timeout, a dropped connection and a 5xx are all unknown, and none retries", async () => {
  for (const response of [
    { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
    { throws: new Error("socket hang up") },
    { status: 503, body: null },
  ]) {
    const { adapter, calls } = adapterWith([response]);
    const result = await adapter.publish(request);
    assert.equal(result.outcome, "outcome_unknown");
    // **One call, always.** The five-minute x-request-id window is not a licence
    // to retry: the run deadline is four minutes and the period five, so a retry
    // lands near the edge of that window with no way to tell a replay from a
    // second public post.
    assert.equal(calls.length, 1);
  }
});

test("a rate limit is a failure and is not retried either", async () => {
  const { adapter, calls } = adapterWith([{ status: 429, body: { retryAfterSeconds: 30 } }]);
  assert.deepEqual(await adapter.publish(request), {
    outcome: "failed",
    errorCode: "provider_rate_limited",
  });
  assert.equal(calls.length, 1);
});

test("an asset that cannot be resolved stops the publish before anything leaves", async () => {
  // A post missing its image is not the post that was approved.
  const { adapter, calls } = adapterWith([{ status: 201, body: created() }], {
    resolveAssetUrl: async () => null,
  });
  assert.deepEqual(await adapter.publish({ ...request, assetIds: ["asset_1"] }), {
    outcome: "failed",
    errorCode: "asset_unresolved",
  });
  assert.deepEqual(calls, []);
});

test("an asset resolved to a non-HTTPS URL is refused too", async () => {
  const { adapter, calls } = adapterWith([{ status: 201, body: created() }], {
    resolveAssetUrl: async () => "http://assets.test/a.jpg",
  });
  assert.equal(
    (await adapter.publish({ ...request, assetIds: ["asset_1"] })).outcome,
    "failed",
  );
  assert.deepEqual(calls, []);
});

test("a channel with no Zernio platform is refused without a call", async () => {
  const { adapter, calls } = adapterWith([{ status: 201, body: created() }]);
  const result = await adapter.publish({ ...request, channel: "rednote" });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// lookupByRequestKey — the one that cannot be asked
// ---------------------------------------------------------------------------

test("the lookup by our own key makes no call and says it cannot answer", async () => {
  // Amendment 4, option A. `GET /v1/posts` has no metadata filter and the
  // x-request-id window is both short and, per C6, ambiguous when it hits. Paging
  // the list endpoint would spend the rate limit to produce a guess that looks
  // like proof, so the adapter answers honestly instead.
  const { adapter, calls } = adapterWith([{ status: 200, body: null }]);
  assert.deepEqual(await adapter.lookupByRequestKey(request.requestKey, "acct_9"), {
    outcome: "outcome_unknown",
    errorCode: "no_lookup_by_request_key",
  });
  assert.deepEqual(calls, [], "there is nothing to call");
});

test("capabilities says so, rather than leaving a caller to find out", async () => {
  const { adapter } = adapterWith([]);
  const capabilities = await adapter.capabilities("linkedin");
  assert.equal(capabilities.canLookupByRequestKey, false);
  assert.equal(capabilities.canRetract, true);
});

test("a channel Zernio has no platform for can retract nothing", async () => {
  // RedNote is posted by hand; Zernio does not carry it.
  const { adapter } = adapterWith([]);
  const capabilities = await adapter.capabilities("rednote");
  assert.equal(capabilities.canRetract, false);
  assert.equal(capabilities.canMonitorComments, false);
});

test("TikTok can be published to and cannot be retracted", async () => {
  // The S0 record lists the platforms unpublish accepts and TikTok is not among
  // them. Policy O15 lets a channel reach autonomous mode only if a post can be
  // taken back through the API, and this is what the resolver reads -- so
  // deriving retraction from the publish map would have opened autonomous posting
  // to a channel whose mistakes cannot be undone.
  const { adapter } = adapterWith([]);
  const capabilities = await adapter.capabilities("tiktok");
  assert.equal(capabilities.canRetract, false);
  // And it is still publishable, which is why the two are separate lists.
  const { adapter: publisher, calls } = adapterWith([{ status: 201, body: created() }]);
  await publisher.publish({ ...request, channel: "tiktok" });
  assert.equal(calls.length, 1);
  assert.equal((calls[0]?.body as { platforms: Array<{ platform: string }> }).platforms[0].platform, "tiktok");
});

// ---------------------------------------------------------------------------
// lookupStatus — the question Zernio *can* answer
// ---------------------------------------------------------------------------

test("a status query is about one account's copy, and never guesses removal", async () => {
  // The target the question names, among several: the post's own status is an
  // aggregate, and the first version read it and platforms[0].
  const twoTargets = {
    post: {
      _id: "zpost_1",
      status: "partial",
      platforms: [
        { platform: "linkedin", accountId: "acct_A", status: "failed" },
        {
          platform: "linkedin",
          accountId: { _id: "acct_B" },
          status: "published",
          platformPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:7200",
        },
      ],
    },
  };
  const askedB = adapterWith([{ status: 200, body: twoTargets }]);
  assert.deepEqual(await askedB.adapter.lookupStatus("zpost_1", "acct_B"), {
    state: "live",
    externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7200",
  });
  const askedA = adapterWith([{ status: 200, body: twoTargets }]);
  assert.deepEqual(await askedA.adapter.lookupStatus("zpost_1", "acct_A"), { state: "not_live" });
  const askedNobody = adapterWith([{ status: 200, body: twoTargets }]);
  assert.deepEqual(await askedNobody.adapter.lookupStatus("zpost_1", "acct_C"), { state: "unknown" });

  const one = (status: string) => ({
    post: { _id: "zpost_1", status, platforms: [{ platform: "linkedin", accountId: "acct_9", status }] },
  });
  for (const [status, state] of [
    ["failed", "not_live"],
    ["cancelled", "not_live"],
    ["publishing", "unknown"],
  ] as const) {
    const { adapter } = adapterWith([{ status: 200, body: one(status) }]);
    assert.equal((await adapter.lookupStatus("zpost_1", "acct_9")).state, state, status);
  }
});

test("a status query answers live or unknown, and never guesses removal", async () => {
  // The earlier version of this test pinned 404 and `cancelled` as "removed" --
  // the adapter and its test agreeing with each other and not with the provider.
  // `cancelled` is Zernio's row after an unpublish made through Zernio, and a
  // 404 is Zernio's row being gone; neither is the platform removing the post,
  // which is what the publisher would have recorded.
  const cases: Array<[{ status: number; body?: unknown }, string]> = [
    [{ status: 200, body: created() }, "live"],
    // Zernio's row gone is not the platform's copy gone.
    [{ status: 404, body: null }, "unknown"],
    [{ status: 500, body: null }, "unknown"],
  ];
  for (const [response, state] of cases) {
    const { adapter } = adapterWith([response]);
    const result = await adapter.lookupStatus("zpost_1", "acct_9");
    assert.equal(result.state, state, JSON.stringify(response));
  }
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test("cancelling a live post unpublishes it rather than deleting it", async () => {
  // `DELETE /v1/posts/{id}` only removes drafts and scheduled posts -- the record
  // says published posts cannot be deleted -- so retraction is unpublish.
  const { adapter, calls } = adapterWith([{ status: 200, body: null }]);
  assert.deepEqual(await adapter.cancel("zpost_1", "acct_9", "linkedin"), {
    cancelled: true,
    errorCode: null,
  });
  assert.equal(calls[0]?.url, "https://zernio.test/api/v1/posts/zpost_1/unpublish");
  assert.equal(calls[0]?.method, "POST");
  // The body the endpoint requires. The first version sent `{}`, and its test
  // never looked at the body, so a 400 in production was a pass here.
  assert.deepEqual(calls[0]?.body, { platform: "linkedin", accountId: "acct_9" });
});

test("a cancel the provider refuses for a missing field is not a cancel", async () => {
  const { adapter } = adapterWith([{ status: 400, body: { error: "platform is required" } }]);
  assert.deepEqual(await adapter.cancel("zpost_1", "acct_9", "x"), {
    cancelled: false,
    errorCode: "provider_bad_request",
  });
});

test("a channel the unpublish endpoint does not cover is refused without a call", async () => {
  for (const channel of ["tiktok", "instagram", "rednote"] as const) {
    const { adapter, calls } = adapterWith([{ status: 200, body: null }]);
    assert.deepEqual(await adapter.cancel("zpost_1", "acct_9", channel), {
      cancelled: false,
      errorCode: "provider_cannot_retract",
    });
    assert.equal(calls.length, 0, channel);
  }
});

test("a refused cancel reports a closed code, not the provider's words", async () => {
  const { adapter } = adapterWith([
    { status: 403, body: { message: "your token lacks scope publish:write" } },
  ]);
  const result = await adapter.cancel("zpost_1", "acct_9", "linkedin");
  assert.deepEqual(result, { cancelled: false, errorCode: "provider_unauthorized" });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

test("the key is sent as a bearer token and appears nowhere else", async () => {
  const { adapter, calls } = adapterWith([{ status: 201, body: created() }]);
  await adapter.publish(request);
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${API_KEY}`);
  // Not in the body, and not in any other header.
  assert.equal(JSON.stringify(calls[0]?.body).includes(API_KEY), false);
  const otherHeaders = Object.entries(calls[0]?.headers ?? {}).filter(
    ([name]) => name !== "Authorization",
  );
  for (const [, value] of otherHeaders) {
    assert.equal(String(value).includes(API_KEY), false);
  }
});

test("no error code this adapter returns carries provider prose", async () => {
  const { adapter } = adapterWith([
    { status: 422, body: { message: "content violates policy X for account acct_9" } },
  ]);
  const result = await adapter.publish(request);
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.errorCode, "provider_rejected_content");
    assert.equal(result.errorCode.includes("acct_9"), false);
  }
});

test("the module reads no environment variable and constructs no client of its own", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../lib/zernioPublishAdapter.ts", import.meta.url), "utf8"),
  );
  // The credential arrives in the ports. Nothing in lib/ may hold a marketing
  // platform credential, and a module that could read one from the process is
  // holding one.
  // **Read as code, not as text.** The first version matched this file own
  // comment saying it does not read the environment, which is the difference
  // between what a module does and what it says about itself.
  const ts = (await import("typescript")).default;
  const tree = ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const walk = (node: import("typescript").Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      offenders.push("process.env");
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "PrismaClient"
    ) {
      offenders.push("new PrismaClient");
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  assert.deepEqual(offenders, []);
  // And the walk would notice, which a walk that visits nothing would not.
  const probe = ts.createSourceFile(
    "probe.ts",
    "export const k = process.env.ZERNIO_API_KEY;",
    ts.ScriptTarget.Latest,
    true,
  );
  const seen: string[] = [];
  const probeWalk = (node: import("typescript").Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      seen.push("process.env");
    }
    ts.forEachChild(node, probeWalk);
  };
  probeWalk(probe);
  assert.deepEqual(seen, ["process.env"]);
});

test("the request id is a version-5 UUID, the same for the same post and different otherwise", () => {
  // `x-request-id` is documented as `format: uuid`; the logical key has
  // slashes in it and was sent as is.
  const uuid = zernioRequestUuid(request.requestKey);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(zernioRequestUuid(request.requestKey), uuid);
  assert.notEqual(zernioRequestUuid(request.requestKey + "x"), uuid);
});
