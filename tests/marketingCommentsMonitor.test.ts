// The comment monitor (S4c; policy 12.1 and 8.3).
//
// The sentence this file is about: **off means off.** With the switch not set
// nothing is read, nothing is asked of the posting tool, no model is given a
// word. Past that, a comment's body is the only thing that ever reaches the
// classifier, and what is kept is a count, closed codes and a host.

import assert from "node:assert/strict";
import test from "node:test";

import {
  commentsMonitorEnabled,
  commentsMonitorHealthyFromValue,
  MARKETING_COMMENTS_MONITOR_ENV,
  MARKETING_COMMENTS_MONITOR_HEALTHY_WINDOW_MS,
} from "@/lib/marketingCommentsMonitorHealth";
import {
  MARKETING_COMMENT_BODY_MAX_CHARS,
  runMarketingCommentsMonitor,
  type MarketingCommentsMonitorDeps,
} from "@/lib/marketingCommentsMonitor";
import { parseZernioComments, zernioCommentsQuery } from "@/lib/zernioCommentsQuery";
import {
  MARKETING_COMMENT_ALERT_ACK_ACTION,
  evaluateMarketingAutoPause,
  listOpenMarketingCommentAlerts,
  recordMarketingCommentAlert,
  requireOpenMarketingCommentAlert,
  MarketingStoreRefusedError,
  type MarketingTransaction,
} from "@/lib/marketingStore";

const NOW = new Date("2026-11-02T09:00:00.000Z");
const ON = { [MARKETING_COMMENTS_MONITOR_ENV]: "true" };

const post = (id: string) => ({
  id,
  channelId: `chn-${id}`,
  externalPostId: `ext-${id}`,
  externalAccountRef: "acct",
});

type Calls = string[];

const monitor = (
  options: {
    env?: Record<string, string | undefined>;
    classifier?: MarketingCommentsMonitorDeps["classifier"];
    posts?: ReturnType<typeof post>[];
    comments?: Record<string, ReturnType<typeof comment>[] | "unavailable">;
    lastComplete?: Date | null;
    manyPosts?: number;
    truncated?: Set<string>;
    recordAlertThrows?: boolean;
    swept?: number;
  } = {},
) => {
  const calls: Calls = [];
  const classified: string[][] = [];
  const recorded: Array<{ postId: string; alertCount: number; riskCodes: readonly string[] }> = [];
  const runs: Date[] = [];
  const deps: MarketingCommentsMonitorDeps = {
    env: options.env ?? ON,
    enabled: commentsMonitorEnabled,
    classifier:
      options.classifier === undefined
        ? async (bodies) => {
            classified.push([...bodies]);
            return bodies.map(() => []);
          }
        : options.classifier,
    now: () => NOW,
    fetchComments: async (target) => {
      calls.push(`fetch:${target.id}`);
      const answer = options.comments?.[target.id] ?? [];
      return answer === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "ok", comments: answer, truncated: options.truncated?.has(target.id) ?? false };
    },
    operations: {
      listPosts: async () => {
        calls.push("listPosts");
        if (options.manyPosts) return Array.from({ length: options.manyPosts }, (_, index) => post(`m${index}`));
        return options.posts ?? [post("p1")];
      },
      lastCompleteRunAt: async () => options.lastComplete ?? null,
      recordAlert: async (input) => {
        calls.push("recordAlert");
        if (options.recordAlertThrows) throw new Error("database lost");
        recorded.push(input);
        return { recorded: true };
      },
      sweepUnhandled: async () => {
        calls.push("sweep");
        return options.swept ?? 0;
      },
      recordRun: async (at) => {
        calls.push("recordRun");
        runs.push(at);
      },
    },
  };
  return { deps, calls, classified, recorded, runs };
};

const comment = (text: string, createdAt: string | null = "2026-11-02T08:00:00.000Z") => ({
  text,
  createdAt: createdAt === null ? null : new Date(createdAt),
});

// ---------------------------------------------------------------------------
// Off means off
// ---------------------------------------------------------------------------

test("with the switch not set, no dependency is touched", async () => {
  for (const env of [{}, { [MARKETING_COMMENTS_MONITOR_ENV]: "false" }, { [MARKETING_COMMENTS_MONITOR_ENV]: "1" }, { [MARKETING_COMMENTS_MONITOR_ENV]: "" }]) {
    const { deps, calls } = monitor({ env });
    assert.deepEqual(await runMarketingCommentsMonitor(deps), { ran: false, reason: "switch_off" });
    assert.deepEqual(calls, []);
  }
});

test("with no classifier the monitor does not run, and does not read a comment to find out", async () => {
  const { deps, calls } = monitor({ classifier: null });
  assert.deepEqual(await runMarketingCommentsMonitor(deps), { ran: false, reason: "classifier_unavailable" });
  assert.deepEqual(calls, []);
});

test("the switch is the exact word true, in any case", () => {
  assert.equal(commentsMonitorEnabled({ [MARKETING_COMMENTS_MONITOR_ENV]: " TRUE " }), true);
  assert.equal(commentsMonitorEnabled({ [MARKETING_COMMENTS_MONITOR_ENV]: "yes" }), false);
  assert.equal(commentsMonitorEnabled({}), false);
});

// ---------------------------------------------------------------------------
// What the model sees and what is kept
// ---------------------------------------------------------------------------

test("every new comment is classified, in batches, however many there are", async () => {
  const many = Array.from({ length: 120 }, (_, index) => comment(`c${index}`));
  const { deps, classified } = monitor({ comments: { p1: many } });
  const result = await runMarketingCommentsMonitor(deps);
  assert.deepEqual(classified.map((batch) => batch.length), [50, 50, 20]);
  assert.equal(result.ran && result.complete, true);
});

test("a model is given comment bodies and nothing else, bounded", async () => {
  const long = "x".repeat(MARKETING_COMMENT_BODY_MAX_CHARS + 500);
  const { deps, classified } = monitor({ comments: { p1: [comment("first"), comment(long)] } });
  await runMarketingCommentsMonitor(deps);
  assert.equal(classified.length, 1);
  assert.deepEqual(classified[0], ["first", "x".repeat(MARKETING_COMMENT_BODY_MAX_CHARS)]);
});

test("the posting tool's comment page loses its authors before anything else sees it", () => {
  const parsed = parseZernioComments({
    comments: [
      { id: "c1", message: "this is a threat", created_time: "2026-11-02T08:00:00Z", from: { id: "u1", name: "Handle Name", username: "handle" }, url: "https://x.example/c1" },
      { id: "c2", text: "variant spelling", createdTime: "2026-11-02T08:10:00Z" },
      { id: "c3", message: "hidden by the owner", is_hidden: true },
      { id: "c4" },
      "nonsense",
    ],
  });
  assert.deepEqual(
    parsed.map((entry) => entry.text),
    ["this is a threat", "variant spelling"],
  );
  const printed = JSON.stringify(parsed);
  for (const forbidden of ["u1", "Handle Name", "handle", "x.example", "c1"]) {
    assert.equal(printed.includes(forbidden), false, forbidden);
  }
  // An empty list is an answer; a body that is not a page of comments is not.
  assert.deepEqual(parseZernioComments({ comments: [] }), []);
  assert.equal(parseZernioComments(null), null);
  assert.equal(parseZernioComments({ comments: "x" }), null);
  assert.equal(parseZernioComments({ error: "changed shape" }), null);
});

test("an alert carries a count and closed codes; codes outside the list are dropped", async () => {
  const { deps, recorded } = monitor({
    comments: { p1: [comment("a"), comment("b"), comment("c")] },
    classifier: async () => [["legal_threat"], ["not_a_code", "abuse_or_harassment"], []],
  });
  const result = await runMarketingCommentsMonitor(deps);
  assert.deepEqual(recorded, [
    { postId: "p1", alertCount: 2, riskCodes: ["legal_threat", "abuse_or_harassment"], detectedAt: NOW },
  ]);
  assert.equal(result.ran && result.alertsRecorded, 1);
});

test("a model that flags only unknown codes raises nothing", async () => {
  const { deps, recorded } = monitor({
    comments: { p1: [comment("a")] },
    classifier: async () => [["made_up"]],
  });
  await runMarketingCommentsMonitor(deps);
  assert.deepEqual(recorded, []);
});

test("only comments newer than the last whole run, less a margin, are given to the model; undated ones always are", async () => {
  // The run began at 08:40; the margin is ten minutes, so 08:30 is the floor.
  const { deps, classified } = monitor({
    lastComplete: new Date("2026-11-02T08:40:00.000Z"),
    comments: {
      p1: [
        comment("old", "2026-11-02T08:00:00.000Z"),
        comment("written while that run read", "2026-11-02T08:35:00.000Z"),
        comment("new", "2026-11-02T08:45:00.000Z"),
        comment("undated", null),
      ],
    },
  });
  await runMarketingCommentsMonitor(deps);
  assert.deepEqual(classified, [["written while that run read", "new", "undated"]]);
});

test("a whole run is recorded at the instant it began, so what was written during it is read again", async () => {
  const { deps, runs } = monitor({ comments: { p1: [comment("fine")] } });
  await runMarketingCommentsMonitor(deps);
  assert.deepEqual(runs, [NOW]);
});

test("more posts than a run covers is a sample, not a run: it reads what it can and records no health", async () => {
  const { deps, calls } = monitor({ manyPosts: 201 });
  const result = await runMarketingCommentsMonitor(deps);
  assert.equal(result.ran && result.complete, false);
  assert.equal(calls.filter((call) => call.startsWith("fetch:")).length, 200);
  assert.equal(calls.includes("recordRun"), false);
  assert.ok(calls.includes("sweep"));
});

// ---------------------------------------------------------------------------
// Failure injection: the health record is only for a whole run
// ---------------------------------------------------------------------------

test("a complete run records its health", async () => {
  const { deps, calls } = monitor({ comments: { p1: [comment("fine")] } });
  const result = await runMarketingCommentsMonitor(deps);
  assert.equal(result.ran && result.complete, true);
  assert.ok(calls.includes("recordRun"));
});

test("a comment page that cannot be read makes the run incomplete, still sweeps, and records no health", async () => {
  const { deps, calls } = monitor({ posts: [post("p1"), post("p2")], comments: { p1: "unavailable", p2: [comment("fine")] } });
  const result = await runMarketingCommentsMonitor(deps);
  assert.deepEqual(result.ran && [result.postsUnread, result.complete], [1, false]);
  assert.ok(calls.includes("sweep"));
  assert.equal(calls.includes("recordRun"), false);
  // The other post was still read.
  assert.ok(calls.includes("fetch:p2"));
});

test("a classifier that throws, or answers the wrong shape, leaves the post unread and the run incomplete", async () => {
  for (const classifier of [
    async () => {
      throw new Error("model lost");
    },
    async () => [[]],
    async () => "nonsense" as never,
    // An entry that is not a list of codes is a failed classification, not a safe comment.
    async (bodies: readonly string[]) => bodies.map(() => null as never),
    async (bodies: readonly string[]) => bodies.map(() => [42 as never]),
  ]) {
    const { deps, calls, recorded } = monitor({ comments: { p1: [comment("a"), comment("b")] }, classifier });
    const result = await runMarketingCommentsMonitor(deps);
    assert.equal(result.ran && result.complete, false);
    assert.equal(calls.includes("recordRun"), false);
    assert.deepEqual(recorded, []);
  }
});

test("the unanswered-alert sweep runs even when nothing could be read", async () => {
  const { deps, calls } = monitor({ comments: { p1: "unavailable" }, swept: 2 });
  const result = await runMarketingCommentsMonitor(deps);
  assert.ok(calls.includes("sweep"));
  assert.equal(result.ran && result.accountsStopped, 2);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test("health needs the switch on and a run inside the window", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  assert.equal(commentsMonitorHealthyFromValue(ago(60_000), NOW, ON), true);
  assert.equal(commentsMonitorHealthyFromValue(ago(MARKETING_COMMENTS_MONITOR_HEALTHY_WINDOW_MS), NOW, ON), true);
  assert.equal(commentsMonitorHealthyFromValue(ago(MARKETING_COMMENTS_MONITOR_HEALTHY_WINDOW_MS + 1), NOW, ON), false);
  assert.equal(commentsMonitorHealthyFromValue(ago(60_000), NOW, {}), false);
  assert.equal(commentsMonitorHealthyFromValue(undefined, NOW, ON), false);
  assert.equal(commentsMonitorHealthyFromValue("garbage", NOW, ON), false);
  // A record from the future is not evidence of a run.
  assert.equal(commentsMonitorHealthyFromValue(new Date(NOW.getTime() + 60_000).toISOString(), NOW, ON), false);
});

// ---------------------------------------------------------------------------
// The posting tool call
// ---------------------------------------------------------------------------

test("the comments call asks for one account's post with the key, and anything but 200 is unavailable", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const make = (status: number, body: unknown) =>
    zernioCommentsQuery({
      apiKey: "secret-key",
      baseUrl: "https://zernio.example/api",
      callBudgetMs: 1_000,
      fetch: (async (url: URL, init: { headers: Record<string, string> }) => {
        seen.push({ url: String(url), headers: init.headers });
        return { status, json: async () => body };
      }) as unknown as typeof fetch,
    });
  const ok = await make(200, { comments: [{ message: "hello" }] }).fetchComments("ext 1", "acct/1");
  assert.deepEqual(ok, { kind: "ok", comments: [{ text: "hello", createdAt: null }], truncated: false });
  assert.equal(seen[0].url, "https://zernio.example/api/v1/inbox/comments/ext%201?accountId=acct%2F1&limit=50");
  assert.equal(seen[0].headers.Authorization, "Bearer secret-key");
  // A 200 whose body is not a page of comments is not "no comments".
  assert.deepEqual(await make(200, { error: "changed shape" }).fetchComments("p", "a"), { kind: "unavailable" });
  assert.deepEqual(await make(200, null).fetchComments("p", "a"), { kind: "unavailable" });
  for (const status of [401, 404, 429, 500]) {
    assert.deepEqual(await make(status, { comments: [{ message: "x" }] }).fetchComments("p", "a"), { kind: "unavailable" });
  }
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const asTransaction = (database: unknown): MarketingTransaction => database as MarketingTransaction;

type ReportRow = { id?: string; createdAt: Date; payload: unknown };

const payload = (postId: string, firstDetectedAt = "2026-11-02T07:00:00.000Z") => ({
  postId,
  alertCount: 2,
  riskCodes: ["legal_threat"],
  firstDetectedAt,
  externalUrlHost: "www.linkedin.com",
});

const storeWorld = (
  options: {
    reports?: ReportRow[];
    acknowledgements?: Array<{ id?: string; targetId: string; createdAt: Date }>;
    postStatus?: string;
    externalUrl?: string | null;
  } = {},
) => {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const { reports = [], acknowledgements = [], postStatus = "published", externalUrl = "https://www.linkedin.com/feed/update/1" } = options;
  const database = {
    async $executeRaw() {
      return 0;
    },
    async $queryRaw() {
      return [{ now: NOW, createdAt: NOW }];
    },
    marketingReport: {
      findFirst: async ({ where }: { where: { payload: { equals: string } } }) => {
        const mine = reports.filter(
          (report) => (report.payload as { postId?: string }).postId === where.payload.equals,
        );
        mine.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return mine[0] ?? null;
      },
      // Honours the page size and the cursor, as the table does.
      findMany: async (args: { take?: number; cursor?: { id: string }; skip?: number }) => {
        const all = reports.map((report, index) => ({ id: report.id ?? `r${index}`, ...report }));
        const start = args.cursor ? all.findIndex((report) => report.id === args.cursor?.id) + (args.skip ?? 0) : 0;
        return all.slice(start, start + (args.take ?? all.length));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      },
    },
    marketingPost: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, channelId: `chn-${id}` })),
      findUnique: async () => ({ id: "p1", externalUrl, status: postStatus }),
    },
    adminAuditLog: {
      findMany: async ({ where }: { where: { id?: { not: string } } }) =>
        acknowledgements.filter((entry) => where.id === undefined || entry.id !== where.id.not),
      findFirst: async (args?: { where?: { targetId?: string; id?: { not: string } } }) => {
        const mine = acknowledgements
          .filter((entry) => entry.targetId === args?.where?.targetId)
          .filter((entry) => args?.where?.id === undefined || entry.id !== args.where.id.not)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return mine[0] ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  return { database, created, audits };
};

test("an alert is open until an acknowledgement newer than it exists", async () => {
  const reportAt = new Date("2026-11-02T07:00:00.000Z");
  const open = storeWorld({ reports: [{ createdAt: reportAt, payload: payload("p1") }] });
  assert.deepEqual((await listOpenMarketingCommentAlerts(open.database as never)).map((alert) => alert.postId), ["p1"]);

  const answered = storeWorld({
    reports: [{ createdAt: reportAt, payload: payload("p1") }],
    acknowledgements: [{ targetId: "p1", createdAt: new Date(reportAt.getTime() + 1_000) }],
  });
  assert.deepEqual(await listOpenMarketingCommentAlerts(answered.database as never), []);

  // An answer older than the newest report does not answer it: the alert came back.
  const returned = storeWorld({
    reports: [{ createdAt: new Date(reportAt.getTime() + 5_000), payload: payload("p1") }],
    acknowledgements: [{ targetId: "p1", createdAt: reportAt }],
  });
  assert.equal((await listOpenMarketingCommentAlerts(returned.database as never)).length, 1);
});

test("an unreadable report is skipped rather than guessed at", async () => {
  const { database } = storeWorld({
    reports: [{ createdAt: NOW, payload: { postId: "p1", unexpected: true } }],
  });
  assert.deepEqual(await listOpenMarketingCommentAlerts(database as never), []);
});

test("acknowledging needs an open alert, and does not count its own entry as the answer", async () => {
  const reportAt = new Date("2026-11-02T07:00:00.000Z");
  const world = storeWorld({
    reports: [{ createdAt: reportAt, payload: payload("p1") }],
    // The entry this very request wrote: newer than the report, and ignored.
    acknowledgements: [{ id: "this-request", targetId: "p1", createdAt: new Date(reportAt.getTime() + 1_000) }],
  });
  await requireOpenMarketingCommentAlert(world.database as never, "p1", "this-request");

  const none = storeWorld();
  await assert.rejects(
    requireOpenMarketingCommentAlert(none.database as never, "p1", "this-request"),
    (error) => error instanceof MarketingStoreRefusedError && error.code === "post_not_found",
  );
  assert.equal(MARKETING_COMMENT_ALERT_ACK_ACTION, "marketing_comment_alert.acknowledge");
});

test("recording an alert writes a counts-only report and its audit entry, once", async () => {
  const world = storeWorld();
  const result = await recordMarketingCommentAlert(asTransaction(world.database), {
    postId: "p1",
    alertCount: 2,
    riskCodes: ["legal_threat", "abuse_or_harassment"],
    detectedAt: NOW,
  });
  assert.deepEqual(result, { recorded: true });
  assert.equal(world.created.length, 1);
  assert.equal(world.created[0].kind, "comment_alerts");
  assert.deepEqual(world.created[0].payload, {
    postId: "p1",
    alertCount: 2,
    riskCodes: ["legal_threat", "abuse_or_harassment"],
    firstDetectedAt: NOW.toISOString(),
    externalUrlHost: "www.linkedin.com",
  });
  assert.equal(world.audits.length, 1);
  assert.equal(world.audits[0].action, "marketing_comment_alert.recorded");
  // Nothing of the comments: no text, no author, no link.
  assert.equal(JSON.stringify([world.created, world.audits]).includes("linkedin.com/feed"), false);
});

test("a post that already has an unanswered alert gets no second one; an unpublished post gets none", async () => {
  const open = storeWorld({ reports: [{ createdAt: NOW, payload: payload("p1") }] });
  assert.deepEqual(
    await recordMarketingCommentAlert(asTransaction(open.database), { postId: "p1", alertCount: 1, riskCodes: ["legal_threat"], detectedAt: NOW }),
    { recorded: false, reason: "already_open" },
  );
  assert.equal(open.created.length, 0);

  const draft = storeWorld({ postStatus: "approved" });
  assert.deepEqual(
    await recordMarketingCommentAlert(asTransaction(draft.database), { postId: "p1", alertCount: 1, riskCodes: ["legal_threat"], detectedAt: NOW }),
    { recorded: false, reason: "post_not_published" },
  );
});

// ---------------------------------------------------------------------------
// The stop for an alert nobody answered
// ---------------------------------------------------------------------------

const pauseWorld = (
  approvalStartedAt: Date,
  options: { answered?: boolean; reportFirstDetectedAt?: string } = {},
) => {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const database = {
    async $executeRaw() {
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join("?");
      if (sql.includes("clock_timestamp")) return [{ now: NOW, createdAt: NOW }];
      return [{ id: "chn-1", channel: "linkedin", status: "approval_mode", approvalStartedAt }];
    },
    marketingChannel: {
      updateMany: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    marketingReport: {
      findFirst: async () => ({
        createdAt: new Date("2026-11-01T01:00:00.000Z"),
        payload: { firstDetectedAt: options.reportFirstDetectedAt ?? "2026-11-01T00:00:00.000Z" },
      }),
    },
    adminAuditLog: {
      findFirst: async (args?: { where?: { action?: unknown } }) =>
        args?.where?.action === "marketing_comment_alert.acknowledge" && options.answered
          ? { createdAt: new Date("2026-11-01T02:00:00.000Z") }
          : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  return { database, updates, audits };
};

test("an alert that began after the account's last fresh start stops the account", async () => {
  const world = pauseWorld(new Date("2026-10-30T00:00:00.000Z"));
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: new Date("2026-11-01T00:00:00.000Z") }],
    forcedOverdueBefore: new Date("2026-11-01T09:00:00.000Z"),
  });
  assert.equal(result.paused && result.reasonCode, "unhandled_comment_alert");
  assert.equal(world.updates.length, 1);
  assert.equal(world.audits.length, 1);
});

test("an alert that was already open when the account was resumed does not stop it again", async () => {
  const world = pauseWorld(new Date("2026-11-01T12:00:00.000Z"));
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: new Date("2026-11-01T00:00:00.000Z") }],
    forcedOverdueBefore: new Date("2026-11-01T09:00:00.000Z"),
  });
  assert.deepEqual(result, { paused: false });
  assert.equal(world.updates.length, 0);
  assert.equal(world.audits.length, 0);
});

test("an alert the operator answered after the list was read does not stop the account", async () => {
  const world = pauseWorld(new Date("2026-10-30T00:00:00.000Z"), { answered: true });
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: new Date("2026-11-01T00:00:00.000Z") }],
    forcedOverdueBefore: new Date("2026-11-01T09:00:00.000Z"),
  });
  assert.deepEqual(result, { paused: false });
  assert.equal(world.updates.length, 0);
});

test("a forced reason without the instant its fact began stops nothing", async () => {
  const world = pauseWorld(new Date("2026-10-30T00:00:00.000Z"));
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
  });
  assert.deepEqual(result, { paused: false });
});

test("an unanswered alert older than the newest few hundred reports is still found", async () => {
  const oldest = new Date("2026-10-20T00:00:00.000Z");
  // 450 reports for other posts, newer; the one that matters is the oldest.
  const newer = Array.from({ length: 450 }, (_, index) => ({
    id: `n${index}`,
    createdAt: new Date(NOW.getTime() - index * 1000),
    payload: payload(`other-${index}`),
  }));
  const { database } = storeWorld({
    reports: [...newer, { id: "oldest", createdAt: oldest, payload: payload("p-old", oldest.toISOString()) }],
    acknowledgements: newer.map((report, index) => ({ targetId: `other-${index}`, createdAt: NOW })),
  });
  const open = await listOpenMarketingCommentAlerts(database as never);
  assert.deepEqual(open.map((alert) => alert.postId), ["p-old"]);
});

test("a read cut short by paging is not a whole read: no health, but what was read still raises alerts", async () => {
  const { deps, calls, classified } = monitor({
    posts: [post("p1"), post("p2")],
    comments: { p1: [comment("a")], p2: [comment("b")] },
    truncated: new Set(["p1"]),
  });
  const result = await runMarketingCommentsMonitor(deps);
  assert.equal(result.ran && result.complete, false);
  assert.equal(calls.includes("recordRun"), false);
  // What was read of the cut-short post is still classified.
  assert.deepEqual(classified, [["a"], ["b"]]);
});

test("an alert that cannot be written leaves its post unread, the run goes on, and the sweep still runs", async () => {
  const { deps, calls } = monitor({
    posts: [post("p1"), post("p2")],
    comments: { p1: [comment("a")], p2: [comment("b")] },
    classifier: async (bodies) => bodies.map(() => ["legal_threat"]),
    recordAlertThrows: true,
    swept: 1,
  });
  const result = await runMarketingCommentsMonitor(deps);
  assert.equal(result.ran && result.complete, false);
  assert.equal(result.ran && result.postsUnread, 2);
  assert.ok(calls.includes("fetch:p2"));
  assert.ok(calls.includes("sweep"));
  assert.equal(calls.includes("recordRun"), false);
});

test("a failure to list the posts, or to sweep, is an incomplete run and never a thrown one", async () => {
  const listing = monitor();
  listing.deps.operations.listPosts = async () => {
    throw new Error("database lost");
  };
  const first = await runMarketingCommentsMonitor(listing.deps);
  assert.equal(first.ran && first.complete, false);
  assert.ok(listing.calls.includes("sweep"));

  const sweeping = monitor({ comments: { p1: [comment("fine")] } });
  sweeping.deps.operations.sweepUnhandled = async () => {
    throw new Error("database lost");
  };
  const second = await runMarketingCommentsMonitor(sweeping.deps);
  assert.equal(second.ran && second.complete, false);
  assert.equal(sweeping.calls.includes("recordRun"), false);
});

test("the comments call follows pages to the end, assumes no order, and says when it stopped short", async () => {
  const page = (n: number, extra: Record<string, unknown>) => ({
    comments: Array.from({ length: n }, (_, index) => ({ message: `c${index}`, created_time: "2026-11-02T08:00:00Z" })),
    ...extra,
  });
  const run = async (pages: unknown[]) => {
    let call = 0;
    const urls: string[] = [];
    const result = await zernioCommentsQuery({
      apiKey: "k",
      baseUrl: "https://zernio.example/api",
      callBudgetMs: 1_000,
      fetch: (async (url: URL) => {
        urls.push(String(url));
        return { status: 200, json: async () => pages[Math.min(call++, pages.length - 1)] };
      }) as unknown as typeof fetch,
    }).fetchComments("p", "a");
    return { result, urls };
  };

  const two = await run([page(50, { pagination: { hasMore: true, cursor: "c2" } }), page(3, { pagination: { hasMore: false } })]);
  assert.equal(two.result.kind === "ok" && two.result.comments.length, 53);
  assert.equal(two.result.kind === "ok" && two.result.truncated, false);
  assert.match(two.urls[1], /cursor=c2/);

  // A full page that names no way on is not known to be the end -- also when
  // some of its items were hidden or unreadable and so are not in the result.
  const unclear = await run([page(50, {})]);
  assert.equal(unclear.result.kind === "ok" && unclear.result.truncated, true);
  const withHidden = await run([
    { comments: [...page(49, {}).comments, { message: "hidden", is_hidden: true }] },
  ]);
  assert.equal(withHidden.result.kind === "ok" && withHidden.result.truncated, true);
  // The response saying it is the end is the end, however full the page.
  const saysEnd = await run([page(50, { pagination: { hasMore: false } })]);
  assert.equal(saysEnd.result.kind === "ok" && saysEnd.result.truncated, false);
  // A short page without pagination information is the end.
  const short = await run([page(3, {})]);
  assert.equal(short.result.kind === "ok" && short.result.truncated, false);

  // A later page that fails keeps what the first gave and says it was cut short.
  let call = 0;
  const failing = await zernioCommentsQuery({
    apiKey: "k",
    baseUrl: "https://zernio.example/api",
    callBudgetMs: 1_000,
    fetch: (async () => {
      call += 1;
      return call === 1
        ? { status: 200, json: async () => page(50, { pagination: { hasMore: true, cursor: "c2" } }) }
        : { status: 500, json: async () => null };
    }) as unknown as typeof fetch,
  }).fetchComments("p", "a");
  assert.equal(failing.kind === "ok" && failing.comments.length, 50);
  assert.equal(failing.kind === "ok" && failing.truncated, true);

  // Pages forever: stops at the cap and says so.
  const forever = await run([page(50, { pagination: { hasMore: true, cursor: "again" } })]);
  assert.equal(forever.result.kind === "ok" && forever.result.truncated, true);
  assert.equal(forever.urls.length, 5);
});



test("a newer alert on the same post is not the overdue one the list showed", async () => {
  // The list saw the alert of 2026-11-01T00:00; the operator answered it and a
  // new one began at 08:00 -- under a day old, and not the alert asked about.
  const world = pauseWorld(new Date("2026-10-30T00:00:00.000Z"), { reportFirstDetectedAt: "2026-11-01T08:00:00.000Z" });
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: new Date("2026-11-01T00:00:00.000Z") }],
    forcedOverdueBefore: new Date("2026-11-01T09:00:00.000Z"),
  });
  assert.deepEqual(result, { paused: false });
  assert.equal(world.updates.length, 0);
});

test("an alert that is not yet a day old is not overdue, whatever the list said", async () => {
  const world = pauseWorld(new Date("2026-10-30T00:00:00.000Z"));
  const result = await evaluateMarketingAutoPause(asTransaction(world.database), {
    channelId: "chn-1",
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: new Date("2026-11-01T00:00:00.000Z") }],
    forcedOverdueBefore: new Date("2026-10-31T23:00:00.000Z"),
  });
  assert.deepEqual(result, { paused: false });
});
