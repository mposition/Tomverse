import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

// The GA4 User-ID route (docs/policy/marketing-automation.md §10.2) with the
// notice treated as published, so the remaining server gates can be exercised
// one at a time. That the shipped notice flag keeps creation closed is covered
// in tests/ga4UserIdConsentGate.test.mjs.
//
// POST creates the account's random id on the first request that states
// explicit consent and returns the stored one after that. DELETE is the
// withdrawal: one GA4 deletion request naming the stored id, then the id is
// deleted, so the next consent gets a new one. The table is an in-memory
// stand-in; the GA4 request is recorded, never made.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

let session: { user: { id: string } } | null = null;
const rateLimitKeys: string[] = [];
const stored = new Map<string, { analyticsUserId: string; createdAt: Date }>();
const events: string[] = [];
let deletionOutcome: "submitted" | "refused" | "throws" = "submitted";

mock.module(mod("node_modules/next-auth/next/index.js"), {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    consumeApiRateLimit: async (_req: Request, _id: string, key: string) => {
      rateLimitKeys.push(key);
    },
    apiSecurityResponse: () => null,
  },
});
mock.module(mod("lib/ga4UserIdPolicy.ts"), {
  namedExports: {
    GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED: true,
    isGa4UserIdSwitchOn: (value: unknown) =>
      typeof value === "string" && value.trim().toLowerCase() === "true",
    isAnalyticsUserId: (value: unknown) =>
      typeof value === "string" && /^[0-9a-f]{32}$/.test(value),
  },
});
mock.module(mod("lib/ga4UserDeletion.ts"), {
  namedExports: {
    requestGa4UserIdDeletion: async (analyticsUserId: string, trigger: string) => {
      events.push(`ga4:${trigger}:${analyticsUserId}`);
      if (deletionOutcome === "throws") throw new Error("ga4 unreachable");
      return deletionOutcome === "submitted"
        ? { status: "submitted", deletionRequestTime: null }
        : { status: "refused", stage: "deletion", httpStatus: 403 };
    },
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      ga4UserId: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
          const row = stored.get(where.userId);
          return row ? { analyticsUserId: row.analyticsUserId } : null;
        },
        createMany: async ({
          data,
        }: {
          data: Array<{ userId: string; analyticsUserId: string }>;
          skipDuplicates: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            if (stored.has(row.userId)) continue;
            stored.set(row.userId, { analyticsUserId: row.analyticsUserId, createdAt: new Date() });
            events.push(`create:${row.userId}`);
            count += 1;
          }
          return { count };
        },
        deleteMany: async ({
          where,
        }: {
          where: { userId: string; analyticsUserId: string };
        }) => {
          const row = stored.get(where.userId);
          if (!row || row.analyticsUserId !== where.analyticsUserId) return { count: 0 };
          stored.delete(where.userId);
          events.push(`delete:${where.userId}:${where.analyticsUserId}`);
          return { count: 1 };
        },
      },
    },
  },
});

type Route = {
  POST: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
};
const route = async () =>
  (await import(mod("app/api/analytics/user-id/route.ts"))) as Route;

const URL = "https://tomverse.app/api/analytics/user-id";
const post = async (body?: string) =>
  (await route()).POST(
    new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
  );
const consented = () => post(JSON.stringify({ consent: "accepted" }));
const withdraw = async () => (await route()).DELETE(new Request(URL, { method: "DELETE" }));
const idOf = async (response: Response) =>
  ((await response.json()) as { analyticsUserId?: string }).analyticsUserId;

beforeEach(() => {
  session = { user: { id: "cmh-account-1" } };
  rateLimitKeys.length = 0;
  stored.clear();
  events.length = 0;
  deletionOutcome = "submitted";
  process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "true";
});

test("explicit consent with every gate open: the first request creates a random id, later ones return it", async () => {
  const response = await consented();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const first = await idOf(response);
  assert.match(String(first), /^[0-9a-f]{32}$/);
  assert.ok(!String(first).includes("cmh-account-1"));
  assert.equal(stored.get("cmh-account-1")?.analyticsUserId, first, "stored, not derived");

  assert.equal(await idOf(await consented()), first, "stable while consent stands");
  assert.deepEqual(events, ["create:cmh-account-1"], "created once");
  assert.deepEqual(rateLimitKeys, ["analytics-user-id", "analytics-user-id"]);

  session = { user: { id: "cmh-account-2" } };
  const other = await idOf(await consented());
  assert.match(String(other), /^[0-9a-f]{32}$/);
  assert.notEqual(other, first);
});

test("without a statement of explicit consent nothing is created", async () => {
  for (const [label, body] of [
    ["no body", undefined],
    ["empty object", "{}"],
    ["undecided", JSON.stringify({ consent: "unset" })],
    ["declined", JSON.stringify({ consent: "declined" })],
    ["not JSON", "accepted"],
  ] as const) {
    const response = await post(body);
    assert.equal(response.status, 404, label);
    assert.equal(await idOf(response), undefined, label);
  }
  assert.equal(stored.size, 0);
  assert.deepEqual(events, []);
});

test("switch off or unset, or signed out: the same 404, and nothing created", async () => {
  const cases: Array<[string, () => void]> = [
    ["switch off", () => {
      process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "false";
    }],
    ["switch unset", () => {
      delete process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED;
    }],
    ["signed out", () => {
      session = null;
    }],
  ];
  for (const [label, apply] of cases) {
    session = { user: { id: "cmh-account-1" } };
    process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "true";
    apply();
    const response = await consented();
    assert.equal(response.status, 404, label);
    assert.equal(await idOf(response), undefined, label);
  }
  assert.equal(stored.size, 0);
  assert.deepEqual(events, []);
});

test("withdrawal names the stored id to GA4 once, then deletes it; consenting again gets a new id", async () => {
  const first = await idOf(await consented());
  events.length = 0;

  const response = await withdraw();
  assert.equal(response.status, 204);
  assert.deepEqual(events, [
    `ga4:consent_withdrawal:${first}`,
    `delete:cmh-account-1:${first}`,
  ], "the request comes before the deletion, and only once");
  assert.equal(stored.has("cmh-account-1"), false);
  assert.equal(rateLimitKeys.at(-1), "analytics-user-id-withdrawal");

  const second = await idOf(await consented());
  assert.match(String(second), /^[0-9a-f]{32}$/);
  assert.notEqual(second, first, "a new consent is a new id");
});

test("a GA4 request that fails or throws does not keep the id", async () => {
  for (const outcome of ["refused", "throws"] as const) {
    stored.clear();
    events.length = 0;
    const id = await idOf(await consented());
    deletionOutcome = outcome;
    const response = await withdraw();
    assert.equal(response.status, 204, outcome);
    assert.deepEqual(events.slice(1), [
      `ga4:consent_withdrawal:${id}`,
      `delete:cmh-account-1:${id}`,
    ], outcome);
    assert.equal(stored.has("cmh-account-1"), false, outcome);
    deletionOutcome = "submitted";
  }
});

test("nothing stored, nothing asked; and the switch does not gate a withdrawal", async () => {
  assert.equal((await withdraw()).status, 204);
  assert.deepEqual(events, [], "no id, so GA4 is never asked");

  const id = await idOf(await consented());
  process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "false";
  events.length = 0;
  assert.equal((await withdraw()).status, 204);
  assert.deepEqual(events, [
    `ga4:consent_withdrawal:${id}`,
    `delete:cmh-account-1:${id}`,
  ], "an id created while the switch was on is still withdrawn after it is off");
});

test("a signed-out withdrawal touches nothing", async () => {
  await consented();
  events.length = 0;
  session = null;
  const response = await withdraw();
  assert.equal(response.status, 404);
  assert.deepEqual(events, []);
  assert.equal(stored.size, 1);
});
