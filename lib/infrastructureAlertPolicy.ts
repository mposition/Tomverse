import type { InfrastructureStatus } from "./infrastructureTypes";

// Pure alerting policy for the infrastructure threshold monitor. No Prisma,
// Next.js, or network dependencies so the routing decisions stay unit-testable.

export type InfrastructureWarningReason = {
  code: string;
  detail: string;
};

export type InfrastructureDependencySignal = {
  status: InfrastructureStatus;
  message: string;
  warningReasons?: readonly InfrastructureWarningReason[];
};

export type InfrastructureDashboardSignals = {
  railway: InfrastructureDependencySignal;
  r2: InfrastructureDependencySignal;
  database: InfrastructureDependencySignal;
  prismaUsage: InfrastructureDependencySignal;
};

/**
 * Warning reason codes that are dashboard-only advisories: application-side
 * estimates surfaced on the Admin Infrastructure tab and in scheduled reports,
 * but never delivered through the real-time incident channels (Sentry, Resend
 * email, Slack/Discord webhooks).
 *
 * Fail-safe: only codes listed here are suppressed. A warning whose reasons
 * are missing, empty, unknown, or mixed with a non-advisory code is still
 * reported as an incident, so newly introduced warnings alert by default.
 */
export const DASHBOARD_ONLY_WARNING_REASON_CODES: Readonly<
  Record<string, readonly string[]>
> = {
  railway: ["PROJECTED_BALANCE_LOW"],
};

export type InfrastructureAlertClassification =
  | "incident"
  | "dashboard_advisory"
  | "none";

export type InfrastructureIncidentReport = {
  dependency: string;
  code: string;
  title: string;
  error: string;
  severity: "warning" | "fatal";
};

export type InfrastructureAlertDecision = {
  dependency: string;
  status: InfrastructureStatus;
  classification: InfrastructureAlertClassification;
  incident: InfrastructureIncidentReport | null;
  suppressedReasonCodes: string[];
};

export const classifyInfrastructureDependency = (
  dependency: string,
  signal: InfrastructureDependencySignal
): InfrastructureAlertDecision => {
  const base = {
    dependency,
    status: signal.status,
    suppressedReasonCodes: [] as string[],
  };
  if (signal.status !== "warning" && signal.status !== "error") {
    return { ...base, classification: "none", incident: null };
  }
  if (signal.status === "warning") {
    const dashboardOnlyCodes =
      DASHBOARD_ONLY_WARNING_REASON_CODES[dependency] || [];
    const reasons = signal.warningReasons || [];
    const advisoryOnly =
      reasons.length > 0 &&
      reasons.every((reason) => dashboardOnlyCodes.includes(reason.code));
    if (advisoryOnly) {
      return {
        ...base,
        classification: "dashboard_advisory",
        incident: null,
        suppressedReasonCodes: reasons.map((reason) => reason.code),
      };
    }
  }
  return {
    ...base,
    classification: "incident",
    incident: {
      dependency,
      code: `INFRASTRUCTURE_${dependency.toUpperCase()}_${signal.status.toUpperCase()}`,
      title: `${dependency} infrastructure is ${signal.status}`,
      error: signal.message,
      severity: signal.status === "error" ? "fatal" : "warning",
    },
  };
};

export type InfrastructureAlertPlan = {
  decisions: InfrastructureAlertDecision[];
  incidents: InfrastructureIncidentReport[];
  advisories: Array<{ dependency: string; reasonCodes: string[] }>;
  statuses: Record<string, InfrastructureStatus>;
};

export const planInfrastructureAlerts = (
  dashboard: InfrastructureDashboardSignals
): InfrastructureAlertPlan => {
  // Dependency labels feed the incident code (`INFRASTRUCTURE_PRISMA_WARNING`),
  // so the dashboard key `prismaUsage` keeps its historical `prisma` label.
  const decisions = (
    [
      ["railway", dashboard.railway],
      ["r2", dashboard.r2],
      ["database", dashboard.database],
      ["prisma", dashboard.prismaUsage],
    ] as const
  ).map(([dependency, signal]) =>
    classifyInfrastructureDependency(dependency, signal)
  );
  return {
    decisions,
    incidents: decisions.flatMap((decision) =>
      decision.incident ? [decision.incident] : []
    ),
    advisories: decisions.flatMap((decision) =>
      decision.classification === "dashboard_advisory"
        ? [
            {
              dependency: decision.dependency,
              reasonCodes: decision.suppressedReasonCodes,
            },
          ]
        : []
    ),
    statuses: Object.fromEntries(
      decisions.map((decision) => [decision.dependency, decision.status])
    ),
  };
};
