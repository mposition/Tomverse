// One publisher run's work (S2 plan, S2d2; amendment 4).
//
// The operations and the adapter are fakes here, and that is the point of the
// split: what this module decides is the order of things and what each answer
// leads to, and none of that needs a database. What the operations do inside
// their transactions is tested against the store in the S2d2 store tests and
// measured through the real wrapper in the statement budget test.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_PUBLISHER_DISPATCH_ROOM_MS,
  MARKETING_PUBLISHER_VERIFY_LIMIT,
  MarketingPublisherOutcomeNotRecordedError,
  runMarketingPublisherBatch,
  type MarketingPublisherBatchDeps,
} from "@/lib/marketingPublisherBatch";
import { MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS } from "@/lib/marketingPublisherRunCore";
import type {
  MarketingPublishAdapter,
  MarketingPublishRequest,
  MarketingPublishResult,
} from "@/lib/marketingPublishAdapter";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const DEADLINE = new Date(NOW.getTime() + 4 * 60 * 1000);
const LEASE = new Date(NOW.getTime() + 15 * 60 * 1000);
const TEXT = "Three answers to one question, side by side. 🚀 ";

type Call = { name: string; input?: unknown };

type Scenario = {
  channels?: Array<{ id: string; connectionGeneration: number; externalAccountRef: string }>;
  claim?: unknown;
  dispatch?: unknown;
  publish?: MarketingPublishResult | Error;
  health?: { capability: "publish" | "comments"; healthy: boolean } | Error;
  awaiting?: unknown[];
  status?: unknown;
  heartbeats?: boolean[];
  clock?: Date[];
  recordThrows?: Error;
  /** What each outcome writer answers, when a test needs it to refuse. */
  recordAnswer?: { recorded: boolean; reason?: string };
  stale?: Array<{ id: string; requestKey: string; historyVersion: number }>;
};

const world = (scenario: Scenario = {}) => {
  const calls: Call[] = [];
  const note = (name: string, input?: unknown) => calls.push({ name, input });
  const heartbeats = [...(scenario.heartbeats ?? [])];
  const clock = [...(scenario.clock ?? [])];
  const record = (name: string) => async (input: unknown) => {
    note(name, input);
    if (scenario.recordThrows) throw scenario.recordThrows;
    return scenario.recordAnswer ?? { recorded: true, paused: false };
  };
  const operations = {
    listChannels: async () => {
      note("listChannels");
      return (
        scenario.channels ?? [{ id: "c1", connectionGeneration: 3, externalAccountRef: "acct_9" }]
      );
    },
    listPublishingPastLease: async (input: unknown) => {
      note("listPublishingPastLease", input);
      return scenario.stale ?? [];
    },
    listAwaitingVerification: async (limit: number) => {
      note("listAwaitingVerification", limit);
      return scenario.awaiting ?? [];
    },
    claim: async (input: unknown) => {
      note("claim", input);
      return (
        scenario.claim ?? { claimed: true, id: "p1", leaseUntil: LEASE, historyVersion: 4 }
      );
    },
    release: async (input: unknown) => {
      note("release", input);
      return { released: true };
    },
    dispatch: async (input: unknown) => {
      note("dispatch", input);
      return (
        scenario.dispatch ?? {
          started: true,
          requestKey: "linkedin/linkedin-1/en/2026-10-01/launch",
          attempt: 1,
          approvalExpiresAt: null,
          payload: {
            channel: "linkedin",
            externalAccountRef: "acct_9",
            locale: "en",
            renderedText: TEXT,
            assetIds: [],
            finalUrl: null,
          },
        }
      );
    },
    recordPublished: record("recordPublished"),
    recordFailed: record("recordFailed"),
    recordOutcomeUnknown: async (input: unknown) => {
      note("recordOutcomeUnknown", input);
      if (scenario.recordThrows) throw scenario.recordThrows;
      return scenario.recordAnswer ?? { recorded: true, paused: true };
    },
    recordVerified: async (input: unknown) => {
      note("recordVerified", input);
      return { recorded: true };
    },
  };
  const adapter: MarketingPublishAdapter = {
    provider: "zernio",
    capabilities: async () => {
      throw new Error("not asked");
    },
    observeHealth: async (ref, capability) => {
      note("observeHealth", { ref, capability });
      const health = scenario.health ?? { capability: "publish", healthy: true };
      if (health instanceof Error) throw health;
      return { ...health, reason: null };
    },
    publish: async (request: MarketingPublishRequest) => {
      note("publish", request);
      const answer = scenario.publish ?? {
        outcome: "published",
        externalPostId: "urn:li:share:7100",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
      };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    lookupByRequestKey: async (requestKey) => {
      note("lookupByRequestKey", requestKey);
      return { outcome: "outcome_unknown", errorCode: "no_lookup_by_request_key" };
    },
    lookupStatus: async (externalPostId) => {
      note("lookupStatus", externalPostId);
      return (scenario.status ?? { state: "unknown" }) as never;
    },
    cancel: async () => {
      note("cancel");
      return { cancelled: false, errorCode: null };
    },
  };
  const deps: MarketingPublisherBatchDeps = {
    operations: operations as unknown as MarketingPublisherBatchDeps["operations"],
    adapter,
    databaseNow: async () => {
      note("databaseNow");
      return clock.shift() ?? NOW;
    },
    heartbeat: async () => {
      note("heartbeat");
      return heartbeats.length > 0 ? (heartbeats.shift() as boolean) : true;
    },
  };
  const run = () => runMarketingPublisherBatch(deps, { runId: "run-1", deadlineAt: DEADLINE });
  const named = (name: string) => calls.filter((call) => call.name === name);
  return { run, calls, named };
};

test("a published answer is recorded against the claim's version, after one call", async () => {
  const { run, named, calls } = world();
  const result = await run();
  assert.equal(result.published, 1);
  assert.equal(named("publish").length, 1);
  assert.deepEqual(named("recordPublished")[0]?.input, {
    id: "p1",
    requestKey: "linkedin/linkedin-1/en/2026-10-01/launch",
    expectedHistoryVersion: 4,
    externalPostId: "urn:li:share:7100",
    externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
  });
  // The order the plan requires: health, claim, dispatch, the call, the record.
  const order = calls
    .map((call) => call.name)
    .filter((name) =>
      ["observeHealth", "claim", "dispatch", "publish", "recordPublished"].includes(name),
    );
  assert.deepEqual(order, ["observeHealth", "claim", "dispatch", "publish", "recordPublished"]);
});

test("what is sent is the locked payload, byte for byte", async () => {
  const { run, named } = world();
  await run();
  const sent = named("publish")[0]?.input as MarketingPublishRequest;
  assert.equal(sent.renderedText, TEXT);
  assert.equal(sent.requestKey, "linkedin/linkedin-1/en/2026-10-01/launch");
  assert.equal(sent.externalAccountRef, "acct_9");
});

test("a confirmed failure is recorded as failed", async () => {
  const { run, named } = world({
    publish: { outcome: "failed", errorCode: "provider_rejected_content" },
  });
  const result = await run();
  assert.equal(result.failed, 1);
  assert.equal(
    (named("recordFailed")[0]?.input as { errorCode: string }).errorCode,
    "provider_rejected_content",
  );
  assert.equal(named("recordOutcomeUnknown").length, 0);
});

test("an unanswered publish is outcome_unknown, with no retry and no lookup", async () => {
  // Amendment 4: Zernio cannot be asked about our key, so silence stays silence.
  const { run, named } = world({
    publish: { outcome: "outcome_unknown", errorCode: "provider_timeout" },
  });
  const result = await run();
  assert.equal(result.outcomeUnknown, 1);
  assert.equal(named("publish").length, 1);
  assert.equal(named("lookupByRequestKey").length, 0);
  assert.equal(
    (named("recordOutcomeUnknown")[0]?.input as { errorCode: string }).errorCode,
    "provider_timeout",
  );
});

test("an adapter that throws after dispatch is outcome_unknown, not an error", async () => {
  // By the time the adapter is called a request may have left, so a throw is
  // not a failure anybody can confirm.
  const { run, named } = world({ publish: new Error("socket hang up") });
  const result = await run();
  assert.equal(result.outcomeUnknown, 1);
  assert.equal(
    (named("recordOutcomeUnknown")[0]?.input as { errorCode: string }).errorCode,
    "publisher_call_threw",
  );
});

test("an outcome that cannot be recorded stops the run rather than publish more", async () => {
  const { run, named } = world({
    channels: [
      { id: "c1", connectionGeneration: 3, externalAccountRef: "acct_9" },
      { id: "c2", connectionGeneration: 1, externalAccountRef: "acct_10" },
    ],
    recordThrows: new Error("serialization failure"),
  });
  await assert.rejects(run(), /serialization failure/);
  assert.equal(named("publish").length, 1, "the second account is never published to");
  assert.equal(named("claim").length, 1);
});

test("health is observed fresh, stamped with the database clock before the probe, and passed to both checks", async () => {
  const stamped = new Date(NOW.getTime() + 1_000);
  // The first reading is the recovery pass's; the second is the one the
  // account's health is stamped with.
  const { run, named, calls } = world({ clock: [NOW, stamped] });
  await run();
  const claimHealth = (named("claim")[0]?.input as { health: unknown }).health;
  const dispatchHealth = (named("dispatch")[0]?.input as { health: unknown }).health;
  assert.deepEqual(claimHealth, {
    channelId: "c1",
    connectionGeneration: 3,
    healthy: true,
    observedAt: stamped,
  });
  assert.deepEqual(dispatchHealth, claimHealth);
  const names = calls.map((call) => call.name);
  assert.ok(names.lastIndexOf("databaseNow", names.indexOf("observeHealth")) >= 0);
});

test("a probe that throws, or answers for the wrong capability, is unhealthy", async () => {
  for (const health of [
    new Error("unreachable"),
    { capability: "comments" as const, healthy: true },
  ]) {
    const { run, named } = world({ health });
    await run();
    assert.equal((named("claim")[0]?.input as { health: { healthy: boolean } }).health.healthy, false);
  }
});

test("a refused claim moves on without dispatching", async () => {
  const { run, named } = world({ claim: { claimed: false, reason: "not_admitted" } });
  const result = await run();
  assert.deepEqual(result.refused, { "claim:not_admitted": 1 });
  assert.equal(named("dispatch").length, 0);
  assert.equal(named("publish").length, 0);
});

test("a dispatch refused while the claim is held gives the claim back", async () => {
  const { run, named } = world({ dispatch: { started: false, reason: "not_admitted" } });
  await run();
  assert.deepEqual(named("release")[0]?.input, {
    id: "p1",
    claimToken: "marketing-publisher:run-1",
    expectedLeaseUntil: LEASE,
    expectedHistoryVersion: 4,
    reason: "no_longer_admitted",
  });
  assert.equal(named("publish").length, 0);
});

test("a claim that is no longer this worker's is not released", async () => {
  for (const reason of ["claim_expired", "claim_not_held", "dispatch_conflict", "post_not_scheduled"]) {
    const { run, named } = world({ dispatch: { started: false, reason } });
    await run();
    assert.equal(named("release").length, 0, reason);
  }
});

test("too little room before the deadline gives the claim back and stops", async () => {
  const { run, named } = world({
    channels: [
      { id: "c1", connectionGeneration: 3, externalAccountRef: "acct_9" },
      { id: "c2", connectionGeneration: 1, externalAccountRef: "acct_10" },
    ],
    dispatch: { started: false, reason: "deadline_too_close" },
  });
  const result = await run();
  assert.equal(result.stopped, "deadline");
  assert.equal((named("release")[0]?.input as { reason: string }).reason, "worker_shutdown");
  assert.equal(named("claim").length, 1);
});

test("a run with no room left probes nothing", async () => {
  const late = new Date(DEADLINE.getTime() - MARKETING_PUBLISHER_DISPATCH_ROOM_MS + 1);
  const { run, named } = world({ clock: [late, late] });
  const result = await run();
  assert.equal(result.stopped, "deadline");
  assert.equal(named("observeHealth").length, 0);
  assert.equal(named("claim").length, 0);
});

test("a heartbeat that says the run is no longer ours stops before the next claim", async () => {
  const { run, named } = world({ heartbeats: [false] });
  const result = await run();
  assert.equal(result.stopped, "heartbeat");
  assert.equal(named("claim").length, 0);
});

test("an account that lost its reference after dispatch is a confirmed failure, nothing sent", async () => {
  const { run, named } = world({
    dispatch: {
      started: true,
      requestKey: "k",
      attempt: 1,
      approvalExpiresAt: null,
      payload: {
        channel: "linkedin",
        externalAccountRef: null,
        locale: "en",
        renderedText: TEXT,
        assetIds: [],
        finalUrl: null,
      },
    },
  });
  const result = await run();
  assert.equal(result.failed, 1);
  assert.equal(named("publish").length, 0);
  assert.equal(
    (named("recordFailed")[0]?.input as { errorCode: string }).errorCode,
    "account_ref_missing",
  );
});

test("a live object at the published URL is verified; anything else is left alone", async () => {
  const post = {
    id: "p9",
    historyVersion: 6,
    externalPostId: "urn:li:share:7100",
    externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
    externalAccountRef: "acct_9",
  };
  const live = world({
    channels: [],
    awaiting: [post],
    status: { state: "live", externalUrl: post.externalUrl },
  });
  const verified = await live.run();
  assert.equal(verified.verified, 1);
  assert.deepEqual(live.named("recordVerified")[0]?.input, { id: "p9", expectedHistoryVersion: 6 });
  assert.equal(live.named("listAwaitingVerification")[0]?.input, MARKETING_PUBLISHER_VERIFY_LIMIT);

  const moved = world({
    channels: [],
    awaiting: [post],
    status: { state: "live", externalUrl: "https://www.linkedin.com/feed/update/other" },
  });
  const mismatched = await moved.run();
  assert.equal(mismatched.verificationMismatched, 1);
  assert.equal(moved.named("recordVerified").length, 0);

  for (const status of [{ state: "unknown" }, { state: "removed" }]) {
    const other = world({ channels: [], awaiting: [post], status });
    await other.run();
    // Removal is never inferred from a status query; that evidence is the
    // webhook's.
    assert.equal(other.named("recordVerified").length, 0);
  }
});

test("the run never cancels, retracts or looks up by key", async () => {
  const { run, named } = world({
    publish: { outcome: "outcome_unknown", errorCode: "provider_timeout" },
  });
  await run();
  assert.equal(named("cancel").length, 0);
  assert.equal(named("lookupByRequestKey").length, 0);
});

// ---------------------------------------------------------------------------
// Round-1 review: what the first version let through
// ---------------------------------------------------------------------------

test("an outcome writer that answers without writing fails the run", async () => {
  // The first version counted `{ recorded: false }` as done: a post left
  // `publishing`, an autonomous account left unpaused, and a run reported fine.
  for (const [publish, outcome] of [
    [undefined, "published"],
    [{ outcome: "failed", errorCode: "provider_rejected_content" }, "failed"],
    [{ outcome: "outcome_unknown", errorCode: "provider_timeout" }, "outcome_unknown"],
  ] as const) {
    const { run } = world({
      publish: publish as MarketingPublishResult | undefined,
      recordAnswer: { recorded: false, reason: "outcome_conflict" },
    });
    await assert.rejects(
      run(),
      (error: unknown) =>
        error instanceof MarketingPublisherOutcomeNotRecordedError &&
        error.outcome === outcome &&
        error.reason === "outcome_conflict",
    );
  }
});

test("a dispatch whose worker died is answered outcome_unknown before anything new", async () => {
  const { run, calls, named } = world({
    stale: [{ id: "p0", requestKey: "k0", historyVersion: 7 }],
  });
  const result = await run();
  assert.equal(result.recoveredUnknown, 1);
  assert.deepEqual(named("recordOutcomeUnknown")[0]?.input, {
    id: "p0",
    requestKey: "k0",
    expectedHistoryVersion: 7,
    errorCode: "lease_expired_after_dispatch",
  });
  // Before the first claim, and with nothing sent and nothing looked up.
  const names = calls.map((call) => call.name);
  assert.ok(names.indexOf("recordOutcomeUnknown") < names.indexOf("claim"));
  assert.equal(named("lookupByRequestKey").length, 0);
  // Asked with the database clock and a bound.
  assert.deepEqual(named("listPublishingPastLease")[0]?.input, { before: NOW, limit: 11 });
});

test("a dead dispatch that cannot be recorded stops the run", async () => {
  const { run, named } = world({
    stale: [{ id: "p0", requestKey: "k0", historyVersion: 7 }],
    recordAnswer: { recorded: false, reason: "post_not_publishing" },
  });
  await assert.rejects(run(), MarketingPublisherOutcomeNotRecordedError);
  assert.equal(named("claim").length, 0);
});

test("no room for even one recovery write probes and claims nothing", async () => {
  const late = new Date(DEADLINE.getTime() - MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS + 1);
  const { run, named } = world({ clock: [late] });
  const result = await run();
  assert.equal(result.stopped, "deadline");
  assert.equal(named("listPublishingPastLease").length, 0);
  assert.equal(named("claim").length, 0);
});

test("the room is the call budget plus an outcome write at its bound", () => {
  assert.equal(
    MARKETING_PUBLISHER_DISPATCH_ROOM_MS,
    30_000 + MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS,
  );
  assert.ok(MARKETING_PUBLISHER_DISPATCH_ROOM_MS < DEADLINE.getTime() - NOW.getTime());
});

test("a dispatch that commits too late is a confirmed failure, and nothing is sent", async () => {
  // The room was there when the dispatch checked; its own write took the rest.
  const late = new Date(DEADLINE.getTime() - MARKETING_PUBLISHER_DISPATCH_ROOM_MS + 1);
  const { run, named } = world({ clock: [NOW, NOW, late] });
  const result = await run();
  assert.equal(named("publish").length, 0);
  assert.equal(result.failed, 1);
  assert.equal(
    (named("recordFailed")[0]?.input as { errorCode: string }).errorCode,
    "run_deadline_before_call",
  );
});

test("accounts are taken in a different order from one run period to the next", async () => {
  const channels = [
    { id: "c1", connectionGeneration: 1, externalAccountRef: "a1" },
    { id: "c2", connectionGeneration: 1, externalAccountRef: "a2" },
    { id: "c3", connectionGeneration: 1, externalAccountRef: "a3" },
  ];
  const firstClaimed = async (deadlineAt: Date) => {
    await runMarketingPublisherBatch(
      {
        operations: {
          listChannels: async () => channels,
          listPublishingPastLease: async () => [],
          listAwaitingVerification: async () => [],
          claim: async (input: { channelId: string }) => {
            order.push(input.channelId);
            return { claimed: false, reason: "nothing_due" };
          },
        } as unknown as MarketingPublisherBatchDeps["operations"],
        adapter: {
          observeHealth: async () => ({ capability: "publish", healthy: true, reason: null }),
        } as unknown as MarketingPublishAdapter,
        databaseNow: async () => new Date(deadlineAt.getTime() - 4 * 60 * 1000),
        heartbeat: async () => true,
      },
      { runId: "r", deadlineAt },
    );
    return order.splice(0)[0];
  };
  const order: string[] = [];
  const starts = new Set<string | undefined>();
  for (let period = 0; period < 3; period += 1) {
    starts.add(await firstClaimed(new Date(DEADLINE.getTime() + period * 5 * 60 * 1000)));
  }
  assert.equal(starts.size, 3, "each of three consecutive periods starts on a different account");
});

// ---------------------------------------------------------------------------
// Round-2 review
// ---------------------------------------------------------------------------

test("more dead dispatches than one run answers stops the run before any claim", async () => {
  // The eleventh may belong to an autonomous account that should already be
  // paused; claiming on any account before it is answered could publish there.
  const stale = Array.from({ length: 11 }, (_, index) => ({
    id: `p${index}`,
    requestKey: `k${index}`,
    historyVersion: 1,
  }));
  const { run, named } = world({ stale });
  const result = await run();
  assert.equal(result.recoveredUnknown, 10);
  assert.equal(result.stopped, "recovery_backlog");
  assert.equal(named("claim").length, 0);
  assert.equal(named("observeHealth").length, 0);
  // Asked for one more than it answers, to know.
  assert.equal((named("listPublishingPastLease")[0]?.input as { limit: number }).limit, 11);
});

test("exactly as many dead dispatches as one run answers does not stop it", async () => {
  const stale = Array.from({ length: 10 }, (_, index) => ({
    id: `p${index}`,
    requestKey: `k${index}`,
    historyVersion: 1,
  }));
  const { run, named } = world({ stale });
  const result = await run();
  assert.equal(result.recoveredUnknown, 10);
  assert.notEqual(result.stopped, "recovery_backlog");
  assert.equal(named("claim").length, 1);
});

test("an approval that expired after the dispatch committed is not sent", async () => {
  const expiresAt = new Date(NOW.getTime() + 5_000);
  const { run, named } = world({
    clock: [NOW, NOW, expiresAt],
    dispatch: {
      started: true,
      requestKey: "k",
      attempt: 1,
      approvalExpiresAt: expiresAt,
      payload: {
        channel: "linkedin",
        externalAccountRef: "acct_9",
        locale: "en",
        renderedText: TEXT,
        assetIds: [],
        finalUrl: null,
      },
    },
  });
  const result = await run();
  assert.equal(named("publish").length, 0);
  assert.equal(result.failed, 1);
  assert.equal(
    (named("recordFailed")[0]?.input as { errorCode: string }).errorCode,
    "approval_expired_before_call",
  );
});
