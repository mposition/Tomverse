import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { randomUUID } from "node:crypto";
import { connectedJourneyPropertiesSchema, connectedJourneyDedupeKey, CONNECTED_JOURNEY_WINDOW_MS as day } from "../lib/connectedJourneyShared.ts";
import { analyticsClientEventSchema, analyticsPropertiesForGa4, shouldSendCustomProductEventToGa4, ga4EcommerceEventForProductEvent, validProductEventProperties } from "../lib/productAnalyticsShared.ts";
import { summarizeConnectedJourneys } from "../lib/connectedJourneyAggregation.ts";
import { isProductAnalyticsAllowed } from "../lib/analyticsConsentPolicy.ts";
const { syncJourneyIdentity } = require("../lib/connectedJourneyIdentity.ts");
const { configureAnalyticsClient, disableAnalyticsClient, flushConnectedJourneyEvents } = require("../lib/productAnalyticsClient.ts");
const { beginConnectedJourney, journeyStep, applyJourneyToDraft, captureJourneyDraft, bindJourneyFirstSource, observeJourneyDispatch, observeJourneyReply, invalidateJourneyDraft, moveJourneyDraft, observeJourneyWorkspace } = require("../lib/connectedJourneyAnalytics.ts");

const props = (stage = "started", extra = {}) => ({ journey_key: randomUUID(), journey_kind: "review_chat", journey_entry: "review_studio", journey_stage: stage, ...extra });
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) }; };
let delivered = [], ga4 = [], timers = [];
beforeEach(() => {
  globalThis.window = { localStorage: storage(), sessionStorage: storage(), location: new URL("https://tomverse.app/chat"), setTimeout: cb => { timers.push(cb); return timers.length; }, gtag: (...args) => ga4.push(args) };
  globalThis.document = { cookie: "" };
  delivered = []; ga4 = []; timers = [];
  globalThis.fetch = async (_url, init) => { delivered.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); };
  disableAnalyticsClient();
  window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
  syncJourneyIdentity("account:A", true);
  configureAnalyticsClient({ country: "AU", language: "en", measurementId: "G-TEST", plan: "Free" });
});
const stages = () => delivered.filter(x => x.event_name === "connected_journey_step").map(x => x.properties.journey_stage);
const ready = () => { const j = beginConnectedJourney("review_studio"); journeyStep(j, "preview_ready"); applyJourneyToDraft(j, "chat:new"); return j; };
const reply = (j, status = "normal", nonempty = true, source = "first") => observeJourneyReply({ owner: j.owner, epoch: j.epoch, conversationId: "conversation", sourceUserMessageId: source, status, nonempty });

test("closed event-specific combinations reject unrelated content and cross-event journey fields", () => {
  assert.equal(connectedJourneyPropertiesSchema.safeParse(props()).success, true);
  for (const extra of [{ title: "secret" }, { conversation_id: "id" }, { journey_reason: "raw error" }, { product_id: "chat" }, { continuation_kind: "new" }, { journey_entry: "import_viewer" }]) {
    assert.equal(validProductEventProperties("connected_journey_step", props("started", extra)), false);
  }
  for (const p of [props("issue"), props("ready", { journey_reason: "create_failed" }), props("cancelled", { journey_reason: "source_changed" }), props("preview_ready", { journey_kind: "import_continuation", journey_entry: "import_complete", continuation_kind: "new" })]) {
    assert.equal(connectedJourneyPropertiesSchema.safeParse(p).success, false);
  }
  assert.equal(validProductEventProperties("chat_started", props()), false);
  assert.equal(shouldSendCustomProductEventToGa4("connected_journey_step"), false);
  assert.deepEqual(analyticsPropertiesForGa4({ ...props(), product_id: "kept" }), { product_id: "kept" });
  assert.equal(ga4EcommerceEventForProductEvent("connected_journey_step", props()), null);
  const p = props();
  assert.equal(connectedJourneyDedupeKey("A", p), connectedJourneyDedupeKey("A", { ...p, journey_reason: "ignored" }));
  assert.notEqual(connectedJourneyDedupeKey("A", p), connectedJourneyDedupeKey("B", p));
  assert.notEqual(connectedJourneyDedupeKey("A", p), connectedJourneyDedupeKey("A", { ...p, journey_stage: "ready" }));
});

test("regional allowance is shared and starts during undecided consent are never replayed", () => {
  assert.equal(isProductAnalyticsAllowed("unset", { country: "AU", mode: "notice_opt_out" }), true);
  assert.equal(isProductAnalyticsAllowed("unset", { country: "GB", mode: "opt_in" }), false);
  assert.equal(isProductAnalyticsAllowed("accepted", { country: "GB", mode: "opt_in" }), true);
  for (const allowed of [false, null]) { syncJourneyIdentity("account:A", allowed); assert.equal(beginConnectedJourney("import_viewer", "new"), null); }
  syncJourneyIdentity("account:A", true);
  assert.deepEqual(stages(), []);
});

test("only actual first fetch dispatch promotes the marker; source retry can recover from an issue", () => {
  const j = ready();
  bindJourneyFirstSource(j, "conversation", "first");
  assert.equal(window.sessionStorage.getItem("tomverse_connected_journeys_v1"), null);
  reply(j); assert.equal(stages().includes("reply_observed"), false);
  observeJourneyDispatch("account:A", "conversation", "first");
  observeJourneyDispatch("account:A", "conversation", "first");
  reply(j, "incomplete"); reply(j, "normal", false); reply(j, "error"); reply(j, "cancelled"); reply(j, "timeout");
  reply(j, "normal", true, "followup");
  assert.equal(stages().includes("reply_observed"), false);
  reply(j); reply(j);
  assert.deepEqual(stages(), ["started", "preview_ready", "ready", "send_dispatched", "issue", "reply_observed"]);
  assert.equal(ga4.filter(x => x[0] === "event" && x[1] === "connected_journey_step").length, 0);
  assert.equal(JSON.stringify(delivered).includes('"conversation"'), false);
  assert.equal(JSON.stringify(delivered).includes('"first"'), false);
  assert.equal(JSON.stringify(delivered).includes("account:A"), false);
});

test("clear and replacement invalidate, append supersedes, and normal new-conversation adoption survives", () => {
  const old = ready();
  const latest = ready();
  assert.equal(old.closed, true);
  assert.equal(captureJourneyDraft("chat:new"), latest);
  moveJourneyDraft("chat:new", "chat:conversation");
  observeJourneyWorkspace("chat:conversation", "conversation", "account:A", true);
  bindJourneyFirstSource(latest, "conversation", "first");
  observeJourneyDispatch("account:A", "conversation", "first"); reply(latest);
  assert.equal(stages().filter(x => x === "reply_observed").length, 1);
  const cleared = ready(); invalidateJourneyDraft("chat:new", "draft_cleared");
  bindJourneyFirstSource(cleared, "conversation", "first"); observeJourneyDispatch("account:A", "conversation", "first");
  assert.equal(cleared.closed, true);
  const cancelled = beginConnectedJourney("import_viewer", "new"); journeyStep(cancelled, "cancelled", "user_cancelled");
  assert.notEqual(cancelled.properties.journey_key, beginConnectedJourney("import_viewer", "new").properties.journey_key);
});

test("A to B to A fences markers, late callbacks and queued retries without changing general events", async () => {
  globalThis.fetch = async (_url, init) => { delivered.push(JSON.parse(init.body)); return new Response(null, { status: 503 }); };
  const j = ready(); bindJourneyFirstSource(j, "conversation", "first"); observeJourneyDispatch("account:A", "conversation", "first");
  await new Promise(resolve => setImmediate(resolve));
  const count = delivered.length;
  syncJourneyIdentity("account:B", true); syncJourneyIdentity("account:A", true);
  reply(j); journeyStep(j, "issue", "response_error");
  for (const cb of timers.splice(0)) cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, count);
  assert.equal(window.sessionStorage.getItem("tomverse_connected_journeys_v1"), null);
});

test("stored journey queue waits for auth resolution and drops mismatched owners on flush", () => {
  const p = props();
  const queued = owner => ({ eventId: randomUUID(), eventName: "connected_journey_step", occurredAt: new Date().toISOString(), modelCount: 0, properties: p, journeyOwner: owner });
  window.sessionStorage.setItem("tomverse_analytics_pending_events_v1", JSON.stringify([queued("account:A"), queued("account:B"), { ...queued("account:A"), eventName: "signup_started", properties: {}, journeyOwner: undefined }]));
  syncJourneyIdentity(undefined, null);
  configureAnalyticsClient({ country: "AU", language: "en", measurementId: null, plan: "Free" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_name, "signup_started");
  const configurations = ga4.filter(args => args[0] === "config").length;
  syncJourneyIdentity("account:A", true);
  flushConnectedJourneyEvents();
  assert.equal(ga4.filter(args => args[0] === "config").length, configurations);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].event_name, "connected_journey_step");
  assert.equal(delivered[1].journeyOwner, undefined);
  assert.equal(analyticsClientEventSchema.safeParse(delivered[0]).success, true);
});

test("cohorts separate mature/pending, exact actor, orphan, mismatch and reversed source evidence", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const key = randomUUID();
  const row = (actor, stage, ago, extra = {}) => ({ userId: actor, occurredAt: new Date(+now - ago), properties: props(stage, { journey_key: key, ...extra }) });
  const summary = summarizeConnectedJourneys([
    row("A", "started", 2 * day), row("A", "ready", 2 * day - 100), row("A", "send_dispatched", 2 * day - 200), row("A", "reply_observed", 2 * day - 300), row("A", "reply_observed", 2 * day - 300),
    row("B", "started", day / 2), row("B", "ready", day / 2 - 100), row("B", "send_dispatched", day / 2 - 200), row("B", "reply_observed", day / 2 - 300),
    row("C", "reply_observed", day),
    row("D", "started", 2 * day), row("D", "reply_observed", 2 * day - 300),
    row("E", "started", 2 * day), row("E", "ready", 2 * day - 100), row("E", "send_dispatched", 2 * day - 300), row("E", "reply_observed", 2 * day - 200),
    row("F", "started", 2 * day), row("F", "ready", 2 * day - 100, { journey_entry: "review_classic" }),
  ], now);
  assert.equal(summary.groups[0].mature, 4); assert.equal(summary.groups[0].replied, 1);
  assert.equal(summary.groups[0].rate, 0.25); assert.equal(summary.groups[0].pending, 1); assert.equal(summary.groups[0].pendingReplied, 1);
  assert.equal(summary.diagnostics.orphan, 1); assert.equal(summary.diagnostics.missingSend, 1); assert.equal(summary.diagnostics.reversed, 1);
  assert.equal(summary.diagnostics.mismatchedProperties, 1); assert.equal(summary.diagnostics.duplicates, 1);
  assert.deepEqual(summarizeConnectedJourneys([], now).groups, []);
});

test("pending early success is not a zero percent mature rate; issues do not prevent success", () => {
  const now = new Date(); const p = props();
  const rows = ["started", "ready", "send_dispatched", "issue", "reply_observed"].map((stage, i) => ({ userId: "A", occurredAt: new Date(+now - 5000 + i), properties: { ...p, journey_stage: stage, ...(stage === "issue" ? { journey_reason: "response_error" } : {}) } }));
  const pending = summarizeConnectedJourneys(rows, now).groups[0];
  assert.equal(pending.rate, null); assert.equal(pending.pendingReplied, 1);
  const mature = summarizeConnectedJourneys(rows, new Date(+now + day)).groups[0];
  assert.equal(mature.rate, 1); assert.equal(mature.issue, 1); assert.equal(mature.unobserved, 0);
});

test("rehydration observes only an unexpired same-owner dispatched exact source", () => {
  const markerKey = "tomverse_connected_journeys_v1";
  const epoch = require("../lib/connectedJourneyIdentity.ts").journeyIdentity().epoch;
  const marker = (extra = {}) => ({ properties: props(), owner: "account:A", startedAt: Date.now() - 1000, first: { conversationId: "conversation", sourceUserMessageId: "first" }, ...extra });
  const observed = { owner: "account:A", epoch, conversationId: "conversation", sourceUserMessageId: "first", status: "normal", nonempty: true };
  for (const invalid of [marker({ owner: "account:B" }), marker({ startedAt: Date.now() - day - 1 }), marker({ first: { conversationId: "elsewhere", sourceUserMessageId: "first" } }), marker({ first: { conversationId: "conversation", sourceUserMessageId: "previous" } })]) {
    window.sessionStorage.setItem(markerKey, JSON.stringify([invalid]));
    observeJourneyReply(observed);
  }
  assert.equal(stages().includes("reply_observed"), false);
  const valid = marker(); delete valid.properties.journey_stage;
  window.sessionStorage.setItem(markerKey, JSON.stringify([valid]));
  observeJourneyReply(observed); observeJourneyReply(observed);
  assert.equal(stages().filter(stage => stage === "reply_observed").length, 1);
});

test("a late canonical receipt cannot bind a replaced or navigated draft", () => {
  const captured = ready();
  observeJourneyWorkspace("chat:other", "other", "account:A", true);
  bindJourneyFirstSource(captured, "conversation", "first");
  observeJourneyDispatch("account:A", "conversation", "first"); reply(captured);
  assert.equal(stages().includes("send_dispatched"), false);
  assert.equal(stages().includes("reply_observed"), false);
  assert.equal(require("../lib/connectedJourneyAnalytics.ts").connectedDraftScope("workspace", "new"), "review:new");
});

test("analytics transport and blocked session storage do not prevent product work", () => {
  window.sessionStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  const j = ready();
  assert.doesNotThrow(() => { bindJourneyFirstSource(j, "conversation", "first"); observeJourneyDispatch("account:A", "conversation", "first"); reply(j); });
  assert.equal(stages().includes("reply_observed"), true);
});

test("observation window rejects late success and separates new/existing cohorts", () => {
  const now = new Date();
  const rows = [];
  for (const continuation_kind of ["new", "existing"]) {
    const p = props("started", { journey_kind: "import_continuation", journey_entry: "import_complete", continuation_kind });
    for (const [stage, since] of [["started", 0], ["ready", 10], ["send_dispatched", 20], ["reply_observed", day + 1]]) rows.push({ userId: "A", occurredAt: new Date(+now - 2 * day + since), properties: { ...p, journey_stage: stage } });
  }
  const result = summarizeConnectedJourneys(rows, now);
  assert.equal(result.groups.length, 2);
  assert.equal(result.diagnostics.outsideWindow, 2);
  assert.ok(result.groups.every(group => group.mature === 1 && group.sent === 1 && group.replied === 0 && group.unobserved === 1));
});


test("valid stages crossing the 30-day cohort boundary are not false orphans", () => {
  const now = new Date(); const p = props();
  const result = summarizeConnectedJourneys([
    { userId: "A", occurredAt: new Date(+now - 30.5 * day), properties: p },
    { userId: "A", occurredAt: new Date(+now - 29.8 * day), properties: { ...p, journey_stage: "reply_observed" } },
    { userId: "B", occurredAt: new Date(+now - 30.7 * day), properties: { ...p, journey_stage: "ready" } },
  ], now);
  assert.deepEqual(result.groups, []);
  assert.equal(result.diagnostics.orphan, 0);
});
