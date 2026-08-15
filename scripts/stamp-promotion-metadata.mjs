/**
 * Operator tool for a promotion whose Stripe objects carry no Tomverse stamp.
 *
 * `scripts/reconcile-promotion.mjs` repairs the database linkage and states,
 * deliberately, that it never edits a Stripe object. This is the other half,
 * kept separate for the same reason: writing to Stripe is a different act from
 * writing to our own row, and the two should not share a flag.
 *
 * The failure it exists for: a coupon or promotion code created by hand in the
 * dashboard, or by a build that predates `metadata.planId`, has no
 * `tomversePromotionId` / `planId`. `planMetadataMismatch()` and
 * `couponMismatches()` read those stamps to decide the object is ours, so an
 * unstamped object is an `identity` mismatch, `canUseStripePromotionCode()`
 * returns false, and checkout answers "This promotion is not currently
 * available." on a promotion whose own validation had just succeeded.
 *
 *   npm run billing:stamp-promotion -- --code EDDIEFRIEND100 --plan pro --dry-run
 *   npm run billing:stamp-promotion -- --code EDDIEFRIEND100 --plan pro --apply \
 *     --reason "SUP-1234 stamp dashboard-created objects"
 *
 * What it will not do, by construction rather than by intention:
 *
 *   - It sends `metadata` and nothing else. The discount, the duration, the
 *     expiry, the redemption cap and the active flag are never in the request
 *     body, so no invocation can move them.
 *   - It stamps only the objects the database is already linked to, and only
 *     after confirming the promotion code hangs off that same coupon. An
 *     object found by code search is a stranger until something other than its
 *     name says otherwise, and stamping one would manufacture the very proof
 *     of ownership the stamp is supposed to carry.
 *   - It writes nothing to the database. Linkage repair stays in the other
 *     script.
 *
 * `--apply` captures the pre-change metadata to a snapshot file first, and
 * re-reads both objects afterwards to report the mismatch sets that result.
 * Reverting is `metadata[key]=""` on the keys the snapshot shows were absent.
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

import {
  SNAPSHOT_FILENAME_PREFIX,
  stampDiff,
  stampFor,
  stampRequestBody,
} from "./stamp-promotion-metadata-core.mjs";

const parseArgs = (argv) => {
  const args = { dryRun: true, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[(index += 1)];
    if (token === "--code") args.code = next();
    else if (token === "--plan") args.plan = next();
    else if (token === "--reason") args.reason = next();
    else if (token === "--snapshot") args.snapshot = next();
    else if (token === "--apply") args.apply = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${token}`);
      process.exit(2);
    }
  }
  if (args.apply) args.dryRun = false;
  return args;
};

const USAGE = `Usage:
  npm run billing:stamp-promotion -- --code <CODE> [--plan pro|max] [--dry-run|--apply] [--reason <text>] [--snapshot <path>] [--json]

  --code     Promotion code whose linked Stripe objects to stamp (required).
  --plan     Plan id to stamp. Defaults to the promotion's single eligible plan;
             required when it has more than one. One object serves every
             eligible plan, so the stamp names whichever plan you pass and
             \`planMetadataMismatch()\` accepts it for the others.
  --dry-run  Report the current metadata and the proposed stamp. Default.
             Mutates nothing.
  --apply    Write the metadata. Requires --reason. Captures a snapshot first
             and re-reads both objects afterwards.
  --snapshot Where to write the pre-change snapshot under --apply.
             Defaults to ./promotion-metadata-snapshot-<CODE>-<epoch>.json
  --json     Emit the report as JSON instead of text.

Running it against a deployed environment:

  railway run --environment production --service Tomverse \\
    node --conditions=react-server --import tsx scripts/stamp-promotion-metadata.mjs \\
    --code <CODE> --plan pro --dry-run --json

  Call node directly there rather than going through npm. \`railway run\` consumes
  the \`--\` separator, so \`npm run ... -- --code X\` arrives at npm without it,
  npm reads --code and --plan as its own config, and the script receives only
  the bare values -- which it then rejects as unknown arguments.
`;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

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

  const { getBillingPromotionByCode, getBillingPlans } = await import(
    "../lib/billingConfig.ts"
  );
  const { getStripe } = await import("../lib/stripe.ts");
  const {
    couponMismatches,
    promotionCodeMismatches,
    canUseStripePromotionCode,
    describeMismatches,
    promotionCodeCouponId,
    stripeKeyLiveMode,
  } = await import("../lib/stripePromotionProvisioningCore.ts");
  const { prisma } = await import("../lib/prisma.ts");

  const code = args.code.trim().toUpperCase();
  const promotion = await getBillingPromotionByCode(code);
  if (!promotion) fail(`No promotion found for code ${code}.`);

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
  if (!promotion.appliesToPlanIds.includes(planId)) {
    fail(
      `Promotion ${code} does not apply to plan ${planId}; a stamp naming an ineligible plan is drift on every checkout.`
    );
  }

  // Linked objects only. An id the database does not hold is not this tool's
  // to write to, whatever the dashboard shows under the same code string.
  if (!promotion.stripeCouponId || !promotion.stripePromotionCodeId) {
    fail(
      `Promotion ${code} has no stored linkage (couponId=${promotion.stripeCouponId || "-"}, promotionCodeId=${promotion.stripePromotionCodeId || "-"}). Repair the linkage first with billing:reconcile-promotion.`
    );
  }

  const plans = await getBillingPlans();
  const plan = plans.find((entry) => entry.id === planId);
  const stripe = getStripe();
  const expectLiveMode = stripeKeyLiveMode(process.env.STRIPE_SECRET_KEY);

  const coupon = await stripe.coupons
    .retrieve(promotion.stripeCouponId)
    .catch(() => null);
  if (!coupon) {
    fail(
      `Stripe has no coupon ${promotion.stripeCouponId} in this mode. Nothing to stamp.`
    );
  }
  const promotionCode = await stripe.promotionCodes
    .retrieve(promotion.stripePromotionCodeId)
    .catch(() => null);
  if (!promotionCode) {
    fail(
      `Stripe has no promotion code ${promotion.stripePromotionCodeId} in this mode. Nothing to stamp.`
    );
  }

  if (expectLiveMode !== null) {
    for (const [label, object] of [
      ["coupon", coupon],
      ["promotion code", promotionCode],
    ]) {
      if (
        typeof object.livemode === "boolean" &&
        object.livemode !== expectLiveMode
      ) {
        fail(
          `The ${label} is livemode=${object.livemode} but the key is livemode=${expectLiveMode}. Refusing to stamp across modes.`
        );
      }
    }
  }

  // The promotion code must hang off the coupon the database names. Without
  // this the tool could stamp a coupon that no checkout ever reaches, leaving
  // the real one unstamped and the failure unchanged.
  const attachedCouponId = promotionCodeCouponId(promotionCode);
  if (attachedCouponId !== promotion.stripeCouponId) {
    fail(
      `Promotion code ${promotionCode.id} is attached to coupon ${attachedCouponId || "-"}, not the stored ${promotion.stripeCouponId}. Refusing to stamp two objects that are not a pair.`
    );
  }

  const desired = stampFor(promotion.id, planId);
  const couponDiff = stampDiff(coupon.metadata, desired);
  const promotionCodeDiff = stampDiff(promotionCode.metadata, desired);

  const evaluate = (couponObject, codeObject) => {
    const couponIssues = couponMismatches({
      coupon: {
        livemode: couponObject.livemode,
        metadata: couponObject.metadata || {},
        percentOff: couponObject.percent_off ?? null,
        amountOff: couponObject.amount_off ?? null,
        currency: couponObject.currency ?? null,
        duration: couponObject.duration,
        durationInMonths: couponObject.duration_in_months ?? null,
        appliesToProducts: couponObject.applies_to?.products || null,
        valid: couponObject.valid,
      },
      promotion,
      planId,
      expectLiveMode,
      planProductId: plan?.stripeProductId || null,
    });
    const codeIssues = promotionCodeMismatches({
      promotionCode: {
        livemode: codeObject.livemode,
        code: codeObject.code,
        metadata: codeObject.metadata || {},
        couponId: promotionCodeCouponId(codeObject),
        active: codeObject.active,
        expiresAtSeconds: codeObject.expires_at ?? null,
        maxRedemptions: codeObject.max_redemptions ?? null,
        timesRedeemed: codeObject.times_redeemed ?? null,
        customerId:
          typeof codeObject.customer === "string"
            ? codeObject.customer
            : codeObject.customer?.id || null,
      },
      promotion,
      planId,
      expectLiveMode,
      expectedCouponId: promotion.stripeCouponId,
      nowSeconds: Math.floor(Date.now() / 1000),
      customerId: null,
    });
    const combined = [...codeIssues, ...couponIssues];
    return {
      coupon: describeMismatches(couponIssues),
      promotionCode: describeMismatches(codeIssues),
      combined: describeMismatches(combined),
      checkoutWouldUse: canUseStripePromotionCode(combined),
    };
  };

  const before = evaluate(coupon, promotionCode);

  // Everything the operator would need to reconstruct the objects' state, and
  // nothing that is not already visible in their own dashboard.
  const snapshot = {
    capturedAt: new Date().toISOString(),
    reason: args.reason || null,
    promotion: { id: promotion.id, code: promotion.code, planId },
    coupon: {
      id: coupon.id,
      livemode: coupon.livemode,
      metadata: coupon.metadata || {},
      percentOff: coupon.percent_off ?? null,
      amountOff: coupon.amount_off ?? null,
      duration: coupon.duration,
      durationInMonths: coupon.duration_in_months ?? null,
      valid: coupon.valid,
    },
    promotionCode: {
      id: promotionCode.id,
      livemode: promotionCode.livemode,
      metadata: promotionCode.metadata || {},
      code: promotionCode.code,
      couponId: attachedCouponId,
      active: promotionCode.active,
      expiresAt: promotionCode.expires_at ?? null,
      maxRedemptions: promotionCode.max_redemptions ?? null,
      timesRedeemed: promotionCode.times_redeemed ?? null,
    },
    mismatches: before,
  };

  let applied = null;
  let after = null;
  if (args.apply) {
    if (couponDiff.length === 0 && promotionCodeDiff.length === 0) {
      applied = { performed: false, reason: "already_stamped" };
    } else {
      const snapshotPath =
        args.snapshot ||
        `./${SNAPSHOT_FILENAME_PREFIX}${code}-${Date.now()}.json`;
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

      // `metadata` is the entire request body in both calls. Stripe merges
      // metadata keys, so the object keeps every key it already had and gains
      // only these two.
      if (couponDiff.length > 0) {
        await stripe.coupons.update(coupon.id, stampRequestBody(desired));
      }
      if (promotionCodeDiff.length > 0) {
        await stripe.promotionCodes.update(
          promotionCode.id,
          stampRequestBody(desired)
        );
      }

      const freshCoupon = await stripe.coupons.retrieve(coupon.id);
      const freshCode = await stripe.promotionCodes.retrieve(promotionCode.id);
      after = {
        coupon: { id: freshCoupon.id, metadata: freshCoupon.metadata || {} },
        promotionCode: {
          id: freshCode.id,
          metadata: freshCode.metadata || {},
          active: freshCode.active,
          expiresAt: freshCode.expires_at ?? null,
          maxRedemptions: freshCode.max_redemptions ?? null,
        },
        mismatches: evaluate(freshCoupon, freshCode),
      };
      applied = {
        performed: true,
        reason: "stamped",
        auditReason: args.reason,
        snapshotPath,
        couponChanged: couponDiff.length > 0,
        promotionCodeChanged: promotionCodeDiff.length > 0,
      };
    }
  }

  const output = {
    mode: args.apply ? "apply" : "dry-run",
    mutated: Boolean(applied?.performed),
    planId,
    planStripeProductId: plan?.stripeProductId || null,
    desiredStamp: desired,
    snapshot,
    proposed: { coupon: couponDiff, promotionCode: promotionCodeDiff },
    applied,
    after,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Promotion ${promotion.code} (${promotion.id})`);
    console.log(`  plan                 ${planId}`);
    console.log(
      `  coupon               ${coupon.id} metadata=${JSON.stringify(coupon.metadata || {})}`
    );
    console.log(
      `  promotion code       ${promotionCode.id} metadata=${JSON.stringify(promotionCode.metadata || {})}`
    );
    console.log(
      `  code expires / cap   ${promotionCode.expires_at ?? "-"} / ${promotionCode.max_redemptions ?? "-"} (never written by this tool)`
    );
    console.log("");
    console.log(
      `  before  coupon       ${before.coupon.join(", ") || "none"}`
    );
    console.log(
      `  before  promo code   ${before.promotionCode.join(", ") || "none"}`
    );
    console.log(`  before  usable       ${before.checkoutWouldUse}`);
    console.log("");
    for (const [label, diff] of [
      ["coupon", couponDiff],
      ["promotion code", promotionCodeDiff],
    ]) {
      if (diff.length === 0) {
        console.log(`  proposed ${label}: already stamped`);
      } else {
        for (const entry of diff) {
          console.log(
            `  proposed ${label}: ${entry.key} ${entry.from === null ? "(absent)" : entry.from} -> ${entry.to}`
          );
        }
      }
    }
    console.log("");
    if (applied?.performed) {
      console.log(`  snapshot             ${applied.snapshotPath}`);
      console.log(
        `  after   coupon       ${after.mismatches.coupon.join(", ") || "none"}`
      );
      console.log(
        `  after   promo code   ${after.mismatches.promotionCode.join(", ") || "none"}`
      );
      console.log(`  after   usable       ${after.mismatches.checkoutWouldUse}`);
    } else if (applied) {
      console.log(
        `  apply                performed=false reason=${applied.reason}`
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
