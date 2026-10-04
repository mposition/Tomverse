/**
 * Whether a fact is allowed to back a public claim.
 *
 * Contract: docs/policy/marketing-automation.md §7.2, and the S1 plan's
 * "fact sources" list plus its B2 amendment on Australian prices. The Guard
 * (S1f) decides a draft; this module decides the single question the Guard asks
 * about each declared claim -- is the number behind it a number somebody chose
 * for this deployment, or is it something the code made up in the absence of
 * one?
 *
 * The distinction is the whole point and it is invisible at the call sites that
 * already exist. `getBillingPlans()` and `getBillingPriceCatalog()` merge a
 * stored row, a compiled default and (for one field) arithmetic into a single
 * number, because a page wants the number. A public claim wants the opposite:
 * a compiled default is a price nobody set here, and a derived one is a formula
 * rather than a decision, so neither may be published as what we charge.
 *
 * Pure. Every input is a fact somebody else already read -- these are
 * predicates, so the Guard can stay pure and so a test can state a case without
 * a database. The readers already exist and are not wrapped here:
 * `getBillingPlansWithFieldSources()` in `lib/billingConfig.ts`,
 * `getBillingPriceCatalogWithMeta()` in `lib/billingPriceCatalog.ts`,
 * `getRuntimeModel()` in `lib/modelRegistry.ts`, and
 * `resolveMarketingClaimGate()` in `lib/marketingClaimGates.ts`. Whoever
 * gathers them into the Guard's `facts` input is S1f's business, and inventing
 * that bundle now would be guessing its shape.
 */

import type { BillingPlanFieldSource } from "@/lib/billingConfig";
import { isPubliclySelectableModel } from "@/lib/models";
import type { BillingPriceCatalogSource } from "@/lib/billingPriceCatalog";

/** Why a fact may not back a claim. Codes, because the Guard records them. */
export type MarketingFactRefusal =
  | "price_source_not_stored"
  | "catalogue_source_not_stored"
  | "model_not_publicly_selectable"
  | "model_minimum_plan_mismatch"
  | "model_not_in_registry"
  | "au_price_gst_unverifiable"
  | "au_price_not_in_aud";

export type MarketingFactDecision<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { fact?: undefined } : { fact: T }))
  | { ok: false; refusal: MarketingFactRefusal; detail?: string };

/**
 * Whether every plan field a price claim uses came from a stored row.
 *
 * Takes the fields the claim actually uses rather than the whole plan: a claim
 * about the monthly price is not made false by an annual price nobody set, and
 * refusing it would mean no price claim could be made until every field of
 * every plan had been written by hand.
 *
 * The refusal names the offending fields in `detail` because the operator
 * alert this feeds (`marketing_guard_price_source_fallback`, delivery in
 * S2/S3) is useless without them -- "a price was not stored" sends somebody to
 * read a whole table.
 */
export function priceClaimSourceDecision(
  fields: ReadonlyArray<{ field: string; source: BillingPlanFieldSource }>,
): MarketingFactDecision {
  // An empty list is a claim that declares itself to be about prices and then
  // names no price. That is a malformed claim rather than a satisfied one, so
  // it refuses: `every` on an empty array would say yes.
  if (fields.length === 0) {
    return {
      ok: false,
      refusal: "price_source_not_stored",
      detail: "no field named",
    };
  }

  const unstored = fields.filter((entry) => entry.source !== "stored");
  if (unstored.length > 0) {
    return {
      ok: false,
      refusal: "price_source_not_stored",
      detail: unstored
        .map((entry) => `${entry.field}=${entry.source}`)
        .join(","),
    };
  }
  return { ok: true };
}

/**
 * Whether the localized catalogue may back a claim.
 *
 * Only `stored` counts. The other three sources are each a different way of
 * having no stored row -- there was none and one was just written from the
 * defaults, the row did not parse, the row parsed and failed the schema -- and
 * in all three the numbers served are the compiled defaults. A claim resting on
 * them would be a statement about this deployment's prices made from a table
 * nobody in this deployment approved.
 */
export function catalogueClaimSourceDecision(
  source: BillingPriceCatalogSource,
): MarketingFactDecision {
  if (source !== "stored") {
    return {
      ok: false,
      refusal: "catalogue_source_not_stored",
      detail: source,
    };
  }
  return { ok: true };
}

/**
 * Whether a claim about a model matches the model.
 *
 * `model` is the runtime row, not the code catalogue. They can differ: a
 * registry row keeps the value it was seeded with and `lib/models.ts` can be
 * edited without reaching it (AGENTS.md, "Credit entitlement vs operational
 * guardrail"). A claim is about what a visitor can actually select today, so
 * the row is what answers.
 *
 * `null` means the registry has no such model, which is a different refusal
 * from having one nobody can select: the first is a claim about something that
 * does not exist, the second about something that does and is not offered.
 */
export function modelClaimDecision({
  model,
  claimedMinimumPlan,
}: {
  model: {
    id: string;
    minimumPlan: string;
    enabled: boolean;
    publiclyListed?: boolean;
    status: string;
    catalogDeleted?: boolean;
  } | null;
  claimedMinimumPlan?: string;
}): MarketingFactDecision {
  if (!model) {
    return { ok: false, refusal: "model_not_in_registry" };
  }

  // `isPubliclySelectableModel()` itself, not a copy of its rule. A copy agrees
  // today and drifts the first time somebody adds a lifecycle signal to the
  // selector, and it would drift towards claiming a model is offered when it is
  // not. The cast is because that function takes `Pick<AiModel, ...>` with its
  // own string unions, and this takes the shape a caller can build from a
  // registry row without constructing a model.
  if (!isPubliclySelectableModel(model as Parameters<typeof isPubliclySelectableModel>[0])) {
    return {
      ok: false,
      refusal: "model_not_publicly_selectable",
      detail: model.id,
    };
  }

  if (claimedMinimumPlan !== undefined && claimedMinimumPlan !== model.minimumPlan) {
    return {
      ok: false,
      refusal: "model_minimum_plan_mismatch",
      detail: `${claimedMinimumPlan}!=${model.minimumPlan}`,
    };
  }

  return { ok: true };
}

/**
 * Whether a price claim aimed at Australia may be made at all.
 *
 * S1 plan, B2 amendment: an Australian price claim needs a stored catalogue
 * entry in AUD **and** a stored flag proving the displayed price includes GST.
 * Australian consumer law requires a single price inclusive of GST, and whether
 * these numbers are GST-inclusive is not derivable from the numbers.
 *
 * **There is no such flag in the catalogue today**, so this always refuses, and
 * it takes no argument that could change that. `billingPriceCatalogSchema`
 * (lib/billingPriceCatalog.ts) carries prices and no tax metadata.
 *
 * It used to take a `gstInclusiveDeclared` boolean, which made the rule say
 * something different from what the amendment says: not "refused until the
 * catalogue proves it" but "refused unless the caller says so". A caller
 * assembling `true` is not a stored flag, and the caller assembling it would be
 * the Guard, from nothing. The refusal is unconditional because the fact it
 * needs does not exist yet.
 *
 * Making it conditional again means adding a typed field to the catalogue
 * schema and reading it here, in one change. The test asserts the schema still
 * has no such field, so that change cannot happen quietly.
 */
export function australianPriceClaimDecision({
  currency,
  catalogueSource,
}: {
  currency: string;
  catalogueSource: BillingPriceCatalogSource;
}): MarketingFactDecision {
  const catalogue = catalogueClaimSourceDecision(catalogueSource);
  if (!catalogue.ok) return catalogue;

  // Its own code: a price in the wrong currency is not an unverifiable GST
  // claim, and a refusal that names the wrong problem sends whoever reads it
  // looking for a tax flag.
  if (currency !== "AUD") {
    return {
      ok: false,
      refusal: "au_price_not_in_aud",
      detail: `currency=${currency}`,
    };
  }
  return {
    ok: false,
    refusal: "au_price_gst_unverifiable",
    detail: "the price catalogue carries no gst-inclusive flag",
  };
}

// What this becomes when the catalogue can answer: a typed stored field is read
// here, `true` passes, anything else keeps the refusal -- and the claim is
// still `approval_required` at the Guard (§7.4), never autonomous.
