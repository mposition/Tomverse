import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let session;
let sessionError;
let reads;

mock.module("next-auth/next", { namedExports: { getServerSession: async () => {
  if (sessionError) throw sessionError;
  return session;
} } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), { namedExports: { autoAvailabilityFor: async (...args) => {
  reads.push(args);
  return { offered: false };
} } });

// Exercise the actual route. Every signed-in account gets the blank-Chat
// entry (owner decision 2026-11-12); Auto availability is never consulted.
const route = await import(mod("app/api/marketing/chat-entry/route.ts"));

test.beforeEach(() => {
  session = { user: { id: "owner-a" } };
  sessionError = null;
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
});

test("an empty authenticated identity remains unavailable", async () => {
  session = { user: { id: "" } };
  await assertPrivateBoolean(await route.GET(), false);
});

test("a signed-in account gets the blank-Chat entry without an Auto read", async () => {
  await assertPrivateBoolean(await route.GET(), true);
  assert.deepEqual(reads, []);
});

test("an unknown session read fails closed", async () => {
  sessionError = new Error("private session failure");
  await assertPrivateBoolean(await route.GET(), false);
});
