import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { prisma } from "../../lib/prisma";
import { ensureModelRegistrySeeded } from "../../lib/modelRegistry";
import {
  getProviderHealthDashboard,
  recordModelFailure,
  recordProviderFailure,
} from "../../lib/providerMonitoring";
import { GET as getPublicModelStatus } from "../../app/api/models/status/route";

// STG-R002: what a recorded failure is evidence *of*, end to end through the
// real counters and the real dashboard.
//
// The staging incident: five HTTP 400 "invalid_message" rejections of
// perplexity/sonar-deep-research were counted as Perplexity provider failures.
// consecutiveFailures hit 5 with lastSuccessAt still null, the provider was
// judged an incident, /api/models/status reported every Perplexity model
// unavailable -- and because consecutiveFailures only resets on a recorded
// success, no request could ever clear it.

const DEEP_RESEARCH_MODEL = "perplexity/sonar-deep-research";
const SONAR_MODEL = "perplexity/sonar";

// A missing API key is its own provider-level blocker (status "outage" ->
// public "incident"), which would mask the failure-scope behaviour under test.
// Set here rather than relied on from the runner environment so these
// scenarios assert what they claim to whether or not a key happens to be
// configured. Nothing in this file makes a network call.
const PLACEHOLDER_API_KEY = "integration-test-key-not-a-real-credential";
const previousPerplexityKey = process.env.PERPLEXITY_API_KEY;
process.env.PERPLEXITY_API_KEY = PLACEHOLDER_API_KEY;

const resetHealthData = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatUsageBucket",
      "ProviderErrorEvent",
      "ProviderHealthState",
      "ProviderHealthCheck"
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(resetHealthData);
after(async () => {
  if (previousPerplexityKey === undefined) delete process.env.PERPLEXITY_API_KEY;
  else process.env.PERPLEXITY_API_KEY = previousPerplexityKey;
  await resetHealthData();
  await prisma.$disconnect();
});

const consecutiveFailuresFor = async (provider: string) =>
  (
    await prisma.providerHealthState.findUnique({
      where: { provider },
      select: { consecutiveFailures: true },
    })
  )?.consecutiveFailures ?? 0;

const recordDeepResearchContractRejection = (index: number) =>
  recordProviderFailure("perplexity", "DEEP_RESEARCH_SUBMIT_FAILED", {
    modelId: DEEP_RESEARCH_MODEL,
    phase: "request",
    traceId: `trace-contract-${index}`,
    errorName: "PerplexityDeepResearchError",
    httpStatus: 400,
    message:
      "Perplexity async submit failed: 400 invalid_message: After the (optional) system message(s), user or tool message(s) should alternate with assistant message(s).",
  });

test("HTTP 400 invalid_message does not increase provider consecutive failures", async () => {
  for (let index = 0; index < 5; index += 1) {
    await recordDeepResearchContractRejection(index);
  }

  assert.equal(await consecutiveFailuresFor("perplexity"), 0);
  // The diagnostic trail is still kept: the rejections must stay investigable,
  // they simply are not provider-health evidence.
  const events = await prisma.providerErrorEvent.count({
    where: { provider: "perplexity" },
  });
  assert.equal(events, 5);
});

test("HTTP 401, 403, 402, 429 and 5xx all still count against the provider", async () => {
  for (const [index, httpStatus] of [401, 403, 402, 429, 503].entries()) {
    await recordProviderFailure("perplexity", "AI_REQUEST_FAILED.AI_APICallError", {
      modelId: SONAR_MODEL,
      phase: "request",
      traceId: `trace-provider-${index}`,
      httpStatus,
    });
  }
  assert.equal(await consecutiveFailuresFor("perplexity"), 5);
});

test("a locally rejected request is not recorded against the provider at all", async () => {
  await recordProviderFailure("perplexity", "CHAT_QUOTA_EXCEEDED", {
    modelId: SONAR_MODEL,
    phase: "request",
    traceId: "trace-local-quota",
    // ChatAccessError carries its own status; a status-first classifier would
    // file Tomverse's own quota rejection as Perplexity rate limiting.
    httpStatus: 429,
  });

  assert.equal(await consecutiveFailuresFor("perplexity"), 0);
  const dayFailures = await prisma.chatUsageBucket.findFirst({
    where: { key: "provider:perplexity:failure", period: "provider-health-day" },
  });
  assert.equal(dayFailures, null);
});

test("one model's request-contract failures leave its sibling models available", async () => {
  await ensureModelRegistrySeeded();
  for (let index = 0; index < 5; index += 1) {
    await recordDeepResearchContractRejection(index);
    await recordModelFailure(
      DEEP_RESEARCH_MODEL,
      "perplexity",
      "DEEP_RESEARCH_SUBMIT_FAILED.HTTP_400"
    );
  }

  const dashboard = await getProviderHealthDashboard();
  const perplexity = dashboard.providers.find(
    (row) => row.provider === "perplexity"
  );
  assert.ok(perplexity);
  assert.notEqual(perplexity.publicStatus, "incident");

  const incident = perplexity.modelIncidents.find(
    (row) => row.modelId === DEEP_RESEARCH_MODEL
  );
  assert.ok(incident, "the deep-research model should still show its own incident");
  assert.equal(incident.scope, "model");

  const response = await getPublicModelStatus(
    new Request("https://tomverse.test/api/models/status")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    models: Array<{
      id: string;
      status: string;
      statusSource: string;
      modelIncident: boolean;
      providerIncident: boolean;
      providerStatus: string;
    }>;
  };

  const deepResearch = body.models.find((row) => row.id === DEEP_RESEARCH_MODEL);
  assert.ok(deepResearch);
  assert.equal(deepResearch.status, "unavailable");
  assert.equal(deepResearch.statusSource, "model");
  assert.equal(deepResearch.modelIncident, true);
  assert.equal(deepResearch.providerIncident, false);

  for (const siblingId of [
    SONAR_MODEL,
    "perplexity/sonar-pro",
    "perplexity/sonar-reasoning-pro",
  ]) {
    const sibling = body.models.find((row) => row.id === siblingId);
    assert.ok(sibling, siblingId);
    assert.notEqual(sibling.status, "unavailable", siblingId);
    assert.equal(sibling.modelIncident, false, siblingId);
  }

  // The public status page, the admin panel and this API all read the same
  // provider verdict, so they cannot disagree about it.
  for (const model of body.models.filter(
    (row) => row.id.startsWith("perplexity/")
  )) {
    assert.equal(model.providerStatus, perplexity.publicStatus, model.id);
  }
});

test("a provider-wide failure does make every model of that provider unavailable", async () => {
  await ensureModelRegistrySeeded();
  for (let index = 0; index < 5; index += 1) {
    await recordProviderFailure("perplexity", "AI_REQUEST_FAILED.AI_APICallError", {
      modelId: SONAR_MODEL,
      phase: "request",
      traceId: `trace-auth-${index}`,
      httpStatus: 401,
    });
  }

  const dashboard = await getProviderHealthDashboard();
  const perplexity = dashboard.providers.find(
    (row) => row.provider === "perplexity"
  );
  assert.ok(perplexity);
  assert.equal(perplexity.publicStatus, "incident");

  const response = await getPublicModelStatus(
    new Request("https://tomverse.test/api/models/status")
  );
  const body = (await response.json()) as {
    models: Array<{ id: string; status: string; providerIncident: boolean }>;
  };
  const perplexityModels = body.models.filter((row) =>
    row.id.startsWith("perplexity/")
  );
  assert.ok(perplexityModels.length >= 4);
  for (const model of perplexityModels) {
    assert.equal(model.status, "unavailable", model.id);
    assert.equal(model.providerIncident, true, model.id);
  }
});

test("38-hour-old failures no longer keep a provider unavailable", async () => {
  await ensureModelRegistrySeeded();
  await prisma.providerHealthState.create({
    data: {
      provider: "perplexity",
      consecutiveFailures: 5,
      lastFailureAt: new Date(Date.now() - 38 * 3_600_000),
      lastSuccessAt: null,
    },
  });

  const dashboard = await getProviderHealthDashboard();
  const perplexity = dashboard.providers.find(
    (row) => row.provider === "perplexity"
  );
  assert.ok(perplexity);
  assert.notEqual(perplexity.publicStatus, "incident");
  assert.equal(perplexity.publicStatusReasonCode, "REAL_FAILURE_STALE");

  const response = await getPublicModelStatus(
    new Request("https://tomverse.test/api/models/status")
  );
  const body = (await response.json()) as {
    models: Array<{ id: string; status: string }>;
  };
  for (const model of body.models.filter((row) =>
    row.id.startsWith("perplexity/")
  )) {
    assert.notEqual(model.status, "unavailable", model.id);
  }
});
