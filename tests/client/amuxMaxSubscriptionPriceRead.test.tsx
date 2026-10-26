import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AmuxMaxSubscriptionPricePanel,
  readMaxSubscriptionPriceView } from "../../components/admin/AmuxMaxSubscriptionPricePanel";

const model = { provider: "github-copilot", modelId: "claude-sonnet-4.5" };
const profile = { mode: "subscription_cli", ...model, inputMicroUsdPerMillion: 8_000_000,
  outputMicroUsdPerMillion: 20_000_000, inputTokensCap: 1_000_000, outputTokensCap: 128_000 };
const latest = { id: "p", version: 1, status: "approved",
  expiresAt: "2026-11-03T00:00:00.000Z", admissible: true };

test("a price row reads only its own model's subscription_cli profile reply", () => {
  assert.equal(readMaxSubscriptionPriceView({ state: "profile", profile, latest: null }, model)?.latest, null);
  assert.equal(readMaxSubscriptionPriceView({ state: "profile", profile, latest }, model)?.latest?.admissible, true);
  for (const value of [null, { state: "profile", profile: { ...profile, mode: "api" }, latest },
    { state: "found", profile, latest }, { state: "profile", profile, latest: { ...latest, version: "1" } },
    { state: "profile", profile: { ...profile, inputTokensCap: "1" }, latest: null },
    { state: "profile", profile: { ...profile, provider: "cursor" }, latest },
    { state: "profile", profile: { ...profile, modelId: "gpt-5" }, latest }]) {
    assert.equal(readMaxSubscriptionPriceView(value, model), null);
  }
});

test("before the approved models are read, the panel lists no price row and names every channel", () => {
  const html = renderToStaticMarkup(<AmuxMaxSubscriptionPricePanel />);
  assert.match(html, /Subscription analysis prices/);
  assert.match(html, /Claude, Codex, GitHub Copilot or Cursor/);
  assert.match(html, /Reading the approved Frontier models/);
  assert.match(html, /Reload approved models/);
  assert.doesNotMatch(html, /amux-subscription-price-row/);
});
