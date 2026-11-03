// The morning report's counts are added to the generator context after its
// transaction, best effort (owner request 2026-11-03): a failed read leaves
// the morning report without counts, never the drafts without a context.

import assert from "node:assert/strict";
import test from "node:test";

import { withMarketingMorningInputs } from "@/lib/marketingGeneratorContext";

const CONTEXT = { analysis: { enabled: true, strategyDue: false }, operations: null, marketPrices: [], claims: [] };

test("a read that fails leaves the context as it was, without counts", async () => {
  const failing = { $queryRaw: async () => { throw new Error("relation does not exist"); } };
  const context = await withMarketingMorningInputs(CONTEXT, failing);
  assert.equal(context.operations, null);
  assert.deepEqual(context.marketPrices, []);
  assert.deepEqual(context.claims, []);
});

test("with the switch off, nothing is read", async () => {
  let reads = 0;
  const counting = { $queryRaw: async () => { reads += 1; return []; } };
  const off = { ...CONTEXT, analysis: { enabled: false, strategyDue: false } };
  assert.equal(await withMarketingMorningInputs(off, counting), off);
  assert.equal(reads, 0);
});
