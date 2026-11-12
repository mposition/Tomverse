import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminMarketingFeatureFactsPanel, type MarketingFeatureFactView } from "@/components/admin/AdminMarketingFeatureFactsPanel";

// Admin › Marketing › Settings › Ad facts (owner request 2026-11-12).

const row = (overrides: Partial<MarketingFeatureFactView>): MarketingFeatureFactView => ({
  id: "chat",
  position: 0,
  what: "Chat with leading models in one workspace.",
  models: ["GPT 6 Luna", "Claude Haiku 5.5"],
  realExample: null,
  copy: null,
  disclosure: null,
  source: "claim.chat-and-review",
  hold: null,
  updatedAt: "2026-11-12T00:00:00.000Z",
  ...overrides,
});

const rows = [
  row({}),
  row({ id: "plugins", what: "Plugins.", models: [], hold: "Not live: no connectable server." }),
  row({ id: "memory", what: "Account memory.", models: [], disclosure: { en: "Answers draw on your past chats." }, copy: "Never say memories are copied." }),
];

test("each feature shows whether it is in the ads, its facts, and its fixed disclosure", () => {
  const html = renderToStaticMarkup(<AdminMarketingFeatureFactsPanel initial={rows} canWrite refreshModelId="gpt-6-luna" />);
  assert.match(html, /data-testid="feature-fact-chat"/);
  assert.match(html, /In ads/);
  assert.match(html, /On hold/);
  assert.match(html, /Not live: no connectable server\./);
  assert.match(html, /GPT 6 Luna · Claude Haiku 5\.5/);
  assert.match(html, /Disclosure \(fixed, §17\.1\): Answers draw on your past chats\./);
  assert.match(html, /Never say memories are copied\./);
});

test("a writer gets edit, hold controls, add and the refresh, which names its paid model", () => {
  const html = renderToStaticMarkup(<AdminMarketingFeatureFactsPanel initial={rows} canWrite refreshModelId="gpt-6-luna" />);
  assert.match(html, />Edit</);
  assert.match(html, />Put on hold</);
  assert.match(html, />Release hold</);
  assert.match(html, /Add a feature/);
  assert.match(html, /Refresh from the site/);
  assert.match(html, /One paid call on gpt-6-luna proposes changes; nothing is saved until you open a proposal and save it\./);
});

test("the refresh turned off is drawn disabled with its reason", () => {
  const html = renderToStaticMarkup(<AdminMarketingFeatureFactsPanel initial={rows} canWrite refreshModelId={null} />);
  assert.match(html, /<button[^>]*data-testid="feature-facts-refresh"[^>]*disabled=""/);
  assert.match(html, /Refresh is off/);
});

test("a reader gets no controls", () => {
  const html = renderToStaticMarkup(<AdminMarketingFeatureFactsPanel initial={rows} canWrite={false} refreshModelId="gpt-6-luna" />);
  assert.doesNotMatch(html, />Edit</);
  assert.doesNotMatch(html, /Refresh from the site/);
  assert.match(html, /Read only/);
});

test("an unreadable list says so and is not drawn as empty", () => {
  const html = renderToStaticMarkup(<AdminMarketingFeatureFactsPanel initial={null} canWrite refreshModelId="gpt-6-luna" />);
  assert.match(html, /The list could not be read\./);
  assert.doesNotMatch(html, /feature-fact-/);
});
