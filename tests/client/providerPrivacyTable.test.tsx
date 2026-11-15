import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDestinationTable } from "@/components/legal/ProviderDestinationTable";
import { PROVIDER_DATA_DESTINATIONS } from "@/lib/providerDataDestinations";
import { en } from "@/locales/en";

const copy = new Map(Object.entries(en.privacyPolicy));
const t = (key: string) => copy.get(key.replace(/^privacyPolicy\./, "")) ?? key;

test("an unverified Cohere profile keeps all existing provider disclosures and names the recipient", () => {
  const html = renderToStaticMarkup(createElement(ProviderDestinationTable, { rows: PROVIDER_DATA_DESTINATIONS, t }));
  assert.equal((html.match(/scope="row"/g) ?? []).length, PROVIDER_DATA_DESTINATIONS.length);
  assert.match(html, /OpenAI OpCo/);
  assert.match(html, /Cohere Inc\./);
  assert.match(html, /https:\/\/cohere\.com\/privacy/);
  assert.match(html, /have not verified the account-specific/);
});

test("unverified facts cannot become training or retention promises", () => {
  const cohere = PROVIDER_DATA_DESTINATIONS.find(row => row.provider === "cohere")!;
  const html = renderToStaticMarkup(createElement(ProviderDestinationTable, {
    rows: [{ ...cohere, trainsOnCustomerContent: { value: false, evidenceRef: null },
      retention: { ...cohere.retention, content: { behavior: "NO_PERSISTENT_STORAGE", maxDays: null, evidenceRef: null } } }], t,
  }));
  assert.match(html, /have not verified the account-specific/);
  assert.doesNotMatch(html, />No</);
  assert.doesNotMatch(html, /Not stored/);
});
