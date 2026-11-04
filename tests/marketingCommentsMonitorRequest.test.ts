// The comment monitor's two steps as the app answers them (S4d).
//
// The sentence this file is about: **the service sends verdicts and nothing
// else is taken from it.** The app reads the comments for both steps, decides
// whether the run was whole and when it began, and a body the service gave no
// verdict for leaves its post unread -- never safe.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MARKETING_COMMENT_BODY_MAX_CHARS,
  MARKETING_COMMENT_COLLECT_MAX_BODIES,
  MARKETING_COMMENT_MONITOR_OVERLAP_MS,
  type MarketingCommentsMonitorDeps,
} from "@/lib/marketingCommentsMonitor";
import {
  commentsMonitorEnabled as commentsMonitorEnabledWith,
  MARKETING_COMMENTS_MONITOR_ENV,
} from "@/lib/marketingCommentsMonitorHealth";
import {
  MARKETING_COMMENTS_READ_AT_MAX_AGE_MS,
  answerMarketingCommentsMonitorRequest,
  marketingCommentBodyId,
  marketingCommentsMonitorRequestSchema,
  type MarketingCommentsMonitorRequest,
} from "@/lib/marketingCommentsMonitorRequest";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const ON = { [MARKETING_COMMENTS_MONITOR_ENV]: "true" };

// The steps under test are the ones of a monitor that is allowed to run, so the
// predicate is asked as if the privacy notice's comments section were
// published. The unconfirmed case is the "off" test below.
const commentsMonitorEnabled = (env: Readonly<Record<string, string | undefined>>) =>
  commentsMonitorEnabledWith(env, true);

type Comment = { text: string; createdAt: Date | null };
const comment = (text: string, createdAt: string | null = "2026-11-02T09:30:00.000Z"): Comment => ({
  text,
  createdAt: createdAt === null ? null : new Date(createdAt),
});
const post = (id: string) => ({
  id,
  channelId: `chn-${id}`,
  externalPostId: `ext-${id}`,
  externalAccountRef: "acct",
  channelApprovalStartedAt: null as Date | null,
});

/** An app whose comments can change between the two steps. */
const app = (options: { env?: Record<string, string>; comments: Record<string, Comment[]>; now?: Date }) => {
  const calls: string[] = [];
  const alerts: Array<{ postId: string; alertCount: number; riskCodes: readonly string[]; detectedAt: Date }> = [];
  const runs: Date[] = [];
  let now = options.now ?? NOW;
  const deps: Omit<MarketingCommentsMonitorDeps, "classifier" | "readAt"> = {
    env: options.env ?? ON,
    enabled: commentsMonitorEnabled,
    now: () => now,
    fetchComments: async (target) => {
      calls.push(`fetch:${target.id}`);
      return { kind: "ok", comments: options.comments[target.id] ?? [], truncated: false };
    },
    operations: {
      listPosts: async () => {
        calls.push("listPosts");
        return Object.keys(options.comments).map(post);
      },
      lastCompleteRunAt: async () => runs.at(-1) ?? null,
      alertAnswers: async () => new Map(),
      recordAlert: async (input) => {
        calls.push("recordAlert");
        alerts.push(input);
        return { recorded: true };
      },
      sweepUnhandled: async () => {
        calls.push("sweep");
        return 0;
      },
      recordRun: async (at) => {
        calls.push("recordRun");
        runs.push(at);
      },
    },
  };
  return { deps, calls, alerts, runs, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
};

const collect = (deps: Parameters<typeof answerMarketingCommentsMonitorRequest>[1]) =>
  answerMarketingCommentsMonitorRequest({ action: "collect" }, deps);

const judge = (
  deps: Parameters<typeof answerMarketingCommentsMonitorRequest>[1],
  readAt: string,
  verdicts: Array<{ id: string; codes: string[] }>,
  backlog = false,
) =>
  answerMarketingCommentsMonitorRequest(
    { action: "judge", readAt, backlog, verdicts } as MarketingCommentsMonitorRequest,
    deps,
  );

type Collected = { status: string; readAt: string; backlog: boolean; items: Array<{ id: string; body: string }> };

/** The service's part, faked: a body that starts with "!" is a legal threat. */
const classify = (items: Collected["items"]) =>
  items.map((item) => ({ id: item.id, codes: item.body.startsWith("!") ? ["legal_threat"] : [] }));

/** One two-step run with the faked service: what collect said, and whether the run was whole. */
const roundTrip = async (deps: Parameters<typeof answerMarketingCommentsMonitorRequest>[1]) => {
  const collected = (await collect(deps)).body as Collected;
  const judged = (await judge(deps, collected.readAt, classify(collected.items), collected.backlog)).body as {
    result: { complete: boolean };
  };
  return { collected, complete: judged.result.complete };
};

test("off: neither step reads anything", async () => {
  for (const env of [{}, { [MARKETING_COMMENTS_MONITOR_ENV]: "false" }] as Array<Record<string, string>>) {
    const world = app({ env, comments: { p1: [comment("x")] } });
    assert.deepEqual(await collect(world.deps), { status: 200, body: { status: "off" } });
    assert.deepEqual(await judge(world.deps, NOW.toISOString(), []), { status: 200, body: { status: "off" } });
    assert.deepEqual(world.calls, []);
  }
});

test("off with the variable on but the privacy notice unconfirmed: neither step reads anything", async () => {
  const world = app({ comments: { p1: [comment("x")] } });
  const deps = { ...world.deps, enabled: (env: Readonly<Record<string, string | undefined>>) => commentsMonitorEnabledWith(env, false) };
  assert.deepEqual(await collect(deps), { status: 200, body: { status: "off" } });
  assert.deepEqual(await judge(deps, NOW.toISOString(), []), { status: 200, body: { status: "off" } });
  assert.deepEqual(world.calls, []);
});

test("collect hands over distinct, bounded bodies with their ids and nothing else, and writes nothing", async () => {
  const long = "y".repeat(MARKETING_COMMENT_BODY_MAX_CHARS + 50);
  const world = app({ comments: { p1: [comment("same"), comment(long)], p2: [comment("same")] } });
  const answer = await collect(world.deps);
  assert.equal(answer.status, 200);
  const body = answer.body as Collected;
  assert.deepEqual(Object.keys(body).sort(), ["backlog", "items", "readAt", "status"]);
  assert.equal(body.readAt, NOW.toISOString());
  assert.equal(body.backlog, false);
  const bodies = ["same", long.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS)];
  assert.deepEqual(
    body.items,
    bodies.map((text) => ({ id: createHash("sha256").update(text, "utf8").digest("hex"), body: text })),
  );
  assert.equal(body.items.every((item) => item.id === marketingCommentBodyId(item.body)), true);
  assert.deepEqual(world.calls.filter((call) => !call.startsWith("fetch:") && call !== "listPosts"), []);
});

test("a whole round trip records the alerts when found and the run as begun when the comments were read", async () => {
  const world = app({ comments: { p1: [comment("fine"), comment("! see you in court")], p2: [comment("nice")] } });
  const collected = (await collect(world.deps)).body as Collected;
  const judgedAt = world.advance(5 * 60 * 1000);
  const answer = await judge(world.deps, collected.readAt, classify(collected.items));
  assert.equal(answer.status, 200);
  const result = (answer.body as { result: { complete: boolean; alertsRecorded: number } }).result;
  assert.equal(result.complete, true);
  assert.equal(result.alertsRecorded, 1);
  assert.deepEqual(world.alerts.map((alert) => [alert.postId, alert.alertCount, alert.riskCodes]), [["p1", 1, ["legal_threat"]]]);
  assert.deepEqual(world.alerts[0].detectedAt, judgedAt);
  assert.deepEqual(world.runs, [NOW]);
});

test("a backlog past the cap is worked through run by run, oldest first, and alerts are dated when found", async () => {
  // One comment a minute for longer than the cap, the oldest days ago; one risky comment past the first cut.
  const start = NOW.getTime() - 3 * 24 * 60 * 60 * 1000;
  const total = MARKETING_COMMENT_COLLECT_MAX_BODIES + 100;
  const risky = MARKETING_COMMENT_COLLECT_MAX_BODIES + 50;
  const minute = (n: number) => start + n * 60_000;
  const backlog = Array.from({ length: total }, (_, n) =>
    comment(n === risky ? `! complaint ${n}` : `c${n}`, new Date(minute(n)).toISOString()),
  );
  const world = app({ comments: { p1: backlog } });

  // First run: the oldest comments up to the cap, cut just before the next one's minute.
  const cut = minute(MARKETING_COMMENT_COLLECT_MAX_BODIES) - 1;
  const first = await roundTrip(world.deps);
  assert.equal(first.collected.backlog, true);
  assert.equal(first.collected.items.length, MARKETING_COMMENT_COLLECT_MAX_BODIES);
  assert.equal(first.collected.readAt, new Date(cut).toISOString());
  assert.equal(first.complete, true);
  // Recorded one overlap after the cut, so the next run's floor is the cut itself.
  assert.deepEqual(world.runs, [new Date(cut + MARKETING_COMMENT_MONITOR_OVERLAP_MS)]);
  assert.equal(world.alerts.length, 0);

  // Second run carries on with exactly what is left, and catches up to now.
  const judgedAt = world.advance(60_000);
  const second = await roundTrip(world.deps);
  assert.equal(second.collected.backlog, false);
  assert.equal(second.collected.readAt, judgedAt.toISOString());
  assert.equal(second.collected.items.length, total - MARKETING_COMMENT_COLLECT_MAX_BODIES);
  assert.equal(second.complete, true);
  assert.deepEqual(world.runs.at(-1), judgedAt);
  // Found now, though written days ago: the alert is not born a day old.
  assert.deepEqual(world.alerts.map((alert) => [alert.postId, alert.detectedAt]), [["p1", judgedAt]]);
});

test("a burst past the cap inside the overlap waits for the overlap to pass it, then is worked through", async () => {
  // 1,100 comments 200 ms apart across two posts, the last a minute ago; one risky near the end, on p2.
  const total = MARKETING_COMMENT_COLLECT_MAX_BODIES + 100;
  const risky = total - 3;
  const at = (n: number) => NOW.getTime() - 60_000 - (total - 1 - n) * 200;
  const burst = Array.from({ length: total }, (_, n) =>
    comment(n === risky ? `! late threat ${n}` : `b${n}`, new Date(at(n)).toISOString()),
  );
  const world = app({ comments: { p1: burst.filter((_, n) => n % 2 === 0), p2: burst.filter((_, n) => n % 2 === 1) } });

  // Hour one: none of it is an overlap old, so none of it is handed over yet.
  const first = await roundTrip(world.deps);
  assert.equal(first.collected.backlog, true);
  assert.equal(first.collected.items.length, 0);
  assert.equal(first.complete, true);

  // Hour two: the oldest up to the cap. Hour three: the rest -- not the same thousand again.
  world.advance(60 * 60_000);
  const second = await roundTrip(world.deps);
  assert.equal(second.collected.items.length, MARKETING_COMMENT_COLLECT_MAX_BODIES);
  assert.equal(second.complete, true);
  world.advance(60 * 60_000);
  const third = await roundTrip(world.deps);
  assert.equal(third.collected.backlog, false);
  assert.equal(third.collected.items.length, total - MARKETING_COMMENT_COLLECT_MAX_BODIES);
  const done = new Set(second.collected.items.map((item) => item.id));
  assert.equal(third.collected.items.some((item) => done.has(item.id)), false);
  assert.equal(third.complete, true);
  assert.deepEqual(world.alerts.map((alert) => alert.postId), [risky % 2 === 0 ? "p1" : "p2"]);
});

test("a body with no verdict leaves its post unread, and the verdicts that came still raise their alert", async () => {
  const world = app({ comments: { p1: [comment("! refund me or else"), comment("unclassified")], p2: [comment("! lawyer")] } });
  const collected = (await collect(world.deps)).body as Collected;
  const verdicts = classify(collected.items).filter((verdict) => verdict.id !== marketingCommentBodyId("unclassified"));
  const answer = await judge(world.deps, collected.readAt, verdicts);
  const result = (answer.body as { result: { complete: boolean; postsUnread: number } }).result;
  assert.equal(result.complete, false);
  assert.equal(result.postsUnread, 1);
  assert.deepEqual(world.alerts.map((alert) => alert.postId).sort(), ["p1", "p2"]);
  assert.deepEqual(world.runs, []);
});

test("a comment written after the read is the next run's, and does not spoil this one", async () => {
  const comments: Record<string, Comment[]> = { p1: [comment("before")] };
  const world = app({ comments });
  const collected = (await collect(world.deps)).body as Collected;
  comments.p1.push(comment("! after the read", "2026-11-02T10:01:00.000Z"));
  world.advance(3 * 60 * 1000);
  const answer = await judge(world.deps, collected.readAt, classify(collected.items));
  const result = (answer.body as { result: { complete: boolean } }).result;
  assert.equal(result.complete, true);
  assert.deepEqual(world.alerts, []);
  assert.deepEqual(world.runs, [NOW]);
});

test("a read time in the future or too long ago is refused before anything is read", async () => {
  const world = app({ comments: { p1: [comment("x")] } });
  for (const readAt of [
    new Date(NOW.getTime() + 1_000).toISOString(),
    new Date(NOW.getTime() - MARKETING_COMMENTS_READ_AT_MAX_AGE_MS - 1_000).toISOString(),
  ]) {
    assert.deepEqual(await judge(world.deps, readAt, []), { status: 400, body: { code: "read_at_out_of_range" } });
  }
  assert.deepEqual(world.calls, []);
});

test("more than the cap in one instant cannot be cut: up to the cap goes over, and no run is whole", async () => {
  const many = Array.from({ length: MARKETING_COMMENT_COLLECT_MAX_BODIES + 5 }, (_, n) => comment(`c${n}`));
  const world = app({ comments: { p1: many } });
  for (let hour = 0; hour < 2; hour += 1) {
    const run = await roundTrip(world.deps);
    assert.equal(run.collected.items.length, MARKETING_COMMENT_COLLECT_MAX_BODIES);
    assert.equal(run.collected.backlog, false);
    assert.equal(run.complete, false);
    world.advance(60 * 60_000);
  }
  assert.deepEqual(world.runs, []);
});

test("a backlog cut must be an overlap old: a younger one is refused before anything is read", async () => {
  const world = app({ comments: { p1: [comment("x")] } });
  const young = new Date(NOW.getTime() - MARKETING_COMMENT_MONITOR_OVERLAP_MS + 1_000).toISOString();
  assert.deepEqual(await judge(world.deps, young, [], true), { status: 400, body: { code: "read_at_out_of_range" } });
  assert.deepEqual(world.calls, []);
});

test("a judge carries closed codes under body ids, and nothing else", () => {
  const ok = {
    action: "judge",
    readAt: NOW.toISOString(),
    backlog: false,
    verdicts: [{ id: "a".repeat(64), codes: ["legal_threat"] }],
  };
  assert.equal(marketingCommentsMonitorRequestSchema.safeParse(ok).success, true);
  assert.equal(marketingCommentsMonitorRequestSchema.safeParse({ action: "collect" }).success, true);
  for (const bad of [
    { ...ok, verdicts: [{ id: "a".repeat(64), codes: ["close_alert"] }] },
    { action: "judge", readAt: ok.readAt, verdicts: ok.verdicts },
    { ...ok, verdicts: [{ id: "A".repeat(64), codes: [] }] },
    { ...ok, verdicts: [{ id: "a".repeat(64), codes: [], postId: "p1" }] },
    { ...ok, complete: true },
    { ...ok, readAt: "2026-11-02T10:00:00+10:00" },
    { ...ok, verdicts: Array.from({ length: MARKETING_COMMENT_COLLECT_MAX_BODIES + 1 }, (_, n) => ({ id: n.toString(16).padStart(64, "0"), codes: [] })) },
    { ...ok, verdicts: [ok.verdicts[0], { id: "a".repeat(64), codes: [] }] },
    { action: "collect", readAt: NOW.toISOString() },
    { action: "close" },
  ]) {
    assert.equal(marketingCommentsMonitorRequestSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});
