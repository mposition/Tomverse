import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let session, availability, reads, availabilityError;

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), {
  namedExports: {
    autoAvailabilityFor: async (...args) => {
      reads.push(args);
      if (availabilityError) throw availabilityError;
      return availability;
    },
  },
});
mock.module(mod("lib/autoRoutingUi.ts"), {
  namedExports: {
    autoSelectionCapability: (value) => ({ offered: value.offered }),
  },
});

const { GET } = await import(mod("app/api/products/chat/capabilities/route.ts"));

test.beforeEach(() => {
  session = { user: { id: "owner-a" } };
  availability = {
    offered: true,
    reason: null,
    cohort: { bucket: 7, eligible: true },
  };
  reads = [];
  availabilityError = null;
});

test("signed-in blank Chat receives only the server-owned offered boolean", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { autoSelection: { offered: true } });
  assert.deepEqual(reads, [["owner-a"]]);
});

test("guest request is refused without consulting rollout availability", async () => {
  session = null;
  const response = await GET();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(reads, []);
});

test("availability uncertainty fails closed without leaking an internal reason", async () => {
  availabilityError = new Error("database detail that must stay server-side");
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { autoSelection: { offered: false } });
    assert.deepEqual(reads, [["owner-a"]]);
  } finally {
    console.error = originalError;
  }
});
