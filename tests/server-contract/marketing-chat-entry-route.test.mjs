import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let session;
let sessionError;
let availabilityError;
let offered;
let reads;

mock.module("next-auth/next", { namedExports: { getServerSession: async () => {
  if (sessionError) throw sessionError;
  return session;
} } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), { namedExports: { autoAvailabilityFor: async (...args) => {
  reads.push(args);
  if (availabilityError) throw availabilityError;
  return { offered, reason: "private readiness detail", cohort: { bucket: 42 } };
} } });

// Exercise the actual route and product-entry boundary. Only the session and
// existing account availability read are fixtures; no rollout is activated.
const route = await import(mod("app/api/marketing/chat-entry/route.ts"));

test.beforeEach(() => {
  session = { user: { id: "owner-a" } };
  sessionError = null;
  availabilityError = null;
  offered = false;
  reads = [];
});

const assertPrivateBoolean = async (response, expected) => {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { offered: expected });
};

test("the route stays dynamic and anonymous requests cannot forge an account offer", async () => {
  assert.equal(route.dynamic, "force-dynamic");
  session = null;
  await assertPrivateBoolean(await route.GET(new Request("https://tomverse.test/api/marketing/chat-entry?offered=true&userId=owner-a")), false);
  assert.deepEqual(reads, []);
});

test("an empty authenticated identity remains unavailable without an account read", async () => {
  session = { user: { id: "" } };
  await assertPrivateBoolean(await route.GET(), false);
  assert.deepEqual(reads, []);
});

test("an offered account gets the actual blank-Chat entry decision without private details", async () => {
  offered = true;
  await assertPrivateBoolean(await route.GET(), true);
  assert.deepEqual(reads, [["owner-a"]]);
});

test("an unoffered account remains unavailable with the same private response shape", async () => {
  await assertPrivateBoolean(await route.GET(), false);
  assert.deepEqual(reads, [["owner-a"]]);
});

test("an unknown session read fails closed without checking any account", async () => {
  sessionError = new Error("private session failure");
  await assertPrivateBoolean(await route.GET(), false);
  assert.deepEqual(reads, []);
});

test("an unknown availability read fails closed without exposing its reason", async () => {
  availabilityError = new Error("private account failure");
  await assertPrivateBoolean(await route.GET(), false);
  assert.deepEqual(reads, [["owner-a"]]);
});

test("only a strict boolean offer can open the entry", async () => {
  offered = "true";
  await assertPrivateBoolean(await route.GET(), false);
});
