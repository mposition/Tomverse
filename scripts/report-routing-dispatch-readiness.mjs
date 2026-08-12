// What step 2 of the Router rollout is supposed to establish, as numbers.
//
// The plan is explicit that reviewing this report and switching Auto on are
// separate decisions, so this deliberately answers only the questions
// instrumentation on the manual path can answer:
//
//   - recording rate: what fraction of dispatches produced a record at all;
//   - manifest coverage: ROUTE-06's own number, computed the way the gate
//     computes it;
//   - lifecycle: how many manifests are stuck in `draft`, which is the state
//     that means a preparation neither finished nor was abandoned;
//   - estimate error: how far the reserved input figure was from what the
//     provider reported, signed, because over- and under-reserving are
//     different failures;
//   - added latency: what the extra writes cost before the provider call.
//
// It cannot answer whether Auto's choices are good. That needs the paired
// evaluation set and its confidence interval, which is a different exercise
// with a different gate (ROUTE-01), and reading this report as if it settled
// quality is the mistake the separation exists to prevent.

import { prisma } from "../lib/prisma.ts";

const WINDOW_DAYS = Number(process.env.ROUTING_READINESS_WINDOW_DAYS || 7);
const MODES = ["manual", "shadow", "auto"];

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is required. This report reads recorded runs; it does not simulate them."
  );
  process.exit(1);
}

const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1_000);
const pct = (part, whole) => (whole === 0 ? null : (part / whole) * 100);
const show = (value, unit = "%") =>
  value === null ? "n/a (no rows)" : `${value.toFixed(1)}${unit}`;

try {
  const runs = await prisma.routingRun.groupBy({
    by: ["mode"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  const runsByMode = Object.fromEntries(runs.map((row) => [row.mode, row._count._all]));

  console.log(`Routing dispatch readiness — last ${WINDOW_DAYS} day(s)\n`);
  console.log("Runs recorded");
  for (const mode of MODES) console.log(`  ${mode.padEnd(8)} ${runsByMode[mode] ?? 0}`);

  const [dispatched, covered, drafts, notDispatched, attempts] = await Promise.all([
    prisma.routingAttempt.count({
      where: { createdAt: { gte: since }, dispatchedAt: { not: null } },
    }),
    prisma.routingAttempt.count({
      where: {
        createdAt: { gte: since },
        dispatchedAt: { not: null },
        manifest: { is: { state: "finalized" } },
      },
    }),
    prisma.contextManifest.count({ where: { createdAt: { gte: since }, state: "draft" } }),
    prisma.routingAttempt.count({
      where: { createdAt: { gte: since }, outcome: "not_dispatched" },
    }),
    prisma.routingAttempt.count({ where: { createdAt: { gte: since } } }),
  ]);

  console.log("\nROUTE-06 — every dispatched attempt references its own finalized manifest");
  console.log(`  dispatched attempts   ${dispatched}`);
  console.log(`  with finalized manifest ${covered}`);
  console.log(`  coverage              ${show(pct(covered, dispatched))}`);
  if (dispatched > 0 && covered < dispatched) {
    console.log(
      "  ^ below 100%. The CHECK should make this impossible, so a shortfall means a\n" +
        "    constraint was dropped in a migration rather than that a write was missed."
    );
  }

  console.log("\nManifest lifecycle");
  console.log(`  attempts              ${attempts}`);
  console.log(`  not_dispatched        ${notDispatched}`);
  console.log(`  still draft           ${drafts}`);
  if (drafts > 0) {
    console.log(
      "  ^ a draft that is neither finalized nor abandoned is a preparation nobody\n" +
        "    closed. In-flight requests explain a few; a standing count does not."
    );
  }

  // Estimate error, from the runs that have a provider-reported figure.
  const settled = await prisma.routingAttempt.findMany({
    where: { createdAt: { gte: since }, actualInputTokens: { not: null } },
    select: { actualInputTokens: true, run: { select: { reservedInputTokens: true } } },
    take: 50_000,
  });
  console.log("\nInput estimate versus provider-reported usage");
  if (settled.length === 0) {
    console.log("  no settled attempts with provider usage in this window");
  } else {
    const errors = settled
      .map((row) => (row.actualInputTokens ?? 0) - row.run.reservedInputTokens)
      .sort((left, right) => left - right);
    const at = (q) => errors[Math.min(errors.length - 1, Math.floor(errors.length * q))];
    const over = errors.filter((error) => error > 0).length;
    console.log(`  samples               ${errors.length}`);
    console.log(`  p05 / p50 / p95       ${at(0.05)} / ${at(0.5)} / ${at(0.95)} tokens`);
    console.log(
      `  under-reserved        ${show(pct(over, errors.length))} of attempts sent more than was reserved`
    );
  }

  // What the instrumentation itself cost before the provider call. On a manual
  // run no routing decision was made, so decisionMicros is that overhead alone.
  const manual = await prisma.routingRun.findMany({
    where: { createdAt: { gte: since }, mode: "manual" },
    select: { decisionMicros: true, firstTokenMs: true },
    take: 50_000,
  });
  console.log("\nAdded latency before dispatch (manual runs)");
  if (manual.length === 0) {
    console.log("  no manual runs in this window");
  } else {
    const overhead = manual.map((row) => row.decisionMicros / 1_000).sort((a, b) => a - b);
    const at = (q) => overhead[Math.min(overhead.length - 1, Math.floor(overhead.length * q))];
    console.log(`  samples               ${overhead.length}`);
    console.log(`  p50 / p95 / p99       ${at(0.5).toFixed(1)} / ${at(0.95).toFixed(1)} / ${at(0.99).toFixed(1)} ms`);
    console.log(
      "  ^ this is time added before the provider call, so it lands directly on\n" +
        "    time-to-first-token. It is the figure that decides whether enforce is\n" +
        "    affordable, not whether it is correct."
    );
  }

  console.log(
    "\nThis report covers operational readiness only. Answer quality needs the paired\n" +
      "evaluation set and its confidence interval (ROUTE-01); a limited Auto cohort\n" +
      "requires that, this, and the attempt/manifest boundary all passing separately."
  );
} finally {
  await prisma.$disconnect();
}
