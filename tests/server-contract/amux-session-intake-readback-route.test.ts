import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

import { amuxSessionPlanFixture } from "../fixtures/amuxSessionPlan.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const requestId = "34340477-7664-42f4-b3fe-845d10365051";
const ideaId = "8486a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "788e5cd2-4615-46e6-b287-0b84ca217c7c";
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
  ...conflictingEnvNames,
] as const;
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let reads = 0;
let readError = false;
let readback: Record<string, unknown> = { requestId, status: "absent" };
let writes = 0;
let writeError: Error | null = null;
let written: unknown;
let committedRequestId = requestId;
let committedPlan: Record<string, unknown> | undefined;

class FakeAmuxIdeaSessionSubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly readBack?: "committed" | "partial" | "unavailable",
    readonly ideaId?: string,
  ) {
    super(code);
  }
}

mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: {
  AmuxIdeaSessionSubmissionError: FakeAmuxIdeaSessionSubmissionError,
  readAmuxIdeaSessionSubmissionRequest: async (received: string) => {
    reads++;
    assert.equal(received, requestId);
    if (readError) throw new Error("synthetic read failure with private detail");
    return readback;
  },
  submitAmuxIdeaFromSession: async (input: unknown) => {
    writes++;
    written = input;
    if (writeError) throw writeError;
    return { requestId: committedRequestId, ideaId, reservationId,
      auditId: "synthetic-submission-audit", reservationAuditId: "synthetic-reservation-audit",
      operatingScopeSettingId: "synthetic-scope",
      ...(committedPlan ? { plan: committedPlan } : {}) };
  },
} });

// Owner decision 2026-11-22: a plan that names an existing node is checked
// against the existing hierarchy, read once before the inspection.
const EXISTING_FEATURE = "7b2e1f30-6d8c-4e5f-a041-3c4d5e6f7081";
let hierarchyReads = 0;
let hierarchyError = false;
mock.module(mod("lib/amux/ideaNodeDuplicateScanService.ts"), { namedExports: {
  loadAmuxExistingHierarchyTargets: async () => {
    hierarchyReads++;
    if (hierarchyError) throw new Error("synthetic hierarchy failure");
    return [{ ref: EXISTING_FEATURE, kind: "node", level: "feature", title: "Crawler access policy",
      parentRef: "6a1d0e2f-5c7b-4d4e-9f30-2b3c4d5e6f70", displayPrefix: "CRAWL" }];
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
  writes = 0;
  writeError = null;
  written = undefined;
  committedRequestId = requestId;
  committedPlan = undefined;
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET = secret;
  for (const name of conflictingEnvNames) {
    delete process.env[name];
  }
};
const get = (query = `?requestId=${requestId}`, token = secret,
  headers: Record<string, string> = {}) => new Request(
  `https://tomverse.test/api/internal/amux/ideas/session-intake${query}`,
  { headers: { authorization: `Bearer ${token}`, ...headers } },
);
const submission = {
  version: 1,
  requestId,
  input: {
    version: 1,
    idea: "Queue the session idea without exposing its source text.",
    repositories: ["mposition/Tomverse"],
    pullRequests: [{ repository: "mposition/Tomverse", number: 2602 }],
  },
  source: {
    toolName: "Codex",
    modelProvider: "OpenAI",
    sessionDisplay: "AMUX intake session",
  },
};
const post = (body: BodyInit = JSON.stringify(submission), token = secret,
  contentType = "application/json", headers: Record<string, string> = {}) =>
  new Request("https://tomverse.test/api/internal/amux/ideas/session-intake", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, ...headers },
    body,
  });

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

test("session readback answers an exact request id", async () => {
  reset();
  assert.equal((await route.GET(get())).status, 404);
  assert.equal(reads, 1);
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
  readback = { requestId, status: "committed", ideaId, reservationId,
    hasExternalSources: true,
    rawIdea: "private idea", sourceProvenance: "private session", credential: secret };
  const response = await route.GET(get());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), {
    status: "committed", requestId, ideaId, reservationId, hasExternalSources: true,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`,
  });
  const source = readFileSync(resolve(root,
    "app/api/internal/amux/ideas/session-intake/route.ts"), "utf8");
  assert.doesNotMatch(source, /getServerSession|next-auth|\bcookies\s*\(/);
  assert.equal(typeof route.POST, "function");
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
    ideaId, reservationId, hasExternalSources: false };
  const response = await route.GET(get());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "session_intake_readback_unavailable", retryWrite: false,
  });
});

test("session POST accepts only the intake bearer and never an owner cookie", async () => {
  reset();
  const cookieOnly = post();
  cookieOnly.headers.delete("authorization");
  cookieOnly.headers.set("cookie", "authjs.session-token=synthetic-owner-cookie");
  assert.equal((await route.POST(cookieOnly)).status, 401);
  assert.equal((await route.POST(post(JSON.stringify(submission),
    "wrong_credential_value_0123456789"))).status, 401);
  process.env.FUTURE_INTERNAL_CAPABILITY_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  assert.equal(writes, 0);
});

test("session POST validates its media type and sensitive content before the writer", async () => {
  reset();
  assert.equal((await route.POST(post(JSON.stringify(submission), secret,
    "text/plain"))).status, 415);
  assert.equal((await route.POST(post("{", secret))).status, 400);
  assert.equal((await route.POST(post(JSON.stringify({ ...submission,
    input: { ...submission.input, idea: "token=secret_value_0123456789" },
  })))).status, 400);
  assert.equal(writes, 0);
});

test("session POST keeps v19 idea intake free of the former one-MiB ceiling", async () => {
  reset();
  const idea = "i".repeat(1_048_577);
  const response = await route.POST(post(JSON.stringify({
    ...submission,
    input: { ...submission.input, idea },
  })));
  assert.equal(response.status, 201);
  assert.equal(writes, 1);
  const inspection = written as { inspected: {
    counts: { ideaBytes: number }; input: { idea: string } } };
  assert.equal(inspection.inspected.counts.ideaBytes, idea.length);
  assert.equal(inspection.inspected.input.idea.length, idea.length);
  assert.doesNotMatch(await response.text(), /i{100}/);
});

test("session POST returns only committed metadata from the atomic service", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    status: "committed", requestId, ideaId, reservationId,
    hasExternalSources: true,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`,
  });
  assert.doesNotMatch(responseText, /Queue the session|toolName|modelProvider|sessionDisplay|credential/);
  assert.equal(writes, 1);
  assert.deepEqual(written, { inspected: {
    ok: true,
    requestId,
    input: submission.input,
    source: submission.source,
    counts: { ideaBytes: 56, repositoryCount: 1, pullRequestCount: 1 },
  } });
});

test("session POST exposes closed refusal codes and sends ambiguous writes to exact readback", async () => {
  for (const [code, status] of [
    ["audit_unavailable", 503],
    ["scope_unavailable", 409], ["outside_scope", 409],
    ["model_not_approved", 409], ["key_store_unavailable", 503],
  ] as const) {
    reset();
    writeError = new FakeAmuxIdeaSessionSubmissionError(code, "committed", ideaId);
    const response = await route.POST(post());
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), {
      error: code, retryWrite: false, requestId,
      readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}`,
    }, code);
  }

  for (const [code, status, readBack] of [
    ["request_already_seen", 409, "committed"],
    ["request_already_seen", 409, "partial"],
    ["outcome_unknown", 503, "unavailable"],
  ] as const) {
    reset();
    writeError = new FakeAmuxIdeaSessionSubmissionError(code, readBack, ideaId);
    const response = await route.POST(post());
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), {
      error: code, retryWrite: false, requestId,
      readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}`,
      readBack, ideaId,
    }, code);
  }
});

test("session POST hides unexpected writer failures and forbids blind retry", async () => {
  reset();
  writeError = new Error("synthetic failure contains private idea and source labels");
  const response = await route.POST(post());
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error: "session_intake_submission_failed", retryWrite: false, requestId,
    readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}`,
  });
  assert.doesNotMatch(body, /synthetic|private idea|source labels/);

  reset();
  committedRequestId = "a2e13249-c51b-4256-b77f-44b863d58690";
  const mismatched = await route.POST(post());
  assert.equal(mismatched.status, 500);
  assert.deepEqual(await mismatched.json(), {
    error: "session_intake_submission_failed", retryWrite: false, requestId,
    readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}`,
  });
});

test("session POST with an attached plan hands the checked plan to the writer and names its state", async () => {
  reset();
  committedPlan = { auditId: "synthetic-plan-audit", planId: "synthetic-plan", unitCount: 4,
    registration: { state: "awaiting_approval" } };
  const plan = amuxSessionPlanFixture();
  const response = await route.POST(post(JSON.stringify({ ...submission, plan })));
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), {
    status: "committed", requestId, ideaId, reservationId, hasExternalSources: true,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`,
    plan: { state: "awaiting_approval", unitCount: 4 },
  });
  // Neither the plan text nor its audit or plan ids leave in the reply.
  assert.doesNotMatch(text, /toggle|synthetic-plan|c0:card/);
  assert.equal(writes, 1);
  const inspected = (written as { inspected: { plan?: { raw: string; unitCount: number } } }).inspected;
  // A plan of new nodes only needs no hierarchy read.
  assert.deepEqual(inspected.plan, { raw: JSON.stringify(plan), unitCount: 4, existingNodes: [] });
  assert.equal(hierarchyReads, 0);

  reset();
  committedPlan = { auditId: "a", planId: "p", unitCount: 4,
    registration: { state: "registration_incomplete", code: "halted" } };
  const refused = await route.POST(post(JSON.stringify({ ...submission, plan })));
  assert.deepEqual((await refused.json()).plan,
    { state: "registration_incomplete", code: "halted", unitCount: 4 });
});

test("session POST refuses a malformed or sensitive plan before the writer", async () => {
  for (const [plan, error] of [
    [amuxSessionPlanFixture({ coverageStatus: "more", remainingScope: "More cards." }), "plan_rejected"],
    [amuxSessionPlanFixture({ units: [] }), "plan_rejected"],
    ["not a plan", "plan_rejected"],
    [amuxSessionPlanFixture({ coveredScope: "Use token=abcdefghijkl here." }), "content_refused"],
  ] as const) {
    reset();
    const response = await route.POST(post(JSON.stringify({ ...submission, plan })));
    assert.equal(response.status, 400, error);
    assert.deepEqual(await response.json(), { error, retryWrite: false });
    assert.equal(writes, 0, error);
  }
});

test("a plan attached to an existing node is checked against the hierarchy, and an unreadable one stops", async () => {
  const fixture = amuxSessionPlanFixture();
  const plan = { ...fixture, units: [{ ...fixture.units[3], featureRef: EXISTING_FEATURE }] };
  reset();
  hierarchyReads = 0;
  committedPlan = { auditId: "a", planId: "p", unitCount: 1, registration: { state: "awaiting_approval" } };
  const response = await route.POST(post(JSON.stringify({ ...submission, plan })));
  assert.equal(response.status, 201);
  assert.equal(hierarchyReads, 1);
  const inspected = (written as { inspected: { plan?: { existingNodes: unknown[] } } }).inspected;
  assert.equal(inspected.plan?.existingNodes.length, 1);
  // A node the hierarchy does not hold is refused before the writer.
  reset();
  const unknown = { ...fixture, units: [{ ...fixture.units[3],
    featureRef: "9d403152-8f0e-4071-8263-5e6f708192a3" }] };
  const refusedUnknown = await route.POST(post(JSON.stringify({ ...submission, plan: unknown })));
  assert.equal(refusedUnknown.status, 400);
  assert.deepEqual(await refusedUnknown.json(), { error: "plan_rejected", retryWrite: false });
  assert.equal(writes, 0);
  // A hierarchy that cannot be read writes nothing and says so.
  reset();
  hierarchyError = true;
  try {
    const unavailable = await route.POST(post(JSON.stringify({ ...submission, plan })));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "hierarchy_unavailable", retryWrite: false });
    assert.equal(writes, 0);
  } finally { hierarchyError = false; }
});

test("a plan the writer refuses inside its transaction is a closed refusal, nothing written", async () => {
  reset();
  writeError = new FakeAmuxIdeaSessionSubmissionError("plan_rejected");
  const response = await route.POST(post(JSON.stringify({ ...submission, plan: amuxSessionPlanFixture() })));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "plan_rejected", retryWrite: false, requestId,
    readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}` });
});
