import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

// The GA4 deletion request an account deletion makes (marketing policy §10.2,
// §12.2), against a fake fetch: never a real call. It names the same
// pseudonymous id the browser was given, never the account id; it is one
// attempt; and a failure is reported without the id and never thrown.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

type Incident = { code: string; error?: unknown; context?: Record<string, unknown> };
const incidents: Incident[] = [];
let incidentThrows = false;

mock.module(mod("lib/operationalMonitoring.ts"), {
  namedExports: {
    reportOperationalIncident: async (incident: Incident) => {
      incidents.push(incident);
      if (incidentThrows) throw new Error("monitoring down");
    },
  },
});

type Deletion = typeof import("../../lib/ga4UserDeletion");
type Derivation = typeof import("../../lib/ga4UserId");
type Ga4Env = import("../../lib/ga4UserId").Ga4Env;
const load = async () => ({
  deletion: (await import(mod("lib/ga4UserDeletion.ts"))) as Deletion,
  derivation: (await import(mod("lib/ga4UserId.ts"))) as Derivation,
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = "k".repeat(48);
const ACCOUNT = "cmh-deleted-account";
const configuredEnv = (): Ga4Env => ({
  GA4_USER_ID_KEY: KEY,
  GA4_PROPERTY_ID: "123456789",
  GA4_USER_DELETION_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "deleter@tomverse-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }),
});

type Call = { url: string; init: RequestInit };
const fakeFetch = (responses: Array<Response | Error>) => {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const now = () => new Date("2026-11-01T00:00:00.000Z");

beforeEach(() => {
  incidents.length = 0;
  incidentThrows = false;
});

test("no derivation key means no User-ID was ever sent: nothing to ask, nothing reported", async () => {
  const { deletion } = await load();
  const { fn, calls } = fakeFetch([]);
  const outcome = await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
    fetch: fn,
    env: {},
    now,
  });
  assert.deepEqual(outcome, { status: "not_configured" });
  assert.equal(calls.length, 0);
  assert.equal(incidents.length, 0);
});

test("a key without deletion credentials is reported, and nothing is called", async () => {
  const { deletion } = await load();
  const { fn, calls } = fakeFetch([]);
  const outcome = await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
    fetch: fn,
    env: { GA4_USER_ID_KEY: KEY },
    now,
  });
  assert.deepEqual(outcome, { status: "not_configured" });
  assert.equal(calls.length, 0);
  assert.equal(incidents[0]?.code, "GA4_USER_DELETION_NOT_CONFIGURED");
});

test("a configured deletion names the pseudonymous id under the analytics.edit scope", async () => {
  const { deletion, derivation } = await load();
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    json(200, { deletionRequestTime: "2026-11-01T00:00:01Z" }),
  ]);
  const outcome = await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
    fetch: fn,
    env: configuredEnv(),
    now,
  });
  assert.deepEqual(outcome, {
    status: "submitted",
    deletionRequestTime: "2026-11-01T00:00:01Z",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion") || "";
  const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.scope, "https://www.googleapis.com/auth/analytics.edit");
  assert.equal(claims.iss, "deleter@tomverse-test.iam.gserviceaccount.com");

  assert.equal(
    calls[1].url,
    "https://analyticsadmin.googleapis.com/v1alpha/properties/123456789:submitUserDeletion"
  );
  assert.equal(
    (calls[1].init.headers as Record<string, string>).Authorization,
    "Bearer token-1"
  );
  const body = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(body, { userId: derivation.analyticsUserIdFor(ACCOUNT, KEY) });
  assert.ok(!String(calls[1].init.body).includes(ACCOUNT), "the account id never leaves");
  assert.equal(incidents.length, 0);
});

test("a refusal is one attempt, reported without the id", async () => {
  const { deletion, derivation } = await load();
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    json(403, { error: { status: "PERMISSION_DENIED" } }),
  ]);
  const outcome = await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
    fetch: fn,
    env: configuredEnv(),
    now,
  });
  assert.deepEqual(outcome, { status: "refused", stage: "deletion", httpStatus: 403 });
  assert.equal(calls.length, 2, "no retry");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].code, "GA4_USER_DELETION_FAILED");
  const reported = JSON.stringify(incidents[0]);
  assert.ok(!reported.includes(String(derivation.analyticsUserIdFor(ACCOUNT, KEY))));
  assert.ok(!reported.includes(ACCOUNT));
});

test("an unknown outcome is not retried and nothing throws, even if reporting fails", async () => {
  const { deletion } = await load();
  incidentThrows = true;
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    new Error("socket hang up"),
  ]);
  const outcome = await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
    fetch: fn,
    env: configuredEnv(),
    now,
  });
  assert.deepEqual(outcome, { status: "unknown", stage: "deletion" });
  assert.equal(calls.length, 2);

  const tokenFailure = fakeFetch([json(401, { error: "invalid_grant" })]);
  assert.deepEqual(
    await deletion.requestGa4UserDeletionForAccount(ACCOUNT, {
      fetch: tokenFailure.fn,
      env: configuredEnv(),
      now,
    }),
    { status: "refused", stage: "token", httpStatus: 401 }
  );
  assert.equal(tokenFailure.calls.length, 1, "no deletion call without a token");
});
