import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for PATCH /api/user/email-preferences and the marketing
 * country allowlist.
 *
 * Contract: docs/policy/email-eea-marketing-review-2026-09-14.md §7 condition 7.
 *
 * What must hold:
 *   - switching marketing on for a mapped country outside the allowlist (NL)
 *     is refused with COUNTRY_UNSUPPORTED and stores nothing;
 *   - the same refusal holds when the request names an allowlisted country but
 *     the resolution the send lane will use lands outside the list;
 *   - an allowlisted country (DE) reaches the consent write;
 *   - leaving is never blocked by the allowlist: saving the country alone,
 *     switching a purpose off and withdrawing all marketing still succeed for
 *     somebody in NL.
 *
 * The route's zod schema and lib/emailJurisdictionCore.ts are the real ones.
 * The session, the preference store and the jurisdiction reads are replaced.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "email-preferences-country-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type Call = { fn: string; input: Record<string, unknown> };

const world: {
  calls: Call[];
  /** What jurisdictionForUser resolves to, before any countryConfirmation. */
  billingCountry: string | null;
  /** When set, jurisdictionForUser returns exactly this, ignoring the request. */
  forcedResolution: Record<string, unknown> | null;
  jurisdictionReads: number;
} = { calls: [], billingCountry: null, forcedResolution: null, jurisdictionReads: 0 };

let route: { PATCH: (request: Request) => Promise<Response> } | null = null;

const loadRoute = async () => {
  if (route) return route;
  const core = await import(mod("lib/emailJurisdictionCore.ts"));

  mock.module(mod("node_modules/next-auth/next/index.js"), {
    namedExports: { getServerSession: async () => ({ user: { id: "user_1" } }) },
  });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/emailPreferences.ts"), {
    namedExports: {
      readPreferences: async () => [],
      setPreference: async (input: Record<string, unknown>) => {
        world.calls.push({ fn: "setPreference", input });
        return { changed: true, purpose: input.purpose, enabled: input.enabled };
      },
      withdrawAllMarketing: async (input: Record<string, unknown>) => {
        world.calls.push({ fn: "withdrawAllMarketing", input });
        return [];
      },
    },
  });
  mock.module(mod("lib/emailJurisdiction.ts"), {
    namedExports: {
      jurisdictionForUser: async (input: {
        countryConfirmation?: { country: string; confirmedAt: Date };
      }) => {
        world.jurisdictionReads += 1;
        if (world.forcedResolution) return world.forcedResolution;
        const resolved = core.resolveEmailJurisdiction({
          billingCountry: world.billingCountry,
          billingCountryUpdatedAt: world.billingCountry
            ? new Date(Date.now() + 60_000)
            : null,
          selfDeclaredCountry: input.countryConfirmation?.country ?? null,
          selfDeclaredCountryUpdatedAt: input.countryConfirmation?.confirmedAt ?? null,
        });
        return {
          ...resolved,
          selfDeclaredCountry: input.countryConfirmation?.country ?? null,
        };
      },
      setSelfDeclaredCountry: async (input: Record<string, unknown>) => {
        world.calls.push({ fn: "setSelfDeclaredCountry", input });
        return { updated: true };
      },
    },
  });

  route = (await import(mod("app/api/user/email-preferences/route.ts"))) as {
    PATCH: (request: Request) => Promise<Response>;
  };
  return route;
};

const patch = async (body: Record<string, unknown>) => {
  const { PATCH } = await loadRoute();
  return PATCH(
    new Request("http://127.0.0.1:3100/api/user/email-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

const reset = () => {
  world.calls = [];
  world.billingCountry = null;
  world.forcedResolution = null;
  world.jurisdictionReads = 0;
};

test("marketing opt-in from a mapped country outside the allowlist is refused at the request boundary", async () => {
  reset();
  const response = await patch({ purpose: "product_updates", enabled: true, country: "NL" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "COUNTRY_UNSUPPORTED");
  assert.deepEqual(world.calls, []);
  // Refused by the request-country guard itself, before any resolution is
  // read -- so removing that guard fails this test even if the later verdict
  // would also have refused.
  assert.equal(world.jurisdictionReads, 0);
});

test("a confirmed resolution outside the allowlist is refused as unsupported", async () => {
  reset();
  // The request's country passes the first guard; the resolution the lane will
  // use is a confirmed NL. This drives the verdict's own
  // marketing_country_not_allowed branch in the route.
  world.forcedResolution = {
    countryCode: "NL",
    profileKey: "EU",
    confidence: "high",
    source: "billing",
    conflicts: [],
    observedIpCountry: null,
    selfDeclaredCountry: "DE",
  };
  const response = await patch({ purpose: "product_updates", enabled: true, country: "DE" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "COUNTRY_UNSUPPORTED");
  assert.equal(world.jurisdictionReads, 1);
  assert.deepEqual(world.calls, []);
});

test("a conflicting resolution is refused as a conflict", async () => {
  reset();
  // A billing signal from NL stamped after the request's DE confirmation leaves
  // the two in conflict, so the lane would hold the message.
  world.billingCountry = "NL";
  const response = await patch({ purpose: "product_updates", enabled: true, country: "DE" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "COUNTRY_CONFLICT");
  assert.deepEqual(world.calls, []);
});

test("an allowlisted country reaches the consent write", async () => {
  reset();
  const response = await patch({ purpose: "product_updates", enabled: true, country: "DE" });
  assert.equal(response.status, 200);
  const write = world.calls.find((call) => call.fn === "setPreference");
  assert.ok(write, "the consent write was not reached");
  assert.equal(write.input.confirmedCountry, "DE");
});

test("somebody in NL can still save a country, switch off, and withdraw everything", async () => {
  reset();
  assert.equal((await patch({ country: "NL" })).status, 200);
  assert.equal((await patch({ purpose: "product_updates", enabled: false })).status, 200);
  assert.equal((await patch({ withdrawAllMarketing: true })).status, 200);
  assert.deepEqual(
    world.calls.map((call) => call.fn),
    ["setSelfDeclaredCountry", "setPreference", "withdrawAllMarketing"]
  );
  assert.equal(world.calls[1].input.enabled, false);
});
