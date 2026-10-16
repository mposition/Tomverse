import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  AMUX_SESSION_INTAKE_ROUTE,
  amuxSessionIntakeEndpoint,
  prepareAmuxSessionIntakeSubmission,
  readAmuxSessionIntakeClientRequest,
  submitAmuxSessionIntakeClientRequest,
} from "../lib/amux/ideaSessionIntakeClientCore.ts";
import { runAmuxSessionIntakeClient } from "../scripts/amux-session-intake-client.mjs";

const requestId = "34340477-7664-42f4-b3fe-845d10365051";
const ideaId = "8486a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "788e5cd2-4615-46e6-b287-0b84ca217c7c";
const endpoint = `https://tomverse.test${AMUX_SESSION_INTAKE_ROUTE}`;
const secret = "session_intake_only_012345678901234567890123";
const clientInput = {
  version: 1,
  input: {
    version: 1,
    idea: "Queue this idea without exposing it in client output.",
    repositories: ["mposition/Tomverse"],
    pullRequests: [{ repository: "mposition/Tomverse", number: 2607 }],
  },
  source: {
    toolName: "Codex",
    modelProvider: "OpenAI",
    sessionDisplay: "AMUX intake session",
  },
};
const committed = (id = requestId) => ({
  status: "committed",
  requestId: id,
  ideaId,
  reservationId,
  hasExternalSources: true,
  adminPath: `/admin/amux-backlog?tab=ideas&idea=${id}`,
});
const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("the session intake client admits only an HTTPS origin and owns the route path", () => {
  assert.equal(amuxSessionIntakeEndpoint("https://tomverse.test"), endpoint);
  for (const origin of [
    "http://tomverse.test",
    "https://user:password@tomverse.test",
    "https://tomverse.test/other",
    "https://tomverse.test?next=https://attacker.test",
  ]) assert.throws(() => amuxSessionIntakeEndpoint(origin), /origin_invalid/);
});

test("the transport core also refuses an unsafe endpoint or malformed bearer", async () => {
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  await assert.rejects(submitAmuxSessionIntakeClientRequest({
    endpoint: "http://tomverse.test/api/internal/amux/ideas/session-intake",
    secret,
    inspected,
    fetcher: async () => { throw new Error("must not run"); },
  }), /origin_invalid/);
  await assert.rejects(readAmuxSessionIntakeClientRequest({
    endpoint,
    secret: "short",
    requestId,
    fetcher: async () => { throw new Error("must not run"); },
  }), /credential_unavailable/);
});

test("the client generates and validates its request ID before dispatch", () => {
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  assert.equal(inspected.requestId, requestId);
  assert.deepEqual(inspected.input, clientInput.input);
  assert.throws(() => prepareAmuxSessionIntakeSubmission(clientInput, () => "predictable"),
    /schema_rejected/);
  assert.throws(() => prepareAmuxSessionIntakeSubmission({ ...clientInput, extra: true },
    () => requestId), /schema_rejected/);
  assert.throws(() => prepareAmuxSessionIntakeSubmission({ ...clientInput, requestId },
    () => requestId), /schema_rejected/);
});

test("a confirmed POST returns only closed metadata and sends the bearer once", async () => {
  const calls = [];
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  const result = await submitAmuxSessionIntakeClientRequest({
    endpoint,
    secret,
    inspected,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return response(201, { ...committed(), rawIdea: clientInput.input.idea,
        source: clientInput.source, credential: secret });
    },
  });
  assert.deepEqual(result, { state: "committed", requestId, ideaId, reservationId,
    hasExternalSources: true, adminPath: committed().adminPath,
    recoveredByReadback: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${secret}`);
  assert.equal(JSON.parse(calls[0].init.body).requestId, requestId);
  assert.equal(JSON.stringify(result).includes(clientInput.input.idea), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a lost POST reply performs one exact-ID GET and never repeats the write", async () => {
  const methods = [];
  const urls = [];
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  const result = await submitAmuxSessionIntakeClientRequest({
    endpoint,
    secret,
    inspected,
    fetcher: async (url, init) => {
      methods.push(init.method);
      urls.push(url);
      if (init.method === "POST") throw new Error("socket closed with private detail");
      return response(200, committed());
    },
  });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(new URL(urls[1]).searchParams.get("requestId"), requestId);
  assert.equal(result.state, "committed");
  assert.equal(result.recoveredByReadback, true);
});

test("absent or partial readback stays outcome_unknown and never authorizes a POST retry", async () => {
  for (const [status, body, observation] of [
    [404, { status: "absent", requestId, retryWrite: false }, "absent"],
    [409, { status: "partial", requestId, ideaId, retryWrite: false }, "partial"],
  ]) {
    const methods = [];
    const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
    const result = await submitAmuxSessionIntakeClientRequest({
      endpoint,
      secret,
      inspected,
      fetcher: async (_url, init) => {
        methods.push(init.method);
        if (init.method === "POST") return response(500, {
          error: "session_intake_submission_failed", requestId, retryWrite: false,
        });
        return response(status, body);
      },
    });
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.equal(result.state, "outcome_unknown");
    assert.equal(result.observation, observation);
    assert.equal(result.retryWrite, false);
  }
});

test("closed pre-write refusals do not invoke readback or reveal the response body", async () => {
  let calls = 0;
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  const result = await submitAmuxSessionIntakeClientRequest({
    endpoint,
    secret,
    inspected,
    fetcher: async () => {
      calls++;
      return response(409, { error: "outside_scope", retryWrite: false,
        privatePath: "C:\\private\\source", rawIdea: clientInput.input.idea });
    },
  });
  assert.deepEqual(result, { state: "refused", requestId, code: "outside_scope",
    httpStatus: 409, retryWrite: false });
  assert.equal(calls, 1);
});

test("an authentication refusal is known to precede the writer", async () => {
  let calls = 0;
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  const result = await submitAmuxSessionIntakeClientRequest({
    endpoint,
    secret,
    inspected,
    fetcher: async () => {
      calls++;
      return response(401, { error: "Unauthorized" });
    },
  });
  assert.deepEqual(result, { state: "refused", requestId, code: "Unauthorized",
    httpStatus: 401, retryWrite: false });
  assert.equal(calls, 1);
});

test("readback rejects mismatched and expanded server replies as unknown", async () => {
  for (const [status, body] of [
    [200, committed("a2e13249-c51b-4256-b77f-44b863d58690")],
    [404, { status: "absent", requestId, retryWrite: true }],
    [503, { error: "private database error", retryWrite: false }],
  ]) {
    const result = await readAmuxSessionIntakeClientRequest({ endpoint, secret, requestId,
      fetcher: async () => response(status, body) });
    assert.deepEqual(result, { state: "outcome_unknown", requestId,
      observation: "invalid_response", retryWrite: false });
  }
});

test("readback reports unavailable and disabled states without widening recovery", async () => {
  const cases = [
    {
      fetcher: async () => { throw new Error("private transport detail"); },
      observation: "unavailable",
    },
    {
      fetcher: async () => response(503, {
        error: "session_intake_readback_unavailable", retryWrite: false,
      }),
      observation: "unavailable",
    },
    {
      fetcher: async () => response(409, {
        available: false, reason: "session_intake_readback_disabled",
      }),
      observation: "disabled",
    },
  ];
  for (const item of cases) {
    assert.deepEqual(await readAmuxSessionIntakeClientRequest({
      endpoint, secret, requestId, fetcher: item.fetcher,
    }), { state: "outcome_unknown", requestId,
      observation: item.observation, retryWrite: false });
  }
});

test("a refusal code on the wrong status is recovered by exact-ID readback", async () => {
  const methods = [];
  const inspected = prepareAmuxSessionIntakeSubmission(clientInput, () => requestId);
  const result = await submitAmuxSessionIntakeClientRequest({
    endpoint,
    secret,
    inspected,
    fetcher: async (_url, init) => {
      methods.push(init.method);
      return init.method === "POST"
        ? response(500, { error: "outside_scope", retryWrite: false })
        : response(404, { status: "absent", requestId, retryWrite: false });
    },
  });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.deepEqual(result, { state: "outcome_unknown", requestId,
    observation: "absent", retryWrite: false });
});

test("the fixed CLI entrypoint prints the request ID before one write and supports readback-only", async () => {
  const prepared = [];
  const methods = [];
  let receiptReleased = false;
  const env = {
    TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET: secret,
    TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN: "https://tomverse.test",
  };
  const result = await runAmuxSessionIntakeClient(["submit"], env, {
    readInput: () => JSON.stringify(clientInput),
    createRequestId: () => requestId,
    onPrepared: async (value) => {
      prepared.push(value);
      await Promise.resolve();
      receiptReleased = true;
    },
    fetcher: async (_url, init) => {
      assert.equal(receiptReleased, true);
      methods.push(init.method);
      return response(201, committed());
    },
  });
  assert.deepEqual(prepared, [{ status: "dispatching", requestId }]);
  assert.equal(result.state, "committed");
  assert.deepEqual(methods, ["POST"]);

  methods.length = 0;
  const read = await runAmuxSessionIntakeClient(
    ["readback", "--request-id", requestId], env,
    { fetcher: async (_url, init) => {
      methods.push(init.method);
      return response(200, committed());
    } },
  );
  assert.equal(read.state, "committed");
  assert.deepEqual(methods, ["GET"]);

  await assert.rejects(runAmuxSessionIntakeClient(
    ["submit", "--request-id", requestId], env,
  ), /command_invalid/);
  await assert.rejects(runAmuxSessionIntakeClient(
    ["readback", "--request-id", requestId, "--request-id", requestId], env,
  ), /command_invalid/);

  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.scripts["local:amux-session-intake"],
    "node --import tsx scripts/amux-session-intake-client.mjs");
});

test("the client keeps the v19 no-cap payload and never logs content or credentials", async () => {
  const large = { ...clientInput, input: { ...clientInput.input,
    idea: "i".repeat(1_048_577) } };
  const prepared = [];
  let body = "";
  const result = await runAmuxSessionIntakeClient(["submit"], {
    TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET: secret,
    TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN: "https://tomverse.test",
  }, {
    readInput: () => JSON.stringify(large),
    createRequestId: () => requestId,
    onPrepared: (value) => prepared.push(value),
    fetcher: async (_url, init) => {
      body = init.body;
      return response(201, committed());
    },
  });
  assert.equal(JSON.parse(body).input.idea.length, 1_048_577);
  assert.deepEqual(prepared, [{ status: "dispatching", requestId }]);
  assert.equal(JSON.stringify(result).includes("i".repeat(100)), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("the CLI closes input read errors without printing a local path", () => {
  const privatePath = "C:\\private\\operator-session\\idea.json";
  const script = resolve(import.meta.dirname, "..", "scripts",
    "amux-session-intake-client.mjs");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", script, "submit", "--input", privatePath,
  ], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET: secret,
      TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN: "https://tomverse.test",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "input_unavailable");
  assert.equal(result.stderr.includes(privatePath), false);
});
