/**
 * Operator tool for a promotion whose Stripe linkage has drifted.
 *
 * Dry run by default, and the dry run is the useful part: it prints the
 * database policy, what Stripe actually holds, and which of the two disagree,
 * without touching either. That is what was missing when promotion checkout
 * started failing -- the only way to see the linkage was to read the row and
 * the Stripe dashboard side by side and compare them by eye.
 *
 *   npm run billing:reconcile-promotion -- --code EDDIEFRIEND100 --dry-run
 *   npm run billing:reconcile-promotion -- --code EDDIEFRIEND100 --apply \
 *     --reason "SUP-1234 relink after partial provisioning"
 *
 * `--apply` repairs the database linkage and nothing else. It never creates,
 * edits, deactivates or deletes a Stripe object: those may be attached to live
 * subscriptions, and a script that can silently retire a coupon somebody is
 * being billed under is not a repair tool. When the answer is "Stripe has
 * nothing", the fix is a normal checkout, which provisions idempotently.
 */
import process from "node:process";

const parseArgs = (argv) => {
  const args = { dryRun: true, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[(index += 1)];
    if (token === "--code") args.code = next();
    else if (token === "--plan") args.plan = next();
    else if (token === "--reason") args.reason = next();
    else if (token === "--apply") args.apply = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${token}`);
      process.exit(2);
    }
  }
  // `--apply` is the explicit opt out of the safe default. Passing both is a
  // contradiction, and guessing which one was meant is exactly the wrong
  // instinct for a tool that writes to a billing table.
  if (args.apply) args.dryRun = false;
  return args;
};

const USAGE = `Usage:
  npm run billing:reconcile-promotion -- --code <CODE> [--plan pro|max] [--dry-run|--apply] [--reason <text>] [--json]

  --code    Promotion code to inspect (required).
  --plan    Plan the Stripe objects were provisioned for. Defaults to the
            promotion's single eligible plan; required when it has more than one.
  --dry-run Inspect and report. Default. Mutates nothing.
  --apply   Repair the database linkage only. Requires --reason, and only runs
            when exactly one Stripe object matches this promotion completely.
  --json    Emit the report as JSON instead of text.
`;

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.code) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (args.apply && !args.reason) {
    console.error(
      "--apply requires --reason with a support or incident reference."
    );
    process.exit(2);
  }

  const { getBillingPromotionByCode } = await import("../lib/billingConfig.ts");
  const { getBillingPlans } = await import("../lib/billingConfig.ts");
  const { inspectStripePromotionLinkage } =
    await import("../lib/stripePromotionProvisioning.ts");
  const { prisma } = await import("../lib/prisma.ts");

  const code = args.code.trim().toUpperCase();
  const promotion = await getBillingPromotionByCode(code);
  if (!promotion) {
    console.error(`No promotion found for code ${code}.`);
    process.exit(1);
  }

  const planId =
    args.plan ||
    (promotion.appliesToPlanIds.length === 1
      ? promotion.appliesToPlanIds[0]
      : null);
  if (!planId) {
    console.error(
      `Promotion ${code} applies to ${promotion.appliesToPlanIds.join(", ") || "no plans"}; pass --plan.`
    );
    process.exit(2);
  }

  const plans = await getBillingPlans();
  const plan = plans.find((entry) => entry.id === planId);

  const report = await inspectStripePromotionLinkage({
    promotion,
    planId,
    planProductId: plan?.stripeProductId || null,
  });

  const policy = {
    id: promotion.id,
    code: promotion.code,
    fulfillmentType: promotion.fulfillmentType,
    discountPercent: promotion.discountPercent,
    discountAmountCents: promotion.discountAmountCents,
    durationMonths: promotion.durationMonths,
    maxRedemptions: promotion.maxRedemptions,
    redeemedCount: promotion.redeemedCount,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    appliesToPlanIds: promotion.appliesToPlanIds,
    allowAnnualStacking: promotion.allowAnnualStacking,
    isActive: promotion.isActive,
    updatedAt: promotion.updatedAt,
  };

  let applied = null;
  if (args.apply) {
    const adoptable = report.exactCodeCandidates.filter(
      (candidate) => candidate.adoptable
    );
    if (report.recommendation === "healthy") {
      applied = { performed: false, reason: "linkage_already_healthy" };
    } else if (adoptable.length !== 1) {
      applied = {
        performed: false,
        reason: "no_single_fully_matching_stripe_object",
        adoptableCount: adoptable.length,
      };
    } else if (report.policyViolation) {
      applied = { performed: false, reason: report.policyViolation };
    } else {
      const before = {
        stripeCouponId: promotion.stripeCouponId,
        stripePromotionCodeId: promotion.stripePromotionCodeId,
      };
      // Conditional on the linkage still being what was inspected, so a
      // concurrent admin edit is not overwritten by a decision made against a
      // row that has since changed.
      const written = await prisma.billingPromotion.updateMany({
        where: {
          id: promotion.id,
          code: promotion.code,
          stripePromotionCodeId: before.stripePromotionCodeId,
        },
        data: { stripePromotionCodeId: adoptable[0].id },
      });
      applied = {
        performed: written.count === 1,
        reason:
          written.count === 1 ? "relinked" : "row_changed_since_inspection",
        auditReason: args.reason,
        before,
        after: { stripePromotionCodeId: adoptable[0].id },
      };
    }
  }

  const output = {
    mode: args.apply ? "apply" : "dry-run",
    mutated: Boolean(applied?.performed),
    planId,
    planStripeProductId: plan?.stripeProductId || null,
    policy,
    stripe: report,
    applied,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Promotion ${policy.code} (${policy.id})`);
    console.log(`  plan                 ${planId}`);
    console.log(`  fulfillmentType      ${policy.fulfillmentType}`);
    console.log(
      `  discount             ${policy.discountPercent > 0 ? `${policy.discountPercent}%` : `${policy.discountAmountCents} minor USD`} for ${policy.durationMonths} month(s)`
    );
    console.log(
      `  redemptions          ${policy.redeemedCount}/${policy.maxRedemptions}`
    );
    console.log(
      `  window               ${policy.startsAt} .. ${policy.endsAt}`
    );
    console.log(
      `  plans / annual       ${policy.appliesToPlanIds.join(",")} / stacking=${policy.allowAnnualStacking}`
    );
    console.log(`  active               ${policy.isActive}`);
    console.log(`  policyViolation      ${report.policyViolation || "none"}`);
    console.log("");
    console.log(
      `  stripe mode expected live=${report.expectLiveMode === null ? "unknown" : report.expectLiveMode}`
    );
    console.log(`  stored couponId      ${report.storedCouponId || "-"}`);
    console.log(
      `  stored promoCodeId   ${report.storedPromotionCodeId || "-"} (exists=${report.storedPromotionCodeExists})`
    );
    console.log(
      `  stored mismatches    ${report.storedPromotionCodeMismatches.join(", ") || "none"}`
    );
    console.log(`  exact-code matches   ${report.exactCodeCandidates.length}`);
    for (const candidate of report.exactCodeCandidates) {
      console.log(
        `    - ${candidate.id} active=${candidate.active} livemode=${candidate.livemode} adoptable=${candidate.adoptable} mismatches=${candidate.mismatches.join(",") || "none"}`
      );
    }
    console.log("");
    console.log(`  recommendation       ${report.recommendation}`);
    if (applied) {
      console.log(
        `  apply                performed=${applied.performed} reason=${applied.reason}`
      );
    } else {
      console.log("  apply                not requested; nothing was mutated");
    }
  }

  await prisma.$disconnect().catch(() => undefined);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
