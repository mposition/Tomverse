import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

// The GA4 User-ID route (marketing policy §10.2) with the notice treated as
// published, so the remaining server gates can be exercised one at a time.
// That the shipped notice flag keeps the route closed is covered in
// tests/ga4UserIdConsentGate.test.mjs.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

let session: { user: { id: string } } | null = null;
let rateLimited = 0;

mock.module(mod("node_modules/next-auth/next/index.js"), {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    consumeApiRateLimit: async () => {
      rateLimited += 1;
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

const POST = async () => {
  const route = (await import(mod("app/api/analytics/user-id/route.ts"))) as {
    POST: (request: Request) => Promise<Response>;
  };
  return route.POST(
    new Request("https://tomverse.app/api/analytics/user-id", { method: "POST" })
  );
};

const KEY = "k".repeat(48);

beforeEach(() => {
  session = { user: { id: "cmh-account-1" } };
  rateLimited = 0;
  process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "true";
  process.env.GA4_USER_ID_KEY = KEY;
});

test("with every server gate open, a signed-in account gets its pseudonymous id, uncached", async () => {
  const response = await POST();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const body = (await response.json()) as { analyticsUserId: string };
  assert.match(body.analyticsUserId, /^[0-9a-f]{32}$/);
  assert.ok(!body.analyticsUserId.includes("cmh-account-1"));
  assert.equal(rateLimited, 1);

  session = { user: { id: "cmh-account-2" } };
  const other = (await (await POST()).json()) as { analyticsUserId: string };
  assert.notEqual(other.analyticsUserId, body.analyticsUserId);
});

test("switch off, key missing or no session: the same 404 and no id", async () => {
  const cases: Array<[string, () => void]> = [
    ["switch off", () => {
      process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "false";
    }],
    ["switch unset", () => {
      delete process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED;
    }],
    ["key missing", () => {
      delete process.env.GA4_USER_ID_KEY;
    }],
    ["signed out", () => {
      session = null;
    }],
  ];
  for (const [label, apply] of cases) {
    session = { user: { id: "cmh-account-1" } };
    process.env.NEXT_PUBLIC_GA4_USER_ID_ENABLED = "true";
    process.env.GA4_USER_ID_KEY = KEY;
    apply();
    const response = await POST();
    assert.equal(response.status, 404, label);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.analyticsUserId, undefined, label);
  }
});
