import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const requestId = "34340477-7664-42f4-b3fe-845d10365051";
const ideaId = "8486a25b-919f-4714-a3d8-45ef5a18b175";
const secret = "session_intake_only_012345678901234567890123";
const conflictingEnvNames = [
  "ROUTING_FAULT_INJECTION_SECRET",
  "CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET",
  "ZERNIO_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "MOBILE_AUTH_SIGNING_KEYS",
  "OPENAI_API_KEY",
  "FUTURE_INTERNAL_CAPABILITY_SECRET",
  "FUTURE_PROVIDER_API_KEY",
  "FUTURE_WORKER_TOKEN",
  "FUTURE_KEYRING",
] as const;
const envNames = [
  "TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET",
  "TOMVERSE_AMUX_SESSION_INTAKE",
  "TOMVERSE_AMUX_SESSION_INTAKE_READBACK",
  "TOMVERSE_AMUX_V4_IDEA_READBACK",
  ...conflictingEnvNames,
] as const;
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let reads = 0;
let readError = false;
let readback: Record<string, unknown> = { requestId, status: "absent" };

mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: {
  readAmuxIdeaSessionSubmissionRequest: async (received: string) => {
    reads++;
    assert.equal(received, requestId);
    if (readError) throw new Error("synthetic read failure with private detail");
    return readback;
  },
} });

let route: typeof import("../../app/api/internal/amux/ideas/session-intake/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/ideas/session-intake/route.ts")); });
after(() => {
  for (const name of envNames) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const reset = () => {
  reads = 0;
  readError = false;
  readback = { requestId, status: "absent" };
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SESSION_INTAKE;
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK = "enabled";
  process.env.TOMVERSE_AMUX_V4_IDEA_READBACK = "enabled";
  for (const name of conflictingEnvNames) {
    delete process.env[name];
  }
};
const get = (query = `?requestId=${requestId}`, token = secret,
  headers: Record<string, string> = {}) => new Request(
  `https://tomverse.test/api/internal/amux/ideas/session-intake${query}`,
  { headers: { authorization: `Bearer ${token}`, ...headers } },
);

test("session readback accepts only its bearer and never falls back to an owner cookie", async () => {
  reset();
  const cookieOnly = new Request(get().url, {
    headers: { cookie: "authjs.session-token=synthetic-owner-cookie" },
  });
  assert.equal((await route.GET(cookieOnly)).status, 401);
  assert.equal((await route.GET(get("", "wrong_credential_value_0123456789"))).status, 401);
  for (const name of conflictingEnvNames) {
    reset();
    process.env[name] = secret;
    assert.equal((await route.GET(get())).status, 401, name);
  }
  assert.equal(reads, 0);
});

test("session readback stays available after intake stops and requires both read switches", async () => {
  reset();
  assert.equal(process.env.TOMVERSE_AMUX_SESSION_INTAKE, undefined);
  assert.equal((await route.GET(get())).status, 404);
  assert.equal(reads, 1);

  reset();
  delete process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK;
  const sessionOff = await route.GET(get());
  assert.equal(sessionOff.status, 409);
  assert.deepEqual(await sessionOff.json(), {
    available: false, reason: "session_intake_readback_disabled",
  });
  reset();
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK = "ENABLED";
  assert.equal((await route.GET(get())).status, 409);
  assert.equal(reads, 0);

  reset();
  delete process.env.TOMVERSE_AMUX_V4_IDEA_READBACK;
  assert.equal((await route.GET(get())).status, 409);
  assert.equal(reads, 0);
});

test("session readback rejects malformed or expanded lookups before the database", async () => {
  for (const query of ["", "?requestId=not-an-id",
    `?requestId=${requestId}&requestId=${requestId}`,
    `?requestId=${requestId}&other=value`]) {
    reset();
    assert.equal((await route.GET(get(query))).status, 400);
    assert.equal(reads, 0);
  }
});

test("session readback returns committed metadata without content or credential fields", async () => {
  reset();
  readback = { requestId, status: "committed", ideaId, hasExternalSources: true,
    rawIdea: "private idea", sourceProvenance: "private session", credential: secret };
  const response = await route.GET(get());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), {
    status: "committed", requestId, ideaId, hasExternalSources: true,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`,
  });
  const source = readFileSync(resolve(root,
    "app/api/internal/amux/ideas/session-intake/route.ts"), "utf8");
  assert.doesNotMatch(source, /\bsubmitAmuxIdeaFromSession\b/);
  assert.equal("POST" in route, false);
  assert.equal(reads, 1);
});

test("session readback distinguishes absent and partial without suggesting a retry", async () => {
  reset();
  let response = await route.GET(get());
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "absent", requestId, retryWrite: false });
  readback = { requestId, status: "partial", ideaId };
  response = await route.GET(get());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    status: "partial", requestId, ideaId, retryWrite: false,
  });
});

test("session readback reports an unavailable read without leaking its failure", async () => {
  reset();
  readError = true;
  const response = await route.GET(get());
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error: "session_intake_readback_unavailable", retryWrite: false,
  });
  assert.doesNotMatch(body, /synthetic|private detail/);
});

test("session readback refuses a service result for a different request ID", async () => {
  reset();
  readback = { requestId: "a2e13249-c51b-4256-b77f-44b863d58690", status: "committed",
    ideaId, hasExternalSources: false };
  const response = await route.GET(get());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "session_intake_readback_unavailable", retryWrite: false,
  });
});
