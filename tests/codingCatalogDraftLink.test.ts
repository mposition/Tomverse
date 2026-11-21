import assert from "node:assert/strict";
import test from "node:test";

import {
  CODING_DRAFT_PROVIDERS,
  CODING_DRAFT_QUERY_KEYS,
  catalogCodingDraftHref,
  codingDraftOffer,
  codingDraftRequest,
  codingDraftSighting,
  isCodingDraftProvider,
} from "../lib/codingCatalogDraftLink.ts";
import { OFFICIAL_SOURCE_HOSTS } from "../lib/modelCatalogCore.ts";
import { researchAssessment } from "../lib/modelLifecycleWorkItems.ts";
import { AI_PROVIDERS } from "../lib/modelRegistryShared.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
  action: "add",
  product: "coding",
  status: "discovered",
  provider: "qwen",
  apiModel: "qwen3-coder-flash",
  observedVia: [{ provider: "qwen", apiModel: "qwen3-coder-flash" }],
  ...overrides,
});

test("the client-side draft provider list equals the providers a draft can read", () => {
  const readable = AI_PROVIDERS.filter((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider));
  assert.deepEqual([...CODING_DRAFT_PROVIDERS].sort(), [...readable].sort());
});

test("an open coding row offers a draft link that names its provider and API model id", () => {
  const offer = codingDraftOffer(row());
  assert.equal(offer?.kind, "draft");
  assert.equal(offer?.kind === "draft" && offer.href, catalogCodingDraftHref("qwen", "qwen3-coder-flash"));
  const url = new URL((offer as { href: string }).href, "https://example.test");
  assert.equal(url.pathname, "/admin/models");
  assert.equal(url.searchParams.get("tab"), "coding");
  assert.deepEqual(codingDraftRequest(url.search), { provider: "qwen", apiModelId: "qwen3-coder-flash" });
});

test("only an open add row of the coding product gets the button", () => {
  assert.equal(codingDraftOffer(row({ product: "chat" })), null);
  assert.equal(codingDraftOffer(row({ product: "image_generation" })), null);
  assert.equal(codingDraftOffer(row({ action: "retire" })), null);
  for (const status of ["closed_no_action", "rolled_out", "adopted"]) {
    assert.equal(codingDraftOffer(row({ status })), null, status);
  }
  for (const status of ["discovered", "awaiting_decision", "deferred", "approved", "implementation_pending"]) {
    assert.equal(codingDraftOffer(row({ status }))?.kind, "draft", status);
  }
});

test("an aggregator-only coding row says why it cannot be drafted, and a second sighting rescues it", () => {
  const aggregator = row({
    provider: "together",
    apiModel: "Qwen/Qwen3-Coder",
    observedVia: [{ provider: "together", apiModel: "Qwen/Qwen3-Coder" }],
  });
  assert.deepEqual(codingDraftOffer(aggregator), { kind: "no_provider", provider: "together" });
  const rescued = codingDraftOffer({
    ...aggregator,
    observedVia: [
      { provider: "together", apiModel: "Qwen/Qwen3-Coder" },
      { provider: "qwen", apiModel: "qwen3-coder" },
    ],
  });
  assert.equal(rescued?.kind, "draft");
  assert.equal(rescued?.kind === "draft" && rescued.href, catalogCodingDraftHref("qwen", "qwen3-coder"));
  assert.equal(isCodingDraftProvider("openrouter"), false);
  assert.equal(codingDraftSighting({ provider: "sail", apiModel: "x-coder" }), null);
});

test("the draft request is read only from a complete coding link and its keys are the ones cleared", () => {
  assert.equal(codingDraftRequest("?tab=coding"), null);
  assert.equal(codingDraftRequest("?draft=image&model=a&provider=openai&api=a"), null);
  assert.equal(codingDraftRequest("?draft=coding&provider=qwen"), null);
  assert.deepEqual(codingDraftRequest("?draft=coding&provider=qwen&api=Qwen%2Fqwen3-coder"), {
    provider: "qwen",
    apiModelId: "Qwen/qwen3-coder",
  });
  const params = new URLSearchParams(catalogCodingDraftHref("qwen", "m").split("?")[1]);
  for (const key of CODING_DRAFT_QUERY_KEYS) assert.equal(params.has(key), true, key);
});

test("a code research proposal is a coding row, and chat and image proposals are unchanged", () => {
  const research = (product: "chat" | "image" | "code") =>
    researchAssessment({
      product,
      connected: false,
      providerName: "Moonshot",
      citations: [],
      verdictKo: "v",
      pointsKo: [],
      nextStepKo: "n",
      analysisKo: "a",
    });
  assert.equal(research("code").product, "coding");
  assert.equal(research("code").kind, "specialized_code");
  assert.equal(research("image").product, "image_generation");
  assert.equal(research("chat").product, "chat");
});
