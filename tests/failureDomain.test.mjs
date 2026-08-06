import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  failureDomainOf,
  groupByFailureDomain,
  sharesFailureDomain,
} from "../lib/failureDomain.ts";

const live = AVAILABLE_MODELS.filter((model) => model.enabled && !model.catalogDeleted);

// --- the property that makes provider an acceptable proxy today --------------

// This is the assertion worth having, and it is deliberately a property rather
// than a list of eleven domains: adding a seventh OpenAI model must not fail it,
// while putting two vendors behind one gateway must.
//
// If it does fail, the derived domain has already done the right thing -- it
// merged two providers that now share a host or a credential. The failure is
// the notification, not the bug. Confirm the merge is real and update this.
test("today, no two providers share a failure domain", () => {
  const domainToProviders = new Map();
  for (const model of live) {
    const domain = failureDomainOf(model);
    const providers = domainToProviders.get(domain) ?? new Set();
    providers.add(model.provider);
    domainToProviders.set(domain, providers);
  }

  const merged = [...domainToProviders.entries()].filter(([, providers]) => providers.size > 1);
  assert.deepEqual(
    merged.map(([domain, providers]) => `${domain}: ${[...providers].join(", ")}`),
    [],
    "two providers now share a host or credential -- confirm that is intended"
  );
});

test("today, one provider is one failure domain", () => {
  const providerToDomains = new Map();
  for (const model of live) {
    const domains = providerToDomains.get(model.provider) ?? new Set();
    domains.add(failureDomainOf(model));
    providerToDomains.set(model.provider, domains);
  }

  const split = [...providerToDomains.entries()].filter(([, domains]) => domains.size > 1);
  assert.deepEqual(
    split.map(([provider, domains]) => `${provider}: ${[...domains].join(" / ")}`),
    [],
    "a provider now spans several endpoints or credentials -- the Router will treat them apart"
  );
});

test("the catalogue partitions into one domain per provider", () => {
  const groups = groupByFailureDomain(live);
  const providers = new Set(live.map((model) => model.provider));
  assert.equal(groups.size, providers.size);
  assert.ok(groups.size > 1, "a single domain would make every fallback a retry");
});

// --- the mechanism, not the label -------------------------------------------

// The gateway case. Two vendors behind one host fail as one endpoint, however
// distinct their names are, and a fallback across them is a retry.
test("a shared host merges two providers into one domain", () => {
  const a = { provider: "qwen", apiBaseUrl: "https://gateway.example.com/v1", apiKeyEnvName: "GW_KEY" };
  const b = { provider: "moonshot", apiBaseUrl: "https://gateway.example.com/v1", apiKeyEnvName: "GW_KEY" };
  assert.equal(sharesFailureDomain(a, b), true);
});

// The account case. A revoked or exhausted key takes every model with it, no
// matter how healthy each vendor is.
test("a shared credential merges providers even on different hosts", () => {
  const a = { provider: "qwen", apiBaseUrl: "https://a.example.com/v1", apiKeyEnvName: "SHARED_KEY" };
  const b = { provider: "qwen", apiBaseUrl: "https://b.example.com/v1", apiKeyEnvName: "SHARED_KEY" };
  assert.equal(sharesFailureDomain(a, b), false, "different hosts are different endpoints");

  const sameHostSharedKey = { ...a, apiBaseUrl: "https://a.example.com/v2" };
  assert.equal(
    sharesFailureDomain(a, sameHostSharedKey),
    true,
    "the same host and key is the same fate, whatever the path"
  );
});

test("one provider split across endpoints is two domains", () => {
  const primary = { provider: "openai", apiBaseUrl: "https://api.openai.com/v1", apiKeyEnvName: "OPENAI_API_KEY" };
  const mirror = { provider: "openai", apiBaseUrl: "https://mirror.example.com/v1", apiKeyEnvName: "OPENAI_MIRROR_KEY" };
  assert.equal(sharesFailureDomain(primary, mirror), false);
});

test("models with no explicit endpoint fall back to their provider", () => {
  assert.equal(
    sharesFailureDomain({ provider: "anthropic" }, { provider: "anthropic" }),
    true
  );
  assert.equal(sharesFailureDomain({ provider: "anthropic" }, { provider: "google" }), false);
});

// An unparseable base URL is still a distinct configuration. Treating it as the
// SDK default would quietly merge it with models that really do use the default.
test("an unparseable endpoint does not merge into the SDK default", () => {
  const broken = { provider: "openai", apiBaseUrl: "not a url" };
  assert.equal(sharesFailureDomain(broken, { provider: "openai" }), false);
  assert.notEqual(failureDomainOf(broken), failureDomainOf({ provider: "openai" }));
});

test("host comparison ignores case and path", () => {
  assert.equal(
    sharesFailureDomain(
      { provider: "openai", apiBaseUrl: "https://API.OpenAI.com/v1", apiKeyEnvName: "K" },
      { provider: "openai", apiBaseUrl: "https://api.openai.com/v2/chat", apiKeyEnvName: "K" }
    ),
    true
  );
});
