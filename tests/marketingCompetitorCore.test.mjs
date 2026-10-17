import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_COMPETITOR_ACTIONS,
  MARKETING_COMPETITOR_MAX_CANDIDATES,
  MARKETING_COMPETITOR_STATUSES,
  marketingCompetitorCandidateSchema,
  marketingCompetitorHostsSchema,
  marketingCompetitorIdSchema,
  marketingCompetitorPagesOnHosts,
  marketingCompetitorPagesSchema,
} from "@/lib/marketingCompetitorCore";

const candidate = (overrides = {}) => ({
  competitorId: "alpha",
  displayName: "Alpha",
  officialHosts: ["alpha.example"],
  evidenceUrls: ["https://alpha.example/pricing"],
  rationale: "Sells the same comparison.",
  ...overrides,
});

test("audit actions match the statuses the database checks them against", () => {
  // The write guard compares the audit action with 'marketing_competitor.' || status.
  for (const [status, action] of Object.entries(MARKETING_COMPETITOR_ACTIONS)) {
    assert.equal(action, `marketing_competitor.${status}`);
  }
  assert.equal(MARKETING_COMPETITOR_MAX_CANDIDATES, 5);
});

test("the statuses sort in the order the console promises: approved, proposed, rejected, retired", () => {
  // lib/marketingConsoleRead.ts orders by status ascending and states that
  // order on screen; a renamed or added status must not reorder it silently.
  assert.deepEqual([...MARKETING_COMPETITOR_STATUSES].sort(), ["approved", "proposed", "rejected", "retired"]);
});

test("hosts are stored the way they are compared: lower case, unique, sorted", () => {
  assert.deepEqual(marketingCompetitorHostsSchema.parse([" WWW.Alpha.Example ", "alpha.example", "alpha.example"]), [
    "alpha.example",
    "www.alpha.example",
  ]);
  for (const host of ["https://alpha.example", "alpha.example/path", "localhost", "alpha.example.", "-a.example", "a_b.example"]) {
    assert.equal(marketingCompetitorHostsSchema.safeParse([host]).success, false, host);
  }
  assert.equal(marketingCompetitorHostsSchema.safeParse([]).success, false);
  assert.equal(
    marketingCompetitorHostsSchema.safeParse(Array.from({ length: 11 }, (_, i) => `h${i}.example`)).success,
    false,
  );
});

test("a competitor id is the database's id shape", () => {
  for (const id of ["poe", "chat-gpt", "a_1"]) assert.equal(marketingCompetitorIdSchema.safeParse(id).success, true, id);
  for (const id of ["", "Poe", "-poe", "poe.com", "x".repeat(65)]) {
    assert.equal(marketingCompetitorIdSchema.safeParse(id).success, false, id);
  }
});

test("a candidate is strict, bounded and cites only https evidence", () => {
  assert.equal(marketingCompetitorCandidateSchema.safeParse(candidate()).success, true);
  for (const bad of [
    candidate({ status: "approved" }),
    candidate({ evidenceUrls: ["http://alpha.example"] }),
    candidate({ evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://alpha.example/${i}`) }),
    candidate({ rationale: "" }),
    candidate({ rationale: "x".repeat(401) }),
    candidate({ displayName: "x".repeat(81) }),
  ]) {
    assert.equal(marketingCompetitorCandidateSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});

test("a tracked page is an https URL whose host part is exactly one of the hosts", () => {
  const hosts = ["alpha.example", "www.alpha.example"];
  for (const page of ["https://alpha.example", "https://alpha.example/pricing", "https://www.alpha.example/a?b#c"]) {
    assert.equal(marketingCompetitorPagesOnHosts([page], hosts), true, page);
  }
  for (const page of [
    "http://alpha.example/pricing",
    "https://alpha.example:8443/pricing",
    "https://user@alpha.example/pricing",
    "https://blog.alpha.example/pricing",
    "https://ALPHA.example/pricing",
    "https://alpha.example.evil.example/pricing",
    "alpha.example/pricing",
  ]) {
    assert.equal(marketingCompetitorPagesOnHosts([page], hosts), false, page);
  }
  assert.equal(marketingCompetitorPagesOnHosts([], hosts), true);
  assert.equal(
    marketingCompetitorPagesSchema.safeParse(Array.from({ length: 11 }, (_, i) => `https://alpha.example/${i}`)).success,
    false,
  );
});
