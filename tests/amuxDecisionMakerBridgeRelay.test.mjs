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
import { DM_LAUNCH_OUTPUT_MAX_BYTES } from "../lib/amux/decisionMakerLauncherCore.ts";
import { parseDmCard } from "../lib/amux/decisionMakerRequestCore.ts";
import { DM_INSTANCE_SCOPES } from "../lib/amux/decisionMakerSwitchCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const wire = read("apps/tomverse-orchestrator/src/dm_relay/wire.rs");
const flow = read("apps/tomverse-orchestrator/src/dm_relay/flow.rs");
const io = read("apps/tomverse-orchestrator/src/dm_relay/io.rs");

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
  // rustfmt wraps a long arm in braces; both shapes are the same mapping.
  const routes = [...flow.matchAll(/AppRoute::(\w+) => \{?\s*"\/api\/internal\/amux\/decision-maker\/([a-z/]+)"/g)];
  assert.equal(routes.length, 9);
  const envelopes = { Requests: "routed", Results: "submitted", ResultLookup: "found" };
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

test("the relay writes the local AMUX only through the marker's routes, outside /api/board", () => {
  const local = [...flow.matchAll(/LocalRoute::\w+ => "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(local, ["/api/dm-relay/pending", "/api/dm-relay/pending/release"]);
  for (const path of local) assert.equal(path.includes("/api/board"), false);
  const server = read("vendor/amux/crates/amux-server/src/api/dm_relay.rs");
  assert.match(server, /\.route\("\/pending", post\(set_marker\)\)/);
  assert.match(server, /\.route\("\/pending\/release", post\(release_marker\)\)/);
  assert.equal(stringConstant(io, "DM_RELAY_LOCAL_TOKEN_HEADER"), "x-amux-dm-relay-token");
  assert.match(server, /pub const TOKEN_HEADER: &str = "x-amux-dm-relay-token";/);
  // Off unless exactly `enabled`.
  assert.equal(stringConstant(io, "DM_RELAY_ENV"), "TOMVERSE_AMUX_DM_RELAY");
  assert.match(io, /if enabled != Some\("enabled"\) \{\s*return RelayActivation::Off;/);
});
