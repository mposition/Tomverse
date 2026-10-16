import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

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
  "TOMVERSE_AMUX_SESSION_INTAKE",
  "TOMVERSE_AMUX_SESSION_INTAKE_READBACK",
  "TOMVERSE_AMUX_V4_IDEA_SUBMIT",
  "TOMVERSE_AMUX_V4_IDEA_READBACK",
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
      operatingScopeSettingId: "synthetic-scope" };
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
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SESSION_INTAKE;
  delete process.env.TOMVERSE_AMUX_V4_IDEA_SUBMIT;
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK = "enabled";
  process.env.TOMVERSE_AMUX_V4_IDEA_READBACK = "enabled";
  for (const name of conflictingEnvNames) {
    delete process.env[name];
  }
};
const enableWrite = () => {
  process.env.TOMVERSE_AMUX_SESSION_INTAKE = "enabled";
  process.env.TOMVERSE_AMUX_V4_IDEA_SUBMIT = "enabled";
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
  enableWrite();
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

test("session POST requires both default-off write and readback switch pairs", async () => {
  reset();
  assert.deepEqual(await (await route.POST(post())).json(), {
    error: "submission_disabled", retryWrite: false,
  });
  process.env.TOMVERSE_AMUX_SESSION_INTAKE = "enabled";
  assert.equal((await route.POST(post())).status, 503);
  delete process.env.TOMVERSE_AMUX_SESSION_INTAKE;
  process.env.TOMVERSE_AMUX_V4_IDEA_SUBMIT = "enabled";
  assert.equal((await route.POST(post())).status, 503);
  enableWrite();
  delete process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK;
  assert.equal((await route.POST(post())).status, 503);
  process.env.TOMVERSE_AMUX_SESSION_INTAKE_READBACK = "enabled";
  delete process.env.TOMVERSE_AMUX_V4_IDEA_READBACK;
  assert.equal((await route.POST(post())).status, 503);
  assert.equal(writes, 0);
});

test("session POST validates its media type and sensitive content before the writer", async () => {
  reset();
  enableWrite();
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
  enableWrite();
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
  enableWrite();
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
    ["submission_disabled", 503], ["audit_unavailable", 503],
    ["scope_unavailable", 409], ["outside_scope", 409],
    ["model_not_approved", 409], ["key_store_unavailable", 503],
  ] as const) {
    reset();
    enableWrite();
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
    enableWrite();
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
  enableWrite();
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
  enableWrite();
  committedRequestId = "a2e13249-c51b-4256-b77f-44b863d58690";
  const mismatched = await route.POST(post());
  assert.equal(mismatched.status, 500);
  assert.deepEqual(await mismatched.json(), {
    error: "session_intake_submission_failed", retryWrite: false, requestId,
    readbackPath: `/api/internal/amux/ideas/session-intake?requestId=${requestId}`,
  });
});
