// Does fal still charge what the approved credit was computed from?
//
// The gateway publishes "Pricing is subject to change" beside the number this
// repository turned into a fixed 120-credit product. That sentence is the whole
// reason this file exists: a price move at fal is silent here, and the first
// place it would surface is a settlement report nobody reads weekly.
//
// Two design decisions worth stating, because both look like weaknesses until
// you know what they are avoiding.
//
// **It is a deploy gate, not a readiness check.** fal's pricing API going down
// must not take `/api/ready` with it -- that would stop chat and the two
// working image providers over a price lookup, which is a single point of
// failure wearing a safety feature's clothes.
//
// **It is inert while the model is disabled, and mandatory the moment it is
// not.** Today `fal-ai/nano-banana-2` is on `operational_hold`, so there is no
// price in production to disagree with and CI can run this without a
// credential. The check gains teeth exactly when someone enables the model,
// which is the only moment it matters.

/**
 * "image" and "images" are the same billing basis; "megapixel" is not.
 *
 * Only case and a single trailing "s". Anything cleverer starts guessing at
 * what a unit means, and the whole point of reading it is that we do not.
 */
export const normalizeUnit = (unit) =>
  String(unit ?? "").trim().toLowerCase().replace(/s$/, "");

/** What the pricing API is asked about, derived from the registry entry. */
export const falPricingRequest = (model) => ({
  endpointId: model.apiModelId,
  // The registry stores micro-USD; fal answers in USD.
  approvedUnitPriceUsd:
    (model.prices.find((price) => price.size === "1024x1024")
      ?.outputCostMicroUsd ?? 0) / 1_000_000,
});

/**
 * The verdict, from the registry entry and whatever the API said.
 *
 * `response` is null when no call was made -- no credential, or the model is
 * held -- and the distinction between "did not check" and "checked and agreed"
 * is kept in `status` rather than collapsed into a boolean. A check that
 * reports success when it did not run is worse than one that fails.
 */
export const evaluateFalPricing = ({ model, response, reachError = null }) => {
  const problems = [];
  const notes = [];

  // A branch that does not carry the model at all. This is the ordinary state
  // of `main` between the activation landing on `develop` and reaching it, and
  // it must not be an error: the scheduled check runs against both branches,
  // and a red run every night that means "this branch is older" is the same
  // always-on alarm this repository keeps having to take back out.
  //
  // A skip rather than a pass, and named so: there is no approved price on
  // this branch, so nothing was compared. Deleting the entry by accident is
  // caught loudly elsewhere -- the registry tests name it directly.
  if (!model) {
    notes.push(
      "This branch does not carry fal-ai/nano-banana-2, so it has no approved price to contradict."
    );
    return { status: "not_registered", problems, notes, enabled: false };
  }

  const { endpointId, approvedUnitPriceUsd } = falPricingRequest(model);

  const enabled = model.disabledReason === null;

  if (!enabled) {
    notes.push(
      `${model.id} is disabled (${model.disabledReason}); there is no live price to contradict.`
    );
  }

  if (approvedUnitPriceUsd <= 0) {
    // An enabled model with no price is already a different check's failure,
    // but this one cannot compare against nothing and must not say it did.
    problems.push(
      `${model.id} carries no approved 1K price, so there is nothing to compare fal's against`
    );
    return { status: "cannot_verify", problems, notes, enabled };
  }

  if (!response) {
    if (enabled) {
      // Enabled and unverifiable is the fail-closed case. The price is live,
      // and "we could not look" is not a reason to let it stand.
      problems.push(
        `${model.id} is enabled but fal's published price could not be read` +
          (reachError ? ` (${reachError})` : "") +
          `. Set FAL_KEY and re-run before deploying, or disable the model.`
      );
      return { status: "failed", problems, notes, enabled };
    }
    // Three states, not two. A lookup that was attempted and refused is not a
    // lookup that was skipped, and reporting the second while the first
    // happened is how a broken credential goes unnoticed for weeks and then
    // surfaces on the day someone enables the model. Still exit zero -- there
    // is no live price to be wrong about -- but the word says what happened.
    if (reachError) {
      notes.push(
        `The lookup was attempted and failed: ${reachError}. ` +
          "Nothing is enabled, so nothing is blocked -- but this will fail the " +
          "day the model is enabled, and it is cheaper to fix now."
      );
      return { status: "lookup_failed", problems, notes, enabled };
    }
    notes.push("No pricing lookup was made, and none was required.");
    return { status: "skipped", problems, notes, enabled };
  }

  const entry = (response.prices ?? []).find(
    (price) => price.endpoint_id === endpointId
  );
  if (!entry) {
    problems.push(
      `fal's pricing API returned no entry for ${endpointId}` +
        (response.prices?.length
          ? ` (it returned: ${response.prices.map((price) => price.endpoint_id).join(", ")})`
          : "")
    );
    return { status: enabled ? "failed" : "cannot_verify", problems, notes, enabled };
  }

  // The unit matters as much as the number. A move from per-image to
  // per-megapixel keeps `unit_price` looking small and makes every credit
  // calculation here wrong, because the approved worst case is arithmetic over
  // one image and not over an area.
  //
  // Compared after normalising, because the first live run failed on the
  // difference between "image" and "images". fal's own documentation example
  // uses the singular for another endpoint and this one answers with the
  // plural; that is a label, not a billing basis, and a check that cannot tell
  // those apart cries wolf on its first outing and gets ignored on its second.
  //
  // The normalisation is deliberately narrow -- case and a trailing "s" -- so
  // "megapixel", "second" and "request" still fail. Widening it to "anything
  // image-ish" would give back exactly the failure it exists to catch.
  if (normalizeUnit(entry.unit) !== "image") {
    problems.push(
      `fal bills ${endpointId} per ${entry.unit}, which is not a per-image basis. ` +
        `The approved worst case is arithmetic over one image and does not survive that change.`
    );
  }

  if (entry.currency && entry.currency !== "USD") {
    problems.push(
      `fal quotes ${endpointId} in ${entry.currency}; the approved price is USD`
    );
  }

  // Exact, not "close enough". A tolerance here is a decision about how much
  // unapproved cost is acceptable, and that decision belongs to whoever
  // approves prices.
  if (entry.unit_price !== approvedUnitPriceUsd) {
    problems.push(
      `fal charges ${entry.unit_price} USD per ${entry.unit} for ${endpointId}; ` +
        `the approved price is ${approvedUnitPriceUsd}. ` +
        (entry.unit_price > approvedUnitPriceUsd
          ? "Every generation would cost more than the credit that was sold."
          : "A drop still needs re-approval: the credit was set against the old number.")
    );
  }

  // Printed on every run, not only on failure. A green check that says only
  // "matched" leaves no record of what it matched against, and this run is the
  // evidence that the approved price was still live on the day of deploy.
  notes.push(
    `fal answered: ${entry.unit_price} ${entry.currency ?? "USD"} per ${entry.unit}.`
  );

  // Said rather than quietly skipped. fal's pricing API answers with one unit
  // price; the high-thinking surcharge that makes up 2,000 of the approved
  // 87,000 worst case is documented on the model page and is not in this
  // response. This check cannot see it, and a reader should not assume it did.
  notes.push(
    "The high-thinking surcharge is not exposed by this API and was not compared here. " +
      "It is verified by reading the model page (policy §16.3)."
  );

  if (problems.length > 0) {
    return { status: "failed", problems, notes, enabled };
  }
  return { status: "matched", problems, notes, enabled };
};
