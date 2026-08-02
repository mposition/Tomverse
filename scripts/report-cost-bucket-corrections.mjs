// Read-only report: cost booked at a price the registry has since corrected.
//
//   npm run report:cost-bucket-corrections
//   npm run report:cost-bucket-corrections -- --days=90 --json
//
// Produces correction *candidates* and nothing else. It does not touch
// ChatUsageBucket, does not adjust a counter, does not settle or re-settle a
// reservation, and never will from here: a settled reservation stores the
// pricingVersion it was priced under so that a later price change is not
// retroactive, and unwinding that in a script would erase the only record of
// what was charged at the time.
//
// What the numbers mean: `booked` is what the operational counter was
// increased by, `expected` is the same tokens repriced at today's registry
// rate, and the difference is the gap an accountant reconciles against the
// provider's actual invoice. A period still accruing is listed first, because
// that is the only one where an overstated figure is currently rejecting
// requests rather than merely being wrong in a report.
//
// Requires DATABASE_URL. Point it at a read-only role.

import { buildCorrectionCandidates } from "../lib/costBucketCorrectionCore.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { getModel } from "../lib/models.ts";
import { prisma } from "../lib/prisma.ts";

const argValue = (name, fallback) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const json = process.argv.includes("--json");
const days = Math.min(365, Math.max(1, Number(argValue("days", "30")) || 30));

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is required. Use a read-only role: this reads settled reservations and writes nothing."
  );
  process.exit(1);
}

const now = new Date();
const since = new Date(now.getTime() - days * 86_400_000);

// Which window each period is currently accruing into, so an open period can
// be told from a closed one.
const startOfUtcDay = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
).toISOString();
const startOfUtcMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
).toISOString();
const currentPeriodStarts = {
  "cost-day": startOfUtcDay,
  "op-cost-day": startOfUtcDay,
  "provider-cost-day": startOfUtcDay,
  "cost-month": startOfUtcMonth,
  "op-cost-month": startOfUtcMonth,
  "provider-cost-month": startOfUtcMonth,
};

const periodStartFor = (period, settledAt) => {
  const date = new Date(settledAt);
  return period.endsWith("-month")
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
    : new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      ).toISOString();
};

try {
  const rows = await prisma.chatCreditReservation.findMany({
    where: { status: "settled", settledAt: { gte: since } },
    select: {
      modelId: true,
      settledAt: true,
      settledCostMicroUsd: true,
      settledInputTokens: true,
      settledCachedInputTokens: true,
      settledOutputTokens: true,
      pricingSnapshot: true,
    },
  });

  // One settled reservation books into both the day and the month counter, so
  // it appears once per period rather than being attributed to one of them.
  const PERIODS = ["op-cost-day", "op-cost-month"];
  const samples = rows.flatMap((row) => {
    const snapshot =
      row.pricingSnapshot && typeof row.pricingSnapshot === "object"
        ? row.pricingSnapshot
        : {};
    const settledAt = row.settledAt?.toISOString() ?? since.toISOString();
    return PERIODS.map((period) => ({
      modelId: row.modelId,
      period,
      periodStart: periodStartFor(period, settledAt),
      pricingVersion:
        typeof snapshot.pricingVersion === "string"
          ? snapshot.pricingVersion
          : "unrecorded",
      costSource:
        typeof snapshot.reservationCostSource === "string"
          ? snapshot.reservationCostSource
          : typeof snapshot.costSource === "string"
            ? snapshot.costSource
            : "unrecorded",
      bookedCostMicroUsd: Number(row.settledCostMicroUsd),
      settledInputTokens: row.settledInputTokens,
      settledCachedInputTokens: row.settledCachedInputTokens,
      settledOutputTokens: row.settledOutputTokens,
    }));
  });

  const priceForModel = (modelId) => {
    const model = getModel(modelId);
    if (!model) return null;
    const pricing = resolveModelPricing(model);
    return {
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
      cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
      pricingVersion: pricing.pricingVersion,
    };
  };

  const candidates = buildCorrectionCandidates({
    samples,
    priceForModel,
    currentPeriodStarts,
    // Below a hundredth of a cent the difference is rounding, not a price.
    minimumDifferenceMicroUsd: 100,
  });

  const unpriceable = Array.from(
    new Set(samples.filter((s) => !priceForModel(s.modelId)).map((s) => s.modelId))
  );

  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: now.toISOString(),
          windowDays: days,
          settledReservations: rows.length,
          currentPeriodStarts,
          candidates,
          unpriceableModelIds: unpriceable,
          appliesAnything: false,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      `Cost bucket correction candidates -- last ${days} day(s), ${rows.length} settled reservation(s)\n`
    );
    if (candidates.length === 0) {
      console.log(
        "  Nothing to reconcile: every settled reservation's booked cost matches its tokens\n" +
          "  repriced at today's registry rate, to within a hundredth of a cent."
      );
    }
    for (const candidate of candidates) {
      console.log(
        `  ${candidate.isCurrentBlock ? "[CURRENT BLOCK] " : ""}${candidate.period} ` +
          `${candidate.periodStart.slice(0, 10)}  ${candidate.modelId}`
      );
      console.log(
        `      pricingVersion=${candidate.pricingVersion}  costSource=${candidate.costSource}  n=${candidate.reservationCount}`
      );
      console.log(
        `      booked   US$${(candidate.bookedCostMicroUsd / 1e6).toFixed(6)}\n` +
          `      expected US$${(candidate.expectedCostMicroUsd / 1e6).toFixed(6)}\n` +
          `      diff     US$${(candidate.differenceMicroUsd / 1e6).toFixed(6)}` +
          (candidate.overstatementRatio === null
            ? ""
            : `  (${(candidate.overstatementRatio * 100).toFixed(1)}%)`)
      );
    }
    if (unpriceable.length > 0) {
      console.log(
        `\n  ${unpriceable.length} model id(s) are not in the current catalogue and were skipped ` +
          `rather than repriced against a guess: ${unpriceable.join(", ")}`
      );
    }
    console.log(
      "\nThese are candidates, not corrections. Reconcile each against the provider's own\n" +
        "invoice before adjusting anything, and adjust the counter through an operational\n" +
        "procedure with its own record -- never by editing settled reservations, whose\n" +
        "pricingVersion is the only remaining evidence of what was charged at the time."
    );
  }
} catch (error) {
  const message = String(error?.message || error).replaceAll(
    process.env.DATABASE_URL,
    "[redacted]"
  );
  console.error(`Could not build correction candidates: ${message.slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
