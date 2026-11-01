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
  type MarketingCommentsMonitorDeps,
} from "@/lib/marketingCommentsMonitor";
import { commentsMonitorEnabled, MARKETING_COMMENTS_MONITOR_ENV } from "@/lib/marketingCommentsMonitorHealth";
import {
  MARKETING_COMMENTS_READ_AT_MAX_AGE_MS,
  answerMarketingCommentsMonitorRequest,
  marketingCommentBodyId,
  marketingCommentsMonitorRequestSchema,
  type MarketingCommentsMonitorRequest,
} from "@/lib/marketingCommentsMonitorRequest";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const ON = { [MARKETING_COMMENTS_MONITOR_ENV]: "true" };

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
      lastCompleteRunAt: async () => null,
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
) =>
  answerMarketingCommentsMonitorRequest(
    { action: "judge", readAt, verdicts } as MarketingCommentsMonitorRequest,
    deps,
  );

type Collected = { status: string; readAt: string; capped: boolean; items: Array<{ id: string; body: string }> };

/** The service's part, faked: a body that starts with "!" is a legal threat. */
const classify = (items: Collected["items"]) =>
  items.map((item) => ({ id: item.id, codes: item.body.startsWith("!") ? ["legal_threat"] : [] }));

test("off: neither step reads anything", async () => {
  for (const env of [{}, { [MARKETING_COMMENTS_MONITOR_ENV]: "false" }] as Array<Record<string, string>>) {
    const world = app({ env, comments: { p1: [comment("x")] } });
    assert.deepEqual(await collect(world.deps), { status: 200, body: { status: "off" } });
    assert.deepEqual(await judge(world.deps, NOW.toISOString(), []), { status: 200, body: { status: "off" } });
    assert.deepEqual(world.calls, []);
  }
});

test("collect hands over distinct, bounded bodies with their ids and nothing else, and writes nothing", async () => {
  const long = "y".repeat(MARKETING_COMMENT_BODY_MAX_CHARS + 50);
  const world = app({ comments: { p1: [comment("same"), comment(long)], p2: [comment("same")] } });
  const answer = await collect(world.deps);
  assert.equal(answer.status, 200);
  const body = answer.body as Collected;
  assert.deepEqual(Object.keys(body).sort(), ["capped", "items", "readAt", "status"]);
  assert.equal(body.readAt, NOW.toISOString());
  assert.equal(body.capped, false);
  const bodies = ["same", long.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS)];
  assert.deepEqual(
    body.items,
    bodies.map((text) => ({ id: createHash("sha256").update(text, "utf8").digest("hex"), body: text })),
  );
  assert.equal(body.items.every((item) => item.id === marketingCommentBodyId(item.body)), true);
  assert.deepEqual(world.calls.filter((call) => !call.startsWith("fetch:") && call !== "listPosts"), []);
});

test("a whole round trip records the alerts and the run, begun when the comments were read", async () => {
  const world = app({ comments: { p1: [comment("fine"), comment("! see you in court")], p2: [comment("nice")] } });
  const collected = (await collect(world.deps)).body as Collected;
  world.advance(5 * 60 * 1000);
  const answer = await judge(world.deps, collected.readAt, classify(collected.items));
  assert.equal(answer.status, 200);
  const result = (answer.body as { result: { complete: boolean; alertsRecorded: number } }).result;
  assert.equal(result.complete, true);
  assert.equal(result.alertsRecorded, 1);
  assert.deepEqual(world.alerts.map((alert) => [alert.postId, alert.alertCount, alert.riskCodes]), [["p1", 1, ["legal_threat"]]]);
  assert.deepEqual(world.alerts[0].detectedAt, NOW);
  assert.deepEqual(world.runs, [NOW]);
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

test("collect stops at its cap and says so", async () => {
  const many = Array.from({ length: MARKETING_COMMENT_COLLECT_MAX_BODIES + 5 }, (_, n) => comment(`c${n}`));
  const world = app({ comments: { p1: many } });
  const body = (await collect(world.deps)).body as Collected;
  assert.equal(body.items.length, MARKETING_COMMENT_COLLECT_MAX_BODIES);
  assert.equal(body.capped, true);
});

test("a judge carries closed codes under body ids, and nothing else", () => {
  const ok = { action: "judge", readAt: NOW.toISOString(), verdicts: [{ id: "a".repeat(64), codes: ["legal_threat"] }] };
  assert.equal(marketingCommentsMonitorRequestSchema.safeParse(ok).success, true);
  assert.equal(marketingCommentsMonitorRequestSchema.safeParse({ action: "collect" }).success, true);
  for (const bad of [
    { ...ok, verdicts: [{ id: "a".repeat(64), codes: ["close_alert"] }] },
    { ...ok, verdicts: [{ id: "A".repeat(64), codes: [] }] },
    { ...ok, verdicts: [{ id: "a".repeat(64), codes: [], postId: "p1" }] },
    { ...ok, complete: true },
    { ...ok, readAt: "2026-11-02T10:00:00+10:00" },
    { ...ok, verdicts: Array.from({ length: MARKETING_COMMENT_COLLECT_MAX_BODIES + 1 }, () => ok.verdicts[0]) },
    { action: "collect", readAt: NOW.toISOString() },
    { action: "close" },
  ]) {
    assert.equal(marketingCommentsMonitorRequestSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});
