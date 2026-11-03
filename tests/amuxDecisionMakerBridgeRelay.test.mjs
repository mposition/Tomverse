// The AMUX Decision Maker bridge relay, stage S2-2b2
// (docs/policy/amux-decision-maker.md §2, §9, §10): the Rust relay in
// apps/tomverse-orchestrator/src/dm_relay restates a few of the app's rules --
// the request-keyed digests, the caps, the socket path, the broker's deadline,
// the routes and their answer envelopes, the policy version a result repeats.
// Rust cannot import them, so this holds each restatement to its source. A
// change on either side fails here instead of in production, where a wrong
// digest would make every transmission intent a mismatch.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { AUTHORITY_MANIFEST_VERSION } from "../lib/agentAuthorityFiles.ts";
import { DM_POLICY_VERSION } from "../lib/amux/decisionMakerCore.ts";
import { dmOptionSetDigest, dmPayloadDigest, dmResultDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_BROKER_RESPONSE_DEADLINE_MS,
  DM_BROKER_SOCKET_PATH,
  DM_PAYLOAD_MAX_BYTES,
  DM_RESULT_LINE_MAX_BYTES,
} from "../lib/amux/decisionMakerBrokerCore.ts";
import {
  DM_DELIVERY_JUDGMENT_LABELS,
  DM_DELIVERY_MESSAGE_ID_PREFIX,
  DM_DELIVERY_MESSAGE_MAX_BYTES,
  dmDeliveryHeader,
} from "../lib/amux/decisionMakerDeliveryCore.ts";
import { DM_DELIVERY_NOT_SENT_REASONS } from "../lib/amux/decisionMakerJudgmentCore.ts";
import { DM_LAUNCH_OUTPUT_MAX_BYTES } from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_STALE_CLOSE_AFTER_MS } from "../lib/amux/decisionMakerRequestCore.ts";
import { parseDmCard } from "../lib/amux/decisionMakerRequestCore.ts";
import { DM_INSTANCE_SCOPES } from "../lib/amux/decisionMakerSwitchCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const wire = read("apps/tomverse-orchestrator/src/dm_relay/wire.rs");
const flow = read("apps/tomverse-orchestrator/src/dm_relay/flow.rs");
const io = read("apps/tomverse-orchestrator/src/dm_relay/io.rs");
const delivery = read("apps/tomverse-orchestrator/src/dm_relay/delivery.rs");
const direct = read("apps/tomverse-orchestrator/src/dm_relay/direct.rs");

/** A Rust integer expression of literals and `*` (`128 * 1024`, `34 * 60 * 1000`). */
const product = (expression) =>
  expression.split("*").reduce((total, factor) => {
    const text = factor.trim().replaceAll("_", "");
    assert.match(text, /^\d+$/, `not a literal product: ${expression}`);
    return total * Number(text);
  }, 1);

const constant = (source, name) => {
  const match = source.match(new RegExp(`pub const ${name}: [^=]+= ([^;]+);`));
  assert.ok(match, `${name} is not declared`);
  return match[1].trim();
};

const stringConstant = (source, name) => {
  const value = constant(source, name);
  assert.match(value, /^"[^"\\]*"$/, `${name} is not a plain string`);
  return value.slice(1, -1);
};

test("the result binding repeats the routing policy version and the classification version the app has", () => {
  assert.equal(Number(constant(wire, "DM_REQUEST_POLICY_VERSION")), DM_POLICY_VERSION);
  assert.equal(stringConstant(wire, "DM_CLASSIFICATION_VERSION"), `authority-manifest-${AUTHORITY_MANIFEST_VERSION}`);
});

test("the caps and the socket are the broker's and the launcher's", () => {
  assert.equal(product(constant(wire, "DM_PAYLOAD_MAX_BYTES")), DM_PAYLOAD_MAX_BYTES);
  assert.equal(product(constant(wire, "DM_RESULT_LINE_MAX_BYTES")), DM_RESULT_LINE_MAX_BYTES);
  assert.equal(product(constant(wire, "DM_LAUNCH_OUTPUT_MAX_BYTES")), DM_LAUNCH_OUTPUT_MAX_BYTES);
  assert.equal(stringConstant(io, "DM_BROKER_SOCKET_PATH"), DM_BROKER_SOCKET_PATH);
  const deadline = constant(io, "DM_BROKER_RESPONSE_DEADLINE").match(/^Duration::from_millis\((.+)\)$/);
  assert.ok(deadline);
  assert.equal(product(deadline[1]), DM_BROKER_RESPONSE_DEADLINE_MS);
  const instances = [...constant(wire, "DM_INSTANCES").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(instances, [...DM_INSTANCE_SCOPES]);
});

test("the relay never sends a result body the result route would refuse unread", () => {
  const route = read("app/api/internal/amux/decision-maker/results/route.ts");
  const cap = route.match(/const MAX_BODY_BYTES = ([^;]+);/);
  assert.ok(cap);
  assert.equal(product(constant(wire, "DM_RESULT_BODY_MAX_BYTES")), product(cap[1]));
});

test("every route the relay calls exists and answers under the envelope the relay reads", () => {
  // rustfmt wraps a long arm in braces; both shapes are the same mapping. A path may hold a hyphen
  // (requests/direct-answer).
  const routes = [...flow.matchAll(/AppRoute::(\w+) => \{?\s*"\/api\/internal\/amux\/decision-maker\/([a-z/-]+)"/g)];
  // Nine for a question (stage S2-2b2), three for a confirmed answer's delivery (S2-2b3), and the
  // unsettled read and the direct answer's report (S2-2b4).
  assert.equal(routes.length, 14);
  const envelopes = {
    Requests: "routed",
    Results: "submitted",
    ResultLookup: "found",
    DeliveriesNext: "found",
    DeliveriesUnsettled: "found",
  };
  for (const [, name, path] of routes) {
    const file = `app/api/internal/amux/decision-maker/${path}/route.ts`;
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
    const source = read(file);
    const envelope = envelopes[name] ?? "recorded";
    assert.ok(
      source.includes(`dmRouteRefusal("${envelope}")`) || source.includes(`{ ${envelope}: false, reason }`),
      `${file} answers refusals under "${envelope}"`,
    );
    assert.ok(source.includes(`${envelope}: true`), `${file} answers success under "${envelope}"`);
  }
  for (const [name, envelope] of Object.entries(envelopes)) {
    assert.ok(flow.includes(`AppRoute::${name} => "${envelope}"`), name);
  }
});

test("the relay's digest vectors are the app's own functions' output", () => {
  const key = Buffer.alloc(32, 7);
  const vectors = [
    dmPayloadDigest(key, Buffer.from("amux payload \u00e9\n", "utf8")),
    dmOptionSetDigest(key, [
      { id: "b-2", label: 'Beta "two"\n' },
      { id: "A_1", label: "Alpha \u00e9 \u0001" },
    ]),
    dmResultDigest(key, { kind: "output", raw: '{"output":{"kind":"escalate","reason":"r"}}' }),
    dmResultDigest(key, { kind: "timeout" }),
    dmResultDigest(key, { kind: "unavailable" }),
  ];
  for (const digest of vectors) {
    assert.ok(wire.includes(`"${digest}"`), `wire.rs does not pin ${digest}`);
  }
});

test("option effects go on the wire exactly when the app's routing parser takes them (stage S2-2b1)", () => {
  const flag = constant(wire, "DM_SEND_OPTION_EFFECTS");
  assert.match(flag, /^(true|false)$/);
  const card = {
    askType: "decision",
    resolution: null,
    type: "task",
    tags: [],
    title: "T",
    question: "Q?",
    options: [{ id: "a", label: "A", effect: "choice_only", paths: [] }],
    unblocks: "U.",
    context: "",
    contextPaths: [],
  };
  assert.equal(flag === "true", parseDmCard(card) !== null);
});

test("the relay writes the local AMUX only through the relay's own routes, outside /api/board", () => {
  const local = [...flow.matchAll(/LocalRoute::\w+ => "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(local, [
    "/api/dm-relay/pending",
    "/api/dm-relay/pending/release",
    // Stage S2-2b3: a confirmed answer's check, delivery and unknown delivery.
    "/api/dm-relay/answers/check",
    "/api/dm-relay/answers",
    "/api/dm-relay/answers/unknown",
    // Stage S2-2b4: two reads by POST, the operator's answer records and one decision's records.
    "/api/dm-relay/answers/operator",
    "/api/dm-relay/answers/receipt",
    // A v22 worker's question filed and closed as a typed-ask card (operator
    // decision 2026-10-30): writes under the same prefix and token.
    "/api/dm-relay/v22-questions",
    "/api/dm-relay/v22-questions/close",
  ]);
  for (const path of local) assert.equal(path.includes("/api/board"), false);
  const server = read("vendor/amux/crates/amux-server/src/api/dm_relay.rs");
  assert.match(server, /\.route\("\/pending", get\(list_markers\)\.post\(set_marker\)\)/);
  assert.match(server, /\.route\("\/pending\/release", post\(release_marker\)\)/);
  assert.match(server, /\.route\("\/answers", post\(deliver_answer\)\)/);
  assert.match(server, /\.route\("\/answers\/check", post\(check_answer\)\)/);
  assert.match(server, /\.route\("\/answers\/unknown", post\(answer_unknown\)\)/);
  assert.match(server, /\.route\("\/answers\/operator", post\(operator_answers\)\)/);
  assert.match(server, /\.route\("\/answers\/receipt", post\(answer_receipt\)\)/);
  assert.match(server, /\.route\("\/v22-questions", post\(super::dm_relay_v22::file\)\)/);
  assert.match(server, /\.route\("\/v22-questions\/close", post\(super::dm_relay_v22::close\)\)/);
  // The one local read under the relay's prefix: every marker, for a restart.
  assert.equal(stringConstant(flow, "LOCAL_MARKER_LIST_PATH"), "/api/dm-relay/pending");
  const routeTable = read("vendor/amux/crates/amux-server/src/api/request_log.rs");
  assert.match(routeTable, /RouteEntry \{ path: "\/api\/dm-relay\/pending", methods: &\["GET", "POST"\] \}/);
  for (const path of [
    "/api/dm-relay/answers",
    "/api/dm-relay/answers/check",
    "/api/dm-relay/answers/unknown",
    "/api/dm-relay/answers/operator",
    "/api/dm-relay/answers/receipt",
    "/api/dm-relay/v22-questions",
    "/api/dm-relay/v22-questions/close",
  ]) {
    assert.ok(routeTable.includes(`RouteEntry { path: "${path}", methods: &["POST"] }`), path);
  }
  assert.equal(stringConstant(io, "DM_RELAY_LOCAL_TOKEN_HEADER"), "x-amux-dm-relay-token");
  assert.match(server, /pub const TOKEN_HEADER: &str = "x-amux-dm-relay-token";/);
  // Off unless exactly `enabled`.
  assert.equal(stringConstant(io, "DM_RELAY_ENV"), "TOMVERSE_AMUX_DM_RELAY");
  assert.match(io, /if enabled != Some\("enabled"\) \{\s*return RelayActivation::Off;/);
});

test("a confirmed answer's message id, cap, labels and header are the app's, on the bridge and the local AMUX (stage S2-2b3)", () => {
  const server = read("vendor/amux/crates/amux-server/src/api/dm_relay.rs");
  assert.equal(stringConstant(delivery, "DM_DELIVERY_MESSAGE_ID_PREFIX"), DM_DELIVERY_MESSAGE_ID_PREFIX);
  assert.equal(stringConstant(server, "ANSWER_MESSAGE_ID_PREFIX"), DM_DELIVERY_MESSAGE_ID_PREFIX);
  assert.equal(product(constant(delivery, "DM_DELIVERY_MESSAGE_MAX_BYTES")), DM_DELIVERY_MESSAGE_MAX_BYTES);
  assert.equal(product(constant(server, "ANSWER_MESSAGE_MAX_BYTES")), DM_DELIVERY_MESSAGE_MAX_BYTES);
  assert.equal(stringConstant(delivery, "DM_DELIVERY_CONFIRMED_LABEL"), DM_DELIVERY_JUDGMENT_LABELS.confirm);
  assert.equal(stringConstant(delivery, "DM_DELIVERY_EDITED_LABEL"), DM_DELIVERY_JUDGMENT_LABELS.edit_confirm);
  // What the bridge and the local AMUX check of the header is what the app writes.
  for (const instance of DM_INSTANCE_SCOPES) {
    for (const kind of ["confirm", "edit_confirm"]) {
      const header = dmDeliveryHeader({ instance, judgmentKind: kind, cardId: "AMUX-12" });
      assert.ok(header.startsWith(`[Decision Maker ${instance} (`), header);
      assert.ok(header.endsWith(`) 제안, ${DM_DELIVERY_JUDGMENT_LABELS[kind]}, re AMUX-12]`), header);
    }
  }
  assert.ok(delivery.includes('first.starts_with(&format!("[Decision Maker {instance} ("))'));
  assert.ok(delivery.includes('first.ends_with(&format!(") 제안, {label}, re {card_id}]"))'));
  assert.ok(server.includes('const ANSWER_HEADER_PREFIX: &str = "[Decision Maker ";'));
  assert.ok(server.includes('first.ends_with(&format!(", re {card_id}]"))'));
  // §9's binding travels under the same names from the app's read, through
  // the bridge, to the local AMUX's check and claim (review r-20261018-065705-65cb2a).
  const nextRoute = read("app/api/internal/amux/decision-maker/deliveries/next/route.ts");
  assert.match(nextRoute, /worker: read\.askingWorkerId,/);
  assert.match(nextRoute, /session_attempt: read\.sessionAttempt,/);
  assert.match(delivery, /let worker = delivery\.get\("worker"\)\?\.as_str\(\)\?;/);
  assert.match(delivery, /let session_attempt = delivery\.get\("session_attempt"\)\?\.as_i64\(\)\?;/);
  assert.equal((delivery.match(/"session_attempt": delivery\.session_attempt/g) ?? []).length, 2, "the check and the claim");
  for (const struct of ["AnswerCheckBody", "AnswerBody"]) {
    const body = server.slice(server.indexOf(`struct ${struct} {`), server.indexOf("}", server.indexOf(`struct ${struct} {`)));
    assert.match(body, /worker: String,/, struct);
    assert.match(body, /session_attempt: i64,/, struct);
  }
  // The relay's delivery routes are the app's three and the local AMUX's three.
  for (const route of ["DeliveriesNext", "Deliveries", "DeliveryOutcome"]) {
    assert.ok(delivery.includes(`AppRoute::${route}`), route);
  }
  for (const route of ["AnswerCheck", "Answers", "AnswerUnknown"]) {
    assert.ok(delivery.includes(`LocalRoute::${route}`), route);
  }
  // The dashboard's direct answer claims the same record first, behind the board's own route.
  const board = read("vendor/amux/crates/amux-server/src/api/board.rs");
  assert.match(board, /"\/\{id\}\/typed-ask\/answer",\s*post\(super::board_typed_ask::claim_operator_answer\)/);
  const dashboard = read("vendor/amux/crates/amux-dashboard/static/app.js");
  for (const handler of ["_focusAnswer", "_focusDecide"]) {
    const start = dashboard.indexOf(`async function ${handler}(`);
    const body = dashboard.slice(start, dashboard.indexOf("\nasync function ", start + 1));
    // Review r-20261018-062643-057a27, finding 1: the claim names the revision observed first.
    const observed = body.indexOf("await _focusObserveQuestion(item)");
    const claim = body.indexOf("await _focusClaimAnswer(item, seen.revision)");
    assert.ok(observed > 0 && claim > observed, `${handler} claims the revision it observed`);
    assert.ok(claim < body.indexOf("_focusSend("), `${handler} claims before it sends`);
    assert.ok(claim < body.indexOf("_focusPatch("), `${handler} claims before it records`);
  }
  // The answer dialog reads the question before it opens, and shows it.
  const answer = dashboard.slice(dashboard.indexOf("async function _focusAnswer("));
  assert.ok(answer.indexOf("_focusObserveQuestion(item)") < answer.indexOf("showFormModal("));
  // The claim's body is the observed revision.
  assert.match(dashboard, /body: JSON\.stringify\(\{ question_revision: revision \}\)/);
});

test("stage S2-2b4: the relay records a not-sent outcome only under the app's reasons, and reads back what it reports", () => {
  // The reasons the relay sends are the app's closed list, in its order.
  const reasons = [...constant(delivery, "DM_DELIVERY_NOT_SENT_REASONS").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(reasons, [...DM_DELIVERY_NOT_SENT_REASONS]);
  const mapped = new Set([...delivery.matchAll(/Some\("([a-z_]+)"\)/g)].map((match) => match[1]).filter((value) => reasons.includes(value)));
  assert.deepEqual([...mapped].sort(), [...DM_DELIVERY_NOT_SENT_REASONS].sort(), "every reason is one the relay can send");
  // The not-sent outcome travels as the outcome route reads it.
  const outcomeRoute = read("app/api/internal/amux/decision-maker/deliveries/outcome/route.ts");
  assert.match(outcomeRoute, /reason: z\.unknown\(\)\.optional\(\)/);
  assert.match(delivery, /"outcome": "not_sent", "reason": reason/);
  // The unsettled read's fields, from the app's answer to the relay's parse.
  const unsettledRoute = read("app/api/internal/amux/decision-maker/deliveries/unsettled/route.ts");
  for (const field of ["request_id", "decided_at_ms", "card_id", "question_revision", "worker", "session", "session_attempt", "message_id"]) {
    assert.ok(unsettledRoute.includes(`${field}: read.`), field);
    assert.ok(delivery.includes(`get("${field}")`), field);
  }
  // The direct answer's report: the card and the revision, no text.
  const directRoute = read("app/api/internal/amux/decision-maker/requests/direct-answer/route.ts");
  assert.match(directRoute, /card_id: z\.unknown\(\),\s+question_revision: z\.unknown\(\),\s+\}\)\s+\.strict\(\)/);
  assert.match(direct, /json!\(\{"card_id": answer\.card_id, "question_revision": answer\.question_revision\}\)/);
  // The walk looks back past the stale close, a day's margin over the 720 hours.
  assert.equal(product(constant(direct, "DM_DIRECT_ANSWER_LOOKBACK_SECS")) * 1000, DM_STALE_CLOSE_AFTER_MS + 24 * 60 * 60 * 1000);
});
