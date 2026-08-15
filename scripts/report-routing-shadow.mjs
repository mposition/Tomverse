// What shadow routing has observed: how much Auto would change, and where.
//
// A report, not a gate, and read-only. Shadow runs record what the Router would
// have chosen beside the model the user actually picked; this reads them back.
//
// The number people will reach for is the agreement rate, so the report says
// plainly what it is and is not. ROUTE-01 grades the Router on a win-rate
// against the fixed-model baseline, measured on an evaluation set. Agreement
// with the user's own choice is not that: a Router that echoed the user would
// agree every time and be worth nothing, and a Router that is right where the
// user was wrong shows up here as disagreement. Agreement measures how much
// would change if Auto were switched on -- the blast radius -- and nothing
// about whether the change would be an improvement.
//
// Usage:
//   npm run report:routing-shadow
//   npm run report:routing-shadow -- --days=7 --json

import { buildShadowReport } from "../lib/routingShadowReport.ts";
import { prisma } from "../lib/prisma.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const asJson = args.includes("--json");
const days = Math.max(1, Number(flag("days", "30")) || 30);
const maxRows = Math.max(1, Number(flag("limit", "200000")) || 200_000);
const since = new Date(Date.now() - days * 86_400_000);

const runs = await prisma.routingRun.findMany({
  where: { mode: "shadow", createdAt: { gte: since } },
  orderBy: { createdAt: "desc" },
  take: maxRows,
  // The columns this reads, and no more. The table is content-free by
  // construction, but a narrow select keeps it that way as the schema grows.
  select: {
    taskProfileVersion: true,
    candidateFilterVersion: true,
    selectionVersion: true,
    profileKind: true,
    plan: true,
    selectedModelId: true,
    selectionReason: true,
    userSelectedModelId: true,
    eligibleCount: true,
    rejectedByReason: true,
    decisionMicros: true,
  },
});

const report = buildShadowReport(
  runs.map((run) => ({
    ...run,
    rejectedByReason:
      run.rejectedByReason && typeof run.rejectedByReason === "object"
        ? run.rejectedByReason
        : {},
  }))
);

const num = (value) => value.toLocaleString("en-US");
const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(2)}%`);
const ms = (micros) => `${(micros / 1000).toFixed(1)}ms`;

if (asJson) {
  console.log(
    JSON.stringify({ windowDays: days, since: since.toISOString(), ...report }, null, 2)
  );
} else {
  console.log(`Shadow routing — last ${days} day(s), since ${since.toISOString()}`);
  console.log(`Runs read: ${num(report.rows)}`);
  console.log("");

  if (report.rows === 0) {
    console.log("No shadow runs. TOMVERSE_ROUTER_SHADOW_ENABLED is off, or no");
    console.log("chat traffic reached the recorder in this window.");
    await prisma.$disconnect();
    process.exit(0);
  }

  if (report.versions.mixed) {
    // Pooling two rule versions into one rate answers about neither of them.
    console.log("MIXED VERSIONS — this sample spans more than one rule version,");
    console.log("so the rates below describe no single Router. Narrow the window");
    console.log("or filter before drawing a conclusion.");
    console.log(`  task profile: ${report.versions.taskProfileVersions.join(", ")}`);
    console.log(`  candidates:   ${report.versions.candidateFilterVersions.join(", ")}`);
    console.log(`  selection:    ${report.versions.selectionVersions.join(", ")}`);
    console.log("");
  }

  console.log(`Decided        ${num(report.decided)}`);
  console.log(
    `Undecided      ${num(report.undecided)}  (no candidate survived the filters)`
  );
  // The ceiling on how much traffic Auto could serve even if every choice it
  // made were perfect. More consequential than the agreement rate, and easy to
  // skip past because it looks like a restatement of "decided".
  console.log(
    `Had a candidate ${pct(report.candidateAvailabilityRate)}  (eligible set p50/p95: ${num(report.eligibleCountP50)} / ${num(report.eligibleCountP95)})`
  );
  console.log(
    `Agreed         ${num(report.agreed)} of ${num(report.decided)}  (${pct(report.agreementRate)})`
  );
  console.log("");

  if (report.switches.length > 0) {
    console.log("Where Auto would move traffic (user chose → Router would):");
    for (const pair of report.switches) {
      console.log(`  ${pair.from}  →  ${pair.to}   ${num(pair.count)}`);
    }
    console.log("");
  }

  const printGroups = (title, groups) => {
    if (groups.length === 0) return;
    console.log(title);
    for (const group of groups) {
      console.log(
        `  ${group.key.padEnd(16)} ${pct(group.agreementRate).padStart(7)}  (${num(group.agreed)}/${num(group.decided)})`
      );
    }
    console.log("");
  };
  printGroups("Agreement by task kind:", report.byTaskKind);
  printGroups("Agreement by plan:", report.byPlan);

  const printCounts = (title, counts) => {
    const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    if (entries.length === 0) return;
    console.log(title);
    for (const [key, count] of entries) {
      console.log(`  ${key.padEnd(30)} ${num(count)}`);
    }
    console.log("");
  };
  // Where Auto would send traffic, not only what it would move. A Router
  // collapsing onto one model shows up here and nowhere else -- the switch
  // pairs above would look busy and healthy while every arrow pointed at the
  // same destination.
  printCounts("Where Auto would land (Router's own choice):", report.selectedModelCounts);
  printCounts("Selection reasons:", report.selectionReasons);
  printCounts("Models refused, by filter:", report.rejectionReasons);

  console.log(
    `Held by stickiness         ${pct(report.stickyHeldRate)} of decided turns`
  );
  console.log(
    "  Every one is a turn where a challenger scored higher and the Router stayed"
  );
  console.log(
    "  put on purpose. Near zero means the margin and hysteresis are doing nothing;"
  );
  console.log("  near one means they are deciding everything.");
  console.log("");

  console.log(
    `Decision latency p50/p95   ${ms(report.decisionMicrosP50)} / ${ms(report.decisionMicrosP95)}   (ROUTE-02 bounds p95 at 300ms)`
  );
  console.log("");
  console.log("Agreement is not a score. ROUTE-01 grades the Router on a win-rate");
  console.log("against the fixed-model baseline, measured on an evaluation set. A");
  console.log("Router that echoed the user would agree every time and be worth");
  console.log("nothing; one that is right where the user was wrong appears here as");
  console.log("disagreement. What this measures is how much would change if Auto");
  console.log("were switched on, not whether the change would be an improvement.");
  console.log("");
  console.log("Not measured here, and not measurable from shadow data at all:");
  console.log("  - answer quality. Shadow records the model the Router would have");
  console.log("    chosen; it never generated that model's answer, so there is no");
  console.log("    pair to compare. ROUTE-01 needs a paired evaluation set and a");
  console.log("    95% confidence interval, run separately.");
  console.log("  - regional bias. Region is an input to the filters but is not a");
  console.log("    column on RoutingRun, so it cannot be grouped by here. Recording");
  console.log("    it is a schema change, not a query change.");
  console.log("");
  console.log("A limited Auto cohort needs three separate passes, and this report is");
  console.log("one of them:");
  console.log("  [ this ] shadow operating figures acceptable");
  console.log("  [  -   ] offline decision-grade quality evaluation passed (ROUTE-01)");
  console.log("  [  -   ] attempt/manifest dispatch boundary passed (ROUTE-06)");
  console.log("Any one missing means the answer is still shadow.");
}

await prisma.$disconnect();
