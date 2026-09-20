import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  getBillingPlans,
  getBillingPlansWithFieldSources,
  syncBillingDefaultsToDatabase,
} from "@/lib/billingConfig";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// Where a plan's numbers come from, which is what decides whether a price claim
// may be made at all.
//
// Contract: docs/policy/marketing-automation.md §7.2 -- a price or plan claim
// rests on a stored value. `getBillingPlans()` merges the stored row, the
// compiled default and one derived formula into a single number because that is
// what a page wants; this suite is about the reader that keeps them apart, and
// about the promise that adding it changed nothing for the existing one.

const reset = () => prisma.billingPlan.deleteMany({});

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("the new reader returns exactly the plans the existing one does", async () => {
  // The golden property. Two readers that agree about sources and disagree
  // about values would be worse than one reader, because the disagreement would
  // only surface in a claim nobody could explain.
  const plans = await getBillingPlans();
  const withSources = await getBillingPlansWithFieldSources();

  assert.deepEqual(
    withSources.map((entry) => entry.plan),
    plans,
  );
});

test("with no row, every field is the compiled default", async () => {
  const withSources = await getBillingPlansWithFieldSources();
  assert.ok(withSources.length > 0, "the defaults are the plans");

  for (const { plan, sources } of withSources) {
    for (const [field, source] of Object.entries(sources)) {
      assert.equal(
        source,
        "compiled_default",
        `${plan.id}.${field} with no stored row`,
      );
    }
  }
});

test("a stored row makes its fields stored, and a NULL annual price derived", async () => {
  const [first] = await getBillingPlans();
  assert.ok(first, "there is a plan to store");

  await prisma.billingPlan.create({
    data: {
      id: first.id,
      name: first.name,
      tier: first.tier,
      monthlyPriceCents: first.monthlyPriceCents,
      // Left NULL on purpose: this is the field that becomes arithmetic.
      annualPriceCents: null,
      currency: first.currency,
      dailyMessageLimit: first.dailyMessageLimit,
      monthlyMessageLimit: first.monthlyMessageLimit,
      maxModels: first.maxModels,
      allowAttachments: first.allowAttachments,
      allowSharing: first.allowSharing,
      allowDownloads: first.allowDownloads,
      isActive: first.isActive,
      sortOrder: first.sortOrder,
    },
  });

  const withSources = await getBillingPlansWithFieldSources();
  assert.deepEqual(
    withSources.map((entry) => entry.plan),
    await getBillingPlans(),
    "the two readers still agree once a row exists",
  );
  const stored = withSources.find((entry) => entry.plan.id === first.id);
  assert.ok(stored);

  assert.equal(stored.sources.monthlyPriceCents, "stored");
  assert.equal(
    stored.sources.tier,
    "derived_formula",
    "tier is computed from the id; the column is never read",
  );
  assert.equal(
    stored.sources.annualPriceCents,
    "derived_formula",
    "a NULL annual price is monthly times twelve times four fifths, not a decision",
  );
  assert.equal(
    stored.plan.annualPriceCents,
    Math.round(first.monthlyPriceCents * 12 * 0.8),
    "and the derived value is that arithmetic",
  );

  // Every other plan still has no row of its own.
  for (const entry of withSources) {
    if (entry.plan.id === first.id) continue;
    assert.equal(entry.sources.monthlyPriceCents, "compiled_default", entry.plan.id);
  }
});

test("a stored annual price is stored, not derived", async () => {
  const [first] = await getBillingPlans();
  assert.ok(first);

  await prisma.billingPlan.create({
    data: {
      id: first.id,
      name: first.name,
      tier: first.tier,
      monthlyPriceCents: first.monthlyPriceCents,
      annualPriceCents: 12_345,
      currency: first.currency,
      dailyMessageLimit: first.dailyMessageLimit,
      monthlyMessageLimit: first.monthlyMessageLimit,
      maxModels: first.maxModels,
      allowAttachments: first.allowAttachments,
      allowSharing: first.allowSharing,
      allowDownloads: first.allowDownloads,
      isActive: first.isActive,
      sortOrder: first.sortOrder,
    },
  });

  const withSources = await getBillingPlansWithFieldSources();
  assert.deepEqual(
    withSources.map((entry) => entry.plan),
    await getBillingPlans(),
    "and with a stored annual price too",
  );
  const stored = withSources.find((entry) => entry.plan.id === first.id);
  assert.ok(stored);
  assert.equal(stored.sources.annualPriceCents, "stored");
  assert.equal(stored.plan.annualPriceCents, 12_345);
});

test("a row the seeder wrote is not a price anybody chose", async () => {
  // The defect this test exists for: `syncBillingDefaultsToDatabase()` copies
  // the compiled defaults into rows, and it runs when the admin billing screen
  // renders. So on a deployment where nobody has ever pressed save, every plan
  // has a row -- and a reader that asks only whether a row exists reports
  // numbers nobody picked as this deployment's prices. Instagram and TikTok
  // posts cannot be retracted through an API, so such a claim is not
  // recoverable.
  await syncBillingDefaultsToDatabase();

  const withSources = await getBillingPlansWithFieldSources();
  assert.ok(withSources.length > 0);
  assert.deepEqual(
    withSources.map((entry) => entry.plan),
    await getBillingPlans(),
  );

  for (const { plan, sources } of withSources) {
    assert.equal(
      sources.monthlyPriceCents,
      "created_from_default",
      `${plan.id} was seeded, not saved`,
    );
  }
});

test("an administrator saving the row makes it stored", async () => {
  // The other half: the marker has to come off, or no price claim could ever
  // be made. The admin PATCH clears `metadata`; this reproduces that write
  // rather than calling the route, because the route is a different contract.
  await syncBillingDefaultsToDatabase();
  const [first] = await getBillingPlans();
  assert.ok(first);

  await prisma.billingPlan.update({
    where: { id: first.id },
    data: { metadata: Prisma.DbNull, monthlyPriceCents: 2_500 },
  });

  const withSources = await getBillingPlansWithFieldSources();
  const saved = withSources.find((entry) => entry.plan.id === first.id);
  assert.ok(saved);
  assert.equal(saved.sources.monthlyPriceCents, "stored");
  assert.equal(saved.plan.monthlyPriceCents, 2_500);

  // And the plans nobody saved are still marked.
  for (const entry of withSources) {
    if (entry.plan.id === first.id) continue;
    assert.equal(
      entry.sources.monthlyPriceCents,
      "created_from_default",
      entry.plan.id,
    );
  }
});

test("a seeded row with a NULL annual price is derived, not created_from_default", async () => {
  // Precedence: arithmetic is arithmetic whoever wrote the row, and naming the
  // seeding would be the wrong reason for refusing the claim.
  await syncBillingDefaultsToDatabase();
  const [first] = await getBillingPlans();
  assert.ok(first);

  await prisma.billingPlan.update({
    where: { id: first.id },
    data: { annualPriceCents: null },
  });

  const withSources = await getBillingPlansWithFieldSources();
  const seeded = withSources.find((entry) => entry.plan.id === first.id);
  assert.ok(seeded);
  assert.equal(seeded.sources.annualPriceCents, "derived_formula");
  assert.equal(seeded.sources.monthlyPriceCents, "created_from_default");
});
