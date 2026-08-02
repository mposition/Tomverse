// Read-only output-token distributions per model, with policy 3.1's nine
// conditions checked against the sample.
//
//   npm run report:output-token-telemetry
//   npm run report:output-token-telemetry -- --days=30 --json
//   npm run report:output-token-telemetry -- --models=gpt-5-6-luna,gpt-5-4-mini
//
// Reads settled ChatCreditReservation rows. Writes nothing, anywhere. It does
// not change `reservationOutputBasis`, and it never will: adopting a p90 needs
// a separate approval, a new pricingVersion and its own pull request, because
// the same rates sized on a different basis are not comparable to what came
// before. What this produces is the evidence that decision would rest on.
//
// Requires DATABASE_URL. Point it at a read-only role.

import {
  MIN_SAMPLES_PER_MODEL,
  MIN_WINDOW_DAYS,
  reportModelOutputTokens,
} from "../lib/outputTokenTelemetryCore.ts";
import { prisma } from "../lib/prisma.ts";

const argValue = (name, fallback) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const json = process.argv.includes("--json");
const days = Math.min(365, Math.max(1, Number(argValue("days", "30")) || 30));
const requestedModels = argValue("models", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is required. Use a read-only role: this reads settled reservations and writes nothing."
  );
  process.exit(1);
}

const since = new Date(Date.now() - days * 86_400_000);

try {
  const rows = await prisma.chatCreditReservation.findMany({
    where: {
      status: "settled",
      settledAt: { gte: since },
      ...(requestedModels.length > 0 ? { modelId: { in: requestedModels } } : {}),
    },
    select: {
      modelId: true,
      source: true,
      outcome: true,
      settledAt: true,
      settledOutputTokens: true,
      settledCostMicroUsd: true,
      pricingSnapshot: true,
      reservationPayload: true,
    },
  });

  const samples = rows.map((row) => {
    const snapshot =
      row.pricingSnapshot && typeof row.pricingSnapshot === "object"
        ? row.pricingSnapshot
        : {};
    const payload =
      row.reservationPayload && typeof row.reservationPayload === "object"
        ? row.reservationPayload
        : {};
    return {
      modelId: row.modelId,
      outputTokens: row.settledOutputTokens,
      settledAt: row.settledAt?.toISOString() ?? new Date(0).toISOString(),
      workload: row.source,
      reasoningEffort:
        typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : null,
      // A settled row that cost nothing did not consume the reservation it
      // was sized for, so it is not evidence about how large one should be.
      billed: Number(row.settledCostMicroUsd) > 0,
      // Cancelled and capped answers stay in: the reservation was taken for
      // them, and dropping them would systematically understate the tail.
      partial: row.outcome === "cancelled" || row.outcome === "partial",
      usageSource:
        snapshot.usageSource === "provider_reported" ||
        snapshot.usageSource === "provider"
          ? "provider_reported"
          : snapshot.usageSource === undefined
            ? "estimated"
            : "estimated",
    };
  });

  const modelIds = Array.from(new Set(samples.map((sample) => sample.modelId))).sort();
  const reports = modelIds.map((modelId) =>
    reportModelOutputTokens({ modelId, samples })
  );

  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          windowDays: days,
          since: since.toISOString(),
          totalSettledRows: rows.length,
          reports,
          appliesAnything: false,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      `Output-token telemetry -- last ${days} day(s), ${rows.length} settled reservation(s)\n`
    );
    if (reports.length === 0) {
      console.log(
        "  No settled reservations in this window. Nothing can be concluded about any model's\n" +
          "  output distribution, which is itself the finding: reservationOutputBasis stays\n" +
          "  conservative_default until there is data."
      );
    }
    for (const report of reports) {
      console.log(`  ${report.modelId}`);
      console.log(
        `    n=${report.overall.count}  p50=${report.overall.p50}  p90=${report.overall.p90}  ` +
          `p95=${report.overall.p95}  p99=${report.overall.p99}  max=${report.overall.max}`
      );
      console.log(
        `    window ${report.windowStart ?? "-"} .. ${report.windowEnd ?? "-"} ` +
          `(${report.windowDays === null ? "-" : report.windowDays.toFixed(1)} days)`
      );
      for (const entry of report.byWorkload) {
        console.log(
          `      ${entry.workload.padEnd(22)} n=${String(entry.percentiles.count).padStart(6)} ` +
            `p50=${entry.percentiles.p50} p90=${entry.percentiles.p90} p95=${entry.percentiles.p95}`
        );
      }
      console.log("    policy 3.1 conditions:");
      for (const condition of report.conditions) {
        const mark =
          condition.satisfied === true
            ? "PASS"
            : condition.satisfied === false
              ? "FAIL"
              : "HUMAN";
        console.log(`      [${mark}] ${condition.code}: ${condition.detail}`);
      }
      console.log(
        `    reservationOutputBasis stays: ${report.recommendedBasis}` +
          (report.blockers.length > 0
            ? ` (${report.blockers.length} measurable condition(s) unmet)`
            : " (measurable conditions met; the three human ones are not)")
      );
      console.log("");
    }
    console.log(
      `Reminder: >=${MIN_SAMPLES_PER_MODEL} settled answers over >=${MIN_WINDOW_DAYS} continuous days is the\n` +
        "sample floor, and clearing it is still not authority to change anything. Applying a\n" +
        "p90 basis is a separate change with a new pricingVersion and its own approval."
    );
  }
} catch (error) {
  const message = String(error?.message || error).replaceAll(
    process.env.DATABASE_URL,
    "[redacted]"
  );
  console.error(`Could not read telemetry: ${message.slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
