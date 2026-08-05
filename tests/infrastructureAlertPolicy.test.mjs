import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_ONLY_WARNING_REASON_CODES,
  classifyInfrastructureDependency,
  planInfrastructureAlerts,
} from "../lib/infrastructureAlertPolicy.ts";

// The regression this guards: Railway's PROJECTED_BALANCE_LOW is an
// application-side estimate against an admin-saved credit checkpoint, not an
// outage. It used to re-create an operational incident (Sentry + Resend +
// Slack/Discord) every 30 minutes for as long as the estimate stayed low.
// The policy must keep it on the dashboard while every actionable
// infrastructure failure keeps alerting exactly as before.

const healthy = { status: "healthy", message: "ok" };

const railwayAdvisory = (overrides = {}) => ({
  status: "warning",
  message:
    "Railway usage was synchronized, but projected remaining credit is below 20%.",
  warningReasons: [
    {
      code: "PROJECTED_BALANCE_LOW",
      detail:
        "Projected remaining credit is negative or below 20% of the saved opening credit.",
    },
  ],
  ...overrides,
});

const dashboard = (overrides = {}) => ({
  railway: healthy,
  r2: healthy,
  database: healthy,
  prismaUsage: healthy,
  ...overrides,
});

test("railway PROJECTED_BALANCE_LOW warning is a dashboard-only advisory", () => {
  const plan = planInfrastructureAlerts(dashboard({ railway: railwayAdvisory() }));
  assert.equal(plan.incidents.length, 0);
  assert.deepEqual(plan.advisories, [
    { dependency: "railway", reasonCodes: ["PROJECTED_BALANCE_LOW"] },
  ]);
  // The dashboard keeps showing the warning: the decision preserves the
  // warning status instead of downgrading or clearing it.
  assert.equal(plan.statuses.railway, "warning");
  const decision = plan.decisions.find((entry) => entry.dependency === "railway");
  assert.equal(decision.classification, "dashboard_advisory");
  assert.equal(decision.status, "warning");
});

test("advisory classification does not mutate the snapshot", () => {
  const snapshot = railwayAdvisory();
  planInfrastructureAlerts(dashboard({ railway: snapshot }));
  assert.equal(snapshot.status, "warning");
  assert.deepEqual(
    snapshot.warningReasons.map((reason) => reason.code),
    ["PROJECTED_BALANCE_LOW"]
  );
});

test("railway API error still reports a fatal incident", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: {
        status: "error",
        message: "Railway API returned 500.",
        warningReasons: [
          { code: "RAILWAY_API_ERROR", detail: "Railway API returned 500." },
        ],
      },
    })
  );
  assert.deepEqual(plan.incidents, [
    {
      dependency: "railway",
      code: "INFRASTRUCTURE_RAILWAY_ERROR",
      title: "railway infrastructure is error",
      error: "Railway API returned 500.",
      severity: "fatal",
    },
  ]);
  assert.equal(plan.advisories.length, 0);
});

test("an unknown new railway warning reason fails safe to an incident", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: railwayAdvisory({
        warningReasons: [
          { code: "SOME_NEW_WARNING", detail: "A future warning nobody vetted." },
        ],
      }),
    })
  );
  assert.equal(plan.incidents.length, 1);
  assert.equal(plan.incidents[0].code, "INFRASTRUCTURE_RAILWAY_WARNING");
  assert.equal(plan.incidents[0].severity, "warning");
  assert.equal(plan.advisories.length, 0);
});

test("an advisory mixed with a non-advisory reason still alerts", () => {
  const decision = classifyInfrastructureDependency(
    "railway",
    railwayAdvisory({
      warningReasons: [
        { code: "PROJECTED_BALANCE_LOW", detail: "estimate" },
        { code: "SOME_NEW_WARNING", detail: "unvetted" },
      ],
    })
  );
  assert.equal(decision.classification, "incident");
  assert.equal(decision.suppressedReasonCodes.length, 0);
});

test("a warning without reason codes fails safe to an incident", () => {
  for (const warningReasons of [[], undefined]) {
    const decision = classifyInfrastructureDependency(
      "railway",
      railwayAdvisory({ warningReasons })
    );
    assert.equal(decision.classification, "incident");
    assert.equal(decision.incident.code, "INFRASTRUCTURE_RAILWAY_WARNING");
  }
});

test("OPENING_CREDIT_NOT_CONFIGURED keeps its existing alerting behaviour", () => {
  const decision = classifyInfrastructureDependency(
    "railway",
    railwayAdvisory({
      message:
        "Railway usage was synchronized; configure an opening credit to calculate projected balance.",
      warningReasons: [
        {
          code: "OPENING_CREDIT_NOT_CONFIGURED",
          detail: "No opening credit is saved.",
        },
      ],
    })
  );
  assert.equal(decision.classification, "incident");
});

test("R2, database and Prisma warnings and errors still alert", () => {
  const expectations = [
    ["r2", "warning", "INFRASTRUCTURE_R2_WARNING", "warning"],
    ["database", "warning", "INFRASTRUCTURE_DATABASE_WARNING", "warning"],
    ["database", "error", "INFRASTRUCTURE_DATABASE_ERROR", "fatal"],
    ["prismaUsage", "warning", "INFRASTRUCTURE_PRISMA_WARNING", "warning"],
    ["prismaUsage", "error", "INFRASTRUCTURE_PRISMA_ERROR", "fatal"],
  ];
  for (const [key, status, code, severity] of expectations) {
    const plan = planInfrastructureAlerts(
      dashboard({ [key]: { status, message: `${key} ${status}` } })
    );
    assert.equal(plan.incidents.length, 1, code);
    assert.equal(plan.incidents[0].code, code);
    assert.equal(plan.incidents[0].severity, severity);
    assert.equal(plan.advisories.length, 0);
  }
});

test("healthy and unconfigured dependencies produce nothing", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: { status: "unconfigured", message: "Add RAILWAY_API_TOKEN." },
    })
  );
  assert.equal(plan.incidents.length, 0);
  assert.equal(plan.advisories.length, 0);
  assert.deepEqual(
    plan.decisions.map((decision) => decision.classification),
    ["none", "none", "none", "none"]
  );
});

test("a disabled railway monitor produces no incident and no advisory", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: {
        status: "disabled",
        message: "Railway usage monitoring is disabled for this environment.",
      },
    })
  );
  assert.equal(plan.incidents.length, 0);
  assert.equal(plan.advisories.length, 0);
  // The status stays visible on the dashboard rather than being downgraded to
  // healthy, and it is not conflated with a missing-token unconfigured state.
  assert.equal(plan.statuses.railway, "disabled");
  const decision = plan.decisions.find((entry) => entry.dependency === "railway");
  assert.equal(decision.classification, "none");
  assert.equal(decision.incident, null);
});

test("switching one monitor off leaves the other dependencies alerting", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: {
        status: "disabled",
        message: "Railway usage monitoring is disabled for this environment.",
      },
      r2: { status: "warning", message: "R2 metric above 80%." },
      database: { status: "error", message: "Database unreachable." },
    })
  );
  assert.deepEqual(
    plan.incidents.map((incident) => incident.code).sort(),
    ["INFRASTRUCTURE_DATABASE_ERROR", "INFRASTRUCTURE_R2_WARNING"]
  );
});

test("a suppressed advisory never counts toward reported incidents", () => {
  const plan = planInfrastructureAlerts(
    dashboard({
      railway: railwayAdvisory(),
      r2: { status: "warning", message: "R2 metric above 80%." },
    })
  );
  assert.equal(plan.incidents.length, 1);
  assert.equal(plan.incidents[0].code, "INFRASTRUCTURE_R2_WARNING");
  assert.deepEqual(plan.advisories, [
    { dependency: "railway", reasonCodes: ["PROJECTED_BALANCE_LOW"] },
  ]);
});

test("dashboard-only registry stays scoped to vetted railway advisories", () => {
  assert.deepEqual(DASHBOARD_ONLY_WARNING_REASON_CODES, {
    railway: ["PROJECTED_BALANCE_LOW"],
  });
});
