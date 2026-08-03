// Contract: the image generation route fails closed with no database and no
// mocks on the gate itself. E2E_DISABLE_DATABASE makes the opt-in flag read
// return false (a missing row and an unreachable database look identical to
// the gate on purpose), so a 403 IMAGE_GENERATION_DISABLED here proves the
// default-off semantics end to end through the real route handler and the
// real service -- before any billing, lease or provider code can run.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
// The database short-circuit only activates on a loopback deployment
// (lib/e2eTestMode.ts) -- without this the flag is ignored by design.
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "image-generations-contract-secret-2026";

let sessionOverride: unknown = null;
let mocksInstalled = false;

async function loadRoute() {
  if (mocksInstalled) {
    return import(mod("app/api/images/generations/route.ts"));
  }
  mocksInstalled = true;
  // Originals must come from require (the CJS cache) -- a dynamic import
  // here would load the real module into the ESM cache first and the
  // route's own import would bypass the mock entirely.
  const realApiSecurity = require(
    resolve(ROOT, "lib/apiSecurity.ts")
  ) as Record<string, unknown>;
  mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => sessionOverride },
  });
  // Rate limiting needs the database; everything else in apiSecurity stays
  // real so readLimitedJson keeps enforcing the strict schema.
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async () => undefined,
    },
  });
  return import(mod("app/api/images/generations/route.ts"));
}

const postRequest = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const validBody = {
  prompt: "sunset over mountains",
  size: "1024x1024",
  quality: "low",
  idempotencyKey: "contract-test-0001",
};

test("no session is rejected before anything else", async () => {
  sessionOverride = null;
  const { POST } = await loadRoute();
  const response = await POST(postRequest(validBody));
  assert.equal(response.status, 401);
});

test("a signed-in request fails closed when the opt-in flag cannot be read", async () => {
  sessionOverride = { user: { id: "user-contract-1" } };
  const { POST } = await loadRoute();
  const response = await POST(postRequest(validBody));
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.code, "IMAGE_GENERATION_DISABLED");
});

test("the strict schema rejects unknown fields and bad options before the gates", async () => {
  sessionOverride = { user: { id: "user-contract-1" } };
  const { POST } = await loadRoute();

  const unknownField = await POST(
    postRequest({ ...validBody, background: "transparent" })
  );
  assert.equal(unknownField.status, 400);

  const badSize = await POST(postRequest({ ...validBody, size: "2048x2048" }));
  assert.equal(badSize.status, 400);

  const badKey = await POST(postRequest({ ...validBody, idempotencyKey: "x" }));
  assert.equal(badKey.status, 400);
});
