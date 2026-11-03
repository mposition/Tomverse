import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

// The GA4 deletion request made when analytics consent is withdrawn or the
// account is deleted (docs/policy/marketing-automation.md §10.2, §12.2),
// against a fake fetch: never a real call. It names exactly the stored id it
// is given, never the account id; it is one attempt; and a failure is
// reported without the id and never thrown.

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
type Ga4Env = import("../../lib/ga4UserDeletion").Ga4Env;
const load = async () => (await import(mod("lib/ga4UserDeletion.ts"))) as Deletion;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const STORED_ID = "0123456789abcdef0123456789abcdef";
const credentials = (): Ga4Env => ({
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

test("a stored id without deletion credentials is reported, and nothing is called", async () => {
  const deletion = await load();
  const { fn, calls } = fakeFetch([]);
  const outcome = await deletion.requestGa4UserIdDeletion(STORED_ID, "consent_withdrawal", {
    fetch: fn,
    env: {},
    now,
  });
  assert.deepEqual(outcome, { status: "not_configured" });
  assert.equal(calls.length, 0);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].code, "GA4_USER_DELETION_NOT_CONFIGURED");
  assert.equal(incidents[0].context?.trigger, "consent_withdrawal");
  assert.ok(!JSON.stringify(incidents[0]).includes(STORED_ID));
});

test("a value that is not a stored id is never sent", async () => {
  const deletion = await load();
  for (const value of ["cmh-account-id", "someone@example.com", ""]) {
    const { fn, calls } = fakeFetch([]);
    const outcome = await deletion.requestGa4UserIdDeletion(value, "account_deletion", {
      fetch: fn,
      env: credentials(),
      now,
    });
    assert.deepEqual(outcome, { status: "not_configured" }, value);
    assert.equal(calls.length, 0, value);
  }
});

test("a configured deletion names the stored id under the analytics.edit scope", async () => {
  const deletion = await load();
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    json(200, { deletionRequestTime: "2026-11-01T00:00:01Z" }),
  ]);
  const outcome = await deletion.requestGa4UserIdDeletion(STORED_ID, "account_deletion", {
    fetch: fn,
    env: credentials(),
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
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { userId: STORED_ID });
  assert.equal(incidents.length, 0);
});

test("a refusal is one attempt, reported without the id", async () => {
  const deletion = await load();
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    json(403, { error: { status: "PERMISSION_DENIED" } }),
  ]);
  const outcome = await deletion.requestGa4UserIdDeletion(STORED_ID, "consent_withdrawal", {
    fetch: fn,
    env: credentials(),
    now,
  });
  assert.deepEqual(outcome, { status: "refused", stage: "deletion", httpStatus: 403 });
  assert.equal(calls.length, 2, "no retry");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].code, "GA4_USER_DELETION_FAILED");
  assert.equal(incidents[0].context?.trigger, "consent_withdrawal");
  assert.ok(!JSON.stringify(incidents[0]).includes(STORED_ID));
});

test("an unknown outcome is not retried and nothing throws, even if reporting fails", async () => {
  const deletion = await load();
  incidentThrows = true;
  const { fn, calls } = fakeFetch([
    json(200, { access_token: "token-1" }),
    new Error("socket hang up"),
  ]);
  const outcome = await deletion.requestGa4UserIdDeletion(STORED_ID, "account_deletion", {
    fetch: fn,
    env: credentials(),
    now,
  });
  assert.deepEqual(outcome, { status: "unknown", stage: "deletion" });
  assert.equal(calls.length, 2);

  const tokenFailure = fakeFetch([json(401, { error: "invalid_grant" })]);
  assert.deepEqual(
    await deletion.requestGa4UserIdDeletion(STORED_ID, "account_deletion", {
      fetch: tokenFailure.fn,
      env: credentials(),
      now,
    }),
    { status: "refused", stage: "token", httpStatus: 401 }
  );
  assert.equal(tokenFailure.calls.length, 1, "no deletion call without a token");
});
