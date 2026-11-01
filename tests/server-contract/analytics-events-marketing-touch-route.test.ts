import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";
import { NextResponse } from "next/server";

// docs/policy/marketing-automation.md §10.1, on the real route handler: a
// marketing touch is timed by the server and stamped with the server's own
// evidence value, a client cannot write evidence or attribution, and a sign-up
// or a guest's first answer carries the last touch of the seven days before
// the server received it.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

let session: { user: { id: string } } | null = null;
type Row = Record<string, unknown>;
const created: Row[] = [];
const touchQueries: Row[] = [];
let touchRow: Row | null = null;
const repairQueries: Row[] = [];
let recentConversions: Row[] = [];
const updates: Array<{ where: Row; data: Row }> = [];
let repairFails = false;

class FakeSecurityError extends Error {}

mock.module(mod("node_modules/next-auth/next/index.js"), {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    consumeApiRateLimit: async () => {},
    readLimitedJson: async (
      request: Request,
      _limit: number,
      schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }
    ) => {
      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) throw new FakeSecurityError("invalid");
      return parsed.data;
    },
    apiSecurityResponse: (error: unknown) =>
      error instanceof FakeSecurityError ? new Response(null, { status: 400 }) : null,
  },
});
mock.module(mod("lib/clientIp.ts"), {
  namedExports: { getAnonymousClientKey: () => "test-client" },
});
mock.module(mod("lib/operationalMonitoring.ts"), {
  namedExports: { reportOperationalIncident: async () => {} },
});
// The route reports a failure from `after()`, which needs a request scope this
// harness does not have; run the callback inline instead.
mock.module("next/server", {
  namedExports: { NextResponse, after: (callback: () => unknown) => callback() },
});
// Which statements ran inside the per-browser lock, in order.
const transactions: string[][] = [];
let current: string[] | null = null;
const note = (step: string) => current?.push(step);
const productAnalyticsEvent = {
  create: async ({ data }: { data: Row }) => {
    created.push(data);
    return data;
  },
  createMany: async ({ data }: { data: Row[]; skipDuplicates: boolean }) => {
    note("insert");
    created.push(...data);
    return { count: data.length };
  },
  findFirst: async (query: Row) => {
    note("lookup");
    touchQueries.push(query);
    return touchRow;
  },
  findMany: async (query: Row) => {
    note("repair-read");
    repairQueries.push(query);
    if (repairFails) throw new Error("database unavailable");
    return recentConversions;
  },
  update: async (args: { where: Row; data: Row }) => {
    note("repair-write");
    updates.push(args);
    return args.data;
  },
};
const lockKeys: unknown[] = [];
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      user: {
        findUnique: async () => (session ? { plan: "Free" } : null),
      },
      productAnalyticsEvent,
      $transaction: async (work: (db: unknown) => Promise<unknown>) => {
        current = [];
        transactions.push(current);
        try {
          return await work({
            $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
              note("lock");
              lockKeys.push(...values);
              return 1;
            },
            $queryRaw: async () => {
              note("clock");
              return [{ epochMs: Date.now() }];
            },
            productAnalyticsEvent,
          });
        } finally {
          current = null;
        }
      },
    },
  },
});

const POST = async (request: Request) => {
  const route = (await import(mod("app/api/analytics/events/route.ts"))) as {
    POST: (request: Request) => Promise<Response>;
  };
  return route.POST(request);
};

const clientId = randomUUID();
const event = (eventName: string, properties: Row = {}, overrides: Row = {}) =>
  new Request("https://tomverse.app/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: randomUUID(),
      event_name: eventName,
      occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      model_count: 0,
      properties,
      client_id: clientId,
      session_id: String(Date.now()),
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "launch",
      language: "en",
      country: "AU",
      ...overrides,
    }),
  });

beforeEach(() => {
  session = null;
  created.length = 0;
  touchQueries.length = 0;
  touchRow = null;
  repairQueries.length = 0;
  recentConversions = [];
  updates.length = 0;
  repairFails = false;
  transactions.length = 0;
  lockKeys.length = 0;
});

test("a marketing touch is recorded at the server's receipt, never the client's clock", async () => {
  const before = Date.now();
  const response = await POST(event("marketing_touch", { utm_content: "linkedin-1" }));
  const after = Date.now();
  assert.equal(response.status, 202);
  assert.equal(created.length, 1);
  const occurredAt = (created[0].occurredAt as Date).getTime();
  assert.ok(
    occurredAt >= before && occurredAt <= after,
    "the client said an hour ago; the server must record now"
  );
  assert.equal(created[0].eventName, "marketing_touch");
  assert.equal(created[0].utmSource, "linkedin");
  assert.deepEqual(
    {
      utm_content: (created[0].properties as Row).utm_content,
      touch_evidence: (created[0].properties as Row).touch_evidence,
    },
    { utm_content: "linkedin-1", touch_evidence: "client_observed_server_time" }
  );
  assert.equal(touchQueries.length, 0, "a touch is not itself attributed");
});

test("other events keep a plausible client clock", async () => {
  const response = await POST(event("landing_view"));
  assert.equal(response.status, 202);
  const occurredAt = (created[0].occurredAt as Date).getTime();
  assert.ok(Date.now() - occurredAt >= 59 * 60 * 1000);
});

test("a client cannot claim evidence or an attribution; the server overwrites both", async () => {
  await POST(
    event("marketing_touch", {
      touch_attribution: "attributed",
      touch_utm_source: "forged",
    })
  );
  const touchProperties = created[0].properties as Row;
  assert.equal(touchProperties.touch_evidence, "client_observed_server_time");
  assert.equal(touchProperties.touch_attribution, undefined);
  assert.equal(touchProperties.touch_utm_source, undefined);

  await POST(
    event("landing_view", {
      touch_evidence: "client_observed_server_time",
      touch_attribution: "attributed",
      touch_utm_campaign: "forged",
      touch_received_at: new Date().toISOString(),
    })
  );
  const landing = created[1].properties as Row;
  for (const key of [
    "touch_evidence",
    "touch_attribution",
    "touch_utm_campaign",
    "touch_received_at",
  ]) {
    assert.equal(landing[key], undefined, key);
  }

  session = { user: { id: "user-1" } };
  await POST(
    event("signup_completed", {
      method: "google",
      touch_attribution: "attributed",
      touch_utm_source: "forged",
    })
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(created[2].properties as Row).filter(([key]) => key.startsWith("touch_"))
    ),
    { touch_attribution: "unattributed" },
    "no touch was found, so a forged attribution must not survive"
  );
});

test("an evidence value outside the closed list is refused outright", async () => {
  const response = await POST(event("marketing_touch", { touch_evidence: "server_verified" }));
  assert.equal(response.status, 400);
  assert.equal(created.length, 0);
});

test("a sign-up is fixed to the last touch in the seven days before receipt", async () => {
  session = { user: { id: "user-1" } };
  const touchedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  touchRow = {
    utmSource: "instagram",
    utmMedium: "social",
    utmCampaign: "launch",
    properties: { utm_content: "instagram-1", touch_evidence: "client_observed_server_time" },
    occurredAt: touchedAt,
  };
  const before = Date.now();
  await POST(event("signup_completed", { method: "google" }));
  const after = Date.now();

  assert.equal(touchQueries.length, 1);
  const where = touchQueries[0].where as Row;
  const window = where.occurredAt as { gte: Date; lte: Date };
  assert.equal(where.eventName, "marketing_touch");
  assert.ok(window.lte.getTime() >= before && window.lte.getTime() <= after);
  assert.equal(window.lte.getTime() - window.gte.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(touchQueries[0].orderBy, [{ occurredAt: "desc" }, { createdAt: "desc" }]);
  const identities = where.OR as Row[];
  assert.equal(identities.length, 2, "a signed-in conversion matches the browser and the account");
  assert.deepEqual(identities[1], { userId: "user-1" });
  assert.equal(typeof identities[0].anonymousIdHash, "string");
  assert.notEqual(identities[0].anonymousIdHash, clientId, "the raw client id is never queried");

  const properties = created[0].properties as Row;
  assert.deepEqual(
    {
      method: properties.method,
      touch_attribution: properties.touch_attribution,
      touch_evidence: properties.touch_evidence,
      touch_utm_source: properties.touch_utm_source,
      touch_utm_medium: properties.touch_utm_medium,
      touch_utm_campaign: properties.touch_utm_campaign,
      touch_utm_content: properties.touch_utm_content,
      touch_received_at: properties.touch_received_at,
    },
    {
      method: "google",
      touch_attribution: "attributed",
      touch_evidence: "client_observed_server_time",
      touch_utm_source: "instagram",
      touch_utm_medium: "social",
      touch_utm_campaign: "launch",
      touch_utm_content: "instagram-1",
      touch_received_at: touchedAt.toISOString(),
    }
  );
});

test("a guest's first answer is a lead; a signed-in first answer is not", async () => {
  await POST(event("first_response_completed", { model_id: "gpt-6-luna" }));
  assert.equal(touchQueries.length, 1);
  assert.equal((touchQueries[0].where as { OR: Row[] }).OR.length, 1);
  assert.equal((created[0].properties as Row).touch_attribution, "unattributed");

  session = { user: { id: "user-2" } };
  await POST(event("first_response_completed", { model_id: "gpt-6-luna" }));
  assert.equal(touchQueries.length, 1, "no lookup for a signed-in first answer");
  assert.equal((created[1].properties as Row).touch_attribution, undefined);
});

test("a touch stored just after its conversion finishes that conversion's snapshot", async () => {
  // The browser observed the touch an hour ago (the event's client time) and
  // its sign-up a moment ago; the server stored the sign-up first.
  const conversionReceived = new Date(Date.now() - 500);
  recentConversions = [
    {
      id: "conversion-1",
      eventName: "signup_completed",
      userId: "user-1",
      occurredAt: new Date(Date.now() - 1_000),
      createdAt: conversionReceived,
      properties: { method: "google", touch_attribution: "unattributed" },
    },
    {
      id: "conversion-2",
      eventName: "first_response_completed",
      userId: "user-1",
      occurredAt: new Date(Date.now() - 1_000),
      createdAt: conversionReceived,
      properties: { model_id: "gpt-6-luna" },
    },
  ];
  const response = await POST(event("marketing_touch", { utm_content: "linkedin-1" }));
  assert.equal(response.status, 202);

  assert.equal(repairQueries.length, 1);
  const where = repairQueries[0].where as Row;
  const window = where.createdAt as { gte: Date; lte: Date };
  assert.equal(window.lte.getTime() - window.gte.getTime(), 60_000, "thirty seconds either side");
  assert.equal((where.OR as Row[]).length, 1, "a guest touch matches its browser only");

  assert.equal(updates.length, 1, "a signed-in first answer is not a lead and is left alone");
  assert.deepEqual(updates[0].where, { id: "conversion-1" });
  const repaired = updates[0].data.properties as Row;
  assert.equal(repaired.method, "google");
  assert.equal(repaired.touch_attribution, "attributed");
  assert.equal(repaired.touch_utm_source, "linkedin");
  assert.equal(repaired.touch_utm_content, "linkedin-1");
  assert.equal(repaired.touch_evidence, "client_observed_server_time");
  assert.equal(
    repaired.touch_received_at,
    (created[0].occurredAt as Date).toISOString(),
    "the repair records the touch's server time"
  );
});

test("a touch the browser observed after the conversion repairs nothing", async () => {
  recentConversions = [
    {
      id: "conversion-1",
      eventName: "signup_completed",
      userId: "user-1",
      // The conversion's own client time is earlier than the touch's.
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 500),
      properties: { touch_attribution: "unattributed" },
    },
  ];
  await POST(event("marketing_touch"));
  assert.equal(updates.length, 0);
});

test("a failed repair fails the touch's transaction, so the browser sends it again", async () => {
  repairFails = true;
  const response = await POST(event("marketing_touch"));
  assert.ok(response.status >= 500, "a retryable answer; the touch insert rolls back with it");
});

test("a touch and a conversion each run whole inside the same per-browser lock", async () => {
  await POST(event("marketing_touch"));
  session = { user: { id: "user-1" } };
  await POST(event("signup_completed", { method: "google" }));
  await POST(event("landing_view"));
  assert.deepEqual(transactions, [
    ["lock", "clock", "insert", "repair-read"],
    ["lock", "clock", "lookup", "insert"],
  ], "the touch inserts then repairs; the conversion looks then inserts; landing_view takes no lock");
  assert.equal(lockKeys.length, 2);
  assert.equal(lockKeys[0], lockKeys[1], "one key per browser");
  assert.ok(!String(lockKeys[0]).includes(clientId), "keyed on the digest, never the raw client id");
});

test("conversions and other events never start a repair", async () => {
  session = { user: { id: "user-1" } };
  await POST(event("signup_completed", { method: "google" }));
  await POST(event("landing_view"));
  assert.equal(repairQueries.length, 0);
});
