import assert from "node:assert/strict";
import test from "node:test";
import { observeDeployment } from "../lib/feedbackAutoFixDeploymentProbe";

/**
 * The deployment probe's reading of real responses (independent review round
 * 2, N1). What must hold:
 *   - a cached readiness 200 (Age > 0) is a failed sample, exactly like a
 *     cached build-info;
 *   - a redirect (an Access login page) is a failed sample;
 *   - every sample request is uncached and unique, and goes only to the fixed
 *     environment origin;
 *   - the control plane's deployments are read with their commit from `meta`,
 *     and a GraphQL error is "unavailable", not an empty list.
 */

const SHA = "a".repeat(40);
const ENV: Record<string, string> = {
  RAILWAY_API_TOKEN: "railway-token",
  RAILWAY_PROJECT_ID: "project",
  FEEDBACK_AUTOFIX_RAILWAY_SERVICE_ID: "service",
  FEEDBACK_AUTOFIX_STAGING_RAILWAY_ENVIRONMENT_ID: "staging-env",
  FEEDBACK_AUTOFIX_PRODUCTION_RAILWAY_ENVIRONMENT_ID: "production-env",
  PRODUCTION_APP_URL: "https://tomverse.app",
};

const withEnv = async (run: () => Promise<void>) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

const fakeFetch = (answers: {
  railway: Answer;
  buildInfo: (index: number) => Answer;
  ready: (index: number) => Answer;
}) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let buildInfoCalls = 0;
  let readyCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    const answer = url.startsWith("https://backboard.railway.com/")
      ? answers.railway
      : url.includes("/api/build-info")
        ? answers.buildInfo(buildInfoCalls++)
        : answers.ready(readyCalls++);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
};

const railwayOk: Answer = {
  status: 200,
  body: {
    data: {
      deployments: {
        edges: [
          { node: { id: "dep-new", status: "SUCCESS", meta: { commitHash: SHA.toUpperCase() } } },
          { node: { id: "dep-old", status: "REMOVED", meta: {} } },
        ],
      },
    },
  },
};
const buildInfoOk: Answer = {
  status: 200,
  body: { commitSha: SHA, deploymentId: "dep-new", deploymentStatus: "success" },
};

test("a cached readiness 200 is a failed sample, like a cached build-info", async () => {
  await withEnv(async () => {
    const { fetchImpl } = fakeFetch({
      railway: railwayOk,
      buildInfo: (index) => (index === 1 ? { ...buildInfoOk, headers: { Age: "12" } } : buildInfoOk),
      ready: (index) =>
        index === 3 ? { status: 200, body: { ok: true }, headers: { Age: "30" } } : { status: 200, body: { ok: true } },
    });
    const observation = await observeDeployment("production", fetchImpl);
    assert.deepEqual(observation.ready, [true, true, true, false, true]);
    assert.equal(observation.buildInfo[1], null);
    assert.deepEqual(observation.buildInfo[0], {
      commitSha: SHA,
      deploymentId: "dep-new",
      deploymentStatus: "success",
    });
  });
});

test("a redirect is a failed sample and staging takes no readiness samples", async () => {
  await withEnv(async () => {
    const { fetchImpl, requests } = fakeFetch({
      railway: railwayOk,
      buildInfo: () => ({ status: 302, headers: { Location: "https://access.example/login" } }),
      ready: () => ({ status: 200 }),
    });
    const observation = await observeDeployment("staging", fetchImpl);
    assert.deepEqual(observation.buildInfo, [null, null, null, null, null]);
    assert.deepEqual(observation.ready, []);
    const samples = requests.filter((request) => !request.url.startsWith("https://backboard"));
    assert.equal(samples.length, 5);
    const urls = new Set(samples.map((request) => request.url));
    assert.equal(urls.size, 5, "every sample URL is unique");
    for (const request of samples) {
      assert.ok(request.url.startsWith("https://staging.tomverse.app/api/build-info?autofix_probe="));
      assert.equal(request.init?.cache, "no-store");
      assert.equal(request.init?.redirect, "manual");
    }
  });
});

test("the control plane is read with commits from meta; a GraphQL error is unavailable", async () => {
  await withEnv(async () => {
    const ok = fakeFetch({ railway: railwayOk, buildInfo: () => buildInfoOk, ready: () => ({ status: 200 }) });
    const observation = await observeDeployment("staging", ok.fetchImpl);
    assert.deepEqual(observation.controlPlane, [
      { id: "dep-new", status: "SUCCESS", commitSha: SHA },
      { id: "dep-old", status: "REMOVED", commitSha: null },
    ]);
    const railwayRequest = ok.requests.find((request) => request.url.startsWith("https://backboard"));
    const body = JSON.parse(String(railwayRequest?.init?.body)) as {
      variables: { input: Record<string, string> };
    };
    assert.deepEqual(body.variables.input, {
      projectId: "project",
      serviceId: "service",
      environmentId: "staging-env",
    });

    const failing = fakeFetch({
      railway: { status: 200, body: { errors: [{ message: "Not Authorized" }] } },
      buildInfo: () => buildInfoOk,
      ready: () => ({ status: 200 }),
    });
    assert.equal((await observeDeployment("staging", failing.fetchImpl)).controlPlane, null);
  });
});
