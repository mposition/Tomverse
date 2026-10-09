// One digest-service run, driven through every branch with an injected fetch
// (docs/policy/sre-ops.md §1 item 3, §3 rules 1 and 7, §4, §9 T-1): it reports
// yesterday's closed Brisbane date, posts the fixed notice once to Slack only
// for a digest it created, never to another host, withholds its heartbeat
// when the notice fails, and logs no URL, secret or id.

import assert from "node:assert/strict";
import test from "node:test";

import { DIGEST_SENTENCE } from "../scripts/ops-observer/content-guard-core.mjs";
import { parseDigestRequest } from "../scripts/ops-observer/digest-schema-core.mjs";
import { SLACK_WEBHOOK_PREFIX, digestOwnerDateOf, runDigest, slackNoticeBody } from "../scripts/ops-observer/run-digest-core.mjs";

const APP = "https://tomverse.app";
const SECRET = "d".repeat(40);
const WEBHOOK = `${SLACK_WEBHOOK_PREFIX}services/T000/B000/xyz`;
const HEARTBEAT = "https://hc.example.test/ping/digest";
const ENV = {
  OPS_OBSERVER_APP_URL: APP,
  OPS_OBSERVER_DIGEST_SECRET: SECRET,
  OPS_OBSERVER_DIGEST_WEBHOOK_URL: WEBHOOK,
  OPS_OBSERVER_DIGEST_HEARTBEAT_URL: HEARTBEAT,
};
// 07:00 on 2026-10-08 in Brisbane: the cron's time, reporting 2026-10-07.
const START = Date.parse("2026-10-07T21:00:00.000Z");
const ITEM = "44444444-4444-4444-8444-444444444444";
const DIGEST = `${APP}/api/internal/ops-observer/digest`;

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    const answer = routes[url];
    if (answer === undefined) throw new Error(`unexpected ${url}`);
    if (answer instanceof Error) throw answer;
    const [status, json] = answer;
    return { status, text: async () => (json === undefined ? "" : typeof json === "string" ? json : JSON.stringify(json)) };
  };
  return { fetchImpl, calls, urls: () => calls.map((call) => call.url) };
}

const run = async (fake, { env = ENV, now = () => START } = {}) => {
  const lines = [];
  const result = await runDigest({ env, fetchImpl: fake.fetchImpl, now, log: (line) => lines.push(line) });
  return { ...result, line: JSON.parse(lines[0]), text: lines.join("\n") };
};

test("the run reports yesterday's Brisbane date, which the app accepts as closed", () => {
  assert.equal(digestOwnerDateOf(START), "2026-10-07");
  assert.equal(digestOwnerDateOf(Date.parse("2026-10-07T13:59:00.000Z")), "2026-10-06");
  const body = { runDeadline: new Date(START + 180_000).toISOString(), ownerDate: digestOwnerDateOf(START) };
  assert.equal(parseDigestRequest(JSON.stringify(body), START + 1_000).ok, true);
});

test("a created digest is announced once on Slack with the fixed sentence and its link, then the heartbeat", async () => {
  const fake = fakeFetch({
    [DIGEST]: [200, { result: "created", itemId: ITEM }],
    [WEBHOOK]: [200, "ok"],
    [HEARTBEAT]: [200],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [0, "created"]);
  assert.deepEqual(fake.urls(), [DIGEST, WEBHOOK, HEARTBEAT]);
  assert.deepEqual(fake.calls[0].body, { runDeadline: "2026-10-07T21:03:00.000Z", ownerDate: "2026-10-07" });
  assert.equal(fake.calls[0].auth, `Bearer ${SECRET}`);
  assert.deepEqual(fake.calls[1].body, slackNoticeBody(`${DIGEST_SENTENCE}\n${APP}/admin/agents/sre-ops/items/${ITEM}`));
  assert.equal(fake.calls[1].body.unfurl_links, false);
  // Neither Slack nor the heartbeat receives the bearer.
  assert.deepEqual(fake.calls.map((call) => call.auth !== null), [true, false, false]);
  assert.equal(result.line.notified, true);
});

test("a replayed digest is not announced again; the heartbeat still goes", async () => {
  const fake = fakeFetch({ [DIGEST]: [200, { result: "replayed", itemId: ITEM }], [HEARTBEAT]: [200] });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome, result.line.notified], [0, "replayed", false]);
  assert.deepEqual(fake.urls(), [DIGEST, HEARTBEAT]);
});

test("an untrusted chain, a refusal or a late answer sends nothing and beats nothing", async () => {
  for (const [answer, outcome, extra] of [
    [[200, { result: "untrusted", trust: "audit_unverified" }], "digest_refused", "untrusted"],
    [[400, { refused: "date_not_final" }], "digest_refused", "unknown"],
    [[409, { error: "late" }], "late", undefined],
    [[200, { result: "<injected>" }], "digest_refused", "unknown"],
  ]) {
    const fake = fakeFetch({ [DIGEST]: answer });
    const result = await run(fake);
    assert.deepEqual([result.exitCode, result.outcome], [1, outcome], JSON.stringify(answer));
    assert.equal(result.line.result, extra);
    assert.deepEqual(fake.urls(), [DIGEST]);
  }
});

test("a webhook that is not Slack's is never posted to, and a failed notice withholds the heartbeat", async () => {
  for (const webhook of ["https://evil.example/hook", "http://hooks.slack.com/services/x", undefined]) {
    const fake = fakeFetch({ [DIGEST]: [200, { result: "created", itemId: ITEM }] });
    const result = await run(fake, { env: { ...ENV, OPS_OBSERVER_DIGEST_WEBHOOK_URL: webhook } });
    assert.deepEqual([result.exitCode, result.outcome], [1, "webhook_not_slack"], String(webhook));
    assert.deepEqual(fake.urls(), [DIGEST]);
  }
  for (const answer of [[500, "no"], new Error("ECONNRESET")]) {
    const fake = fakeFetch({ [DIGEST]: [200, { result: "created", itemId: ITEM }], [WEBHOOK]: answer });
    const result = await run(fake);
    assert.deepEqual([result.exitCode, result.outcome], [1, "notice_failed"]);
    assert.ok(fake.urls().every((url) => url !== HEARTBEAT));
  }
});

test("an item id the link cannot carry is not announced", async () => {
  const fake = fakeFetch({ [DIGEST]: [200, { result: "created", itemId: "NOT-A-UUID" }] });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [1, "item_unusable"]);
  assert.deepEqual(fake.urls(), [DIGEST]);
});

test("a run started before the date is closed asks nothing, and a late clock stops it", async () => {
  // 00:05 Brisbane: yesterday is still open for reservations that began before midnight.
  const early = fakeFetch({});
  const result = await run(early, { now: () => Date.parse("2026-10-07T14:05:00.000Z") });
  assert.deepEqual([result.exitCode, result.outcome], [1, "date_not_final"]);
  assert.deepEqual(early.urls(), []);
  let tick = 0;
  const late = fakeFetch({});
  const stopped = await run(late, { now: () => (tick++ === 0 ? START : START + 176_000) });
  assert.deepEqual([stopped.exitCode, stopped.outcome], [1, "late"]);
});

test("the log line carries no secret, URL or id", async () => {
  const fake = fakeFetch({
    [DIGEST]: [200, { result: "created", itemId: ITEM }],
    [WEBHOOK]: [200, "ok"],
    [HEARTBEAT]: [503],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [1, "heartbeat_failed"]);
  for (const leaked of [SECRET, APP, WEBHOOK, "hooks.slack", HEARTBEAT, ITEM]) assert.ok(!result.text.includes(leaked), leaked);
});
