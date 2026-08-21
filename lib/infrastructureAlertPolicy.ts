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

/**
 * What each probe actually measures, for the sentence a human reads.
 *
 * The dependency label is an identifier: it builds `INFRASTRUCTURE_R2_ERROR`,
 * which the cooldown keys off and which operators grep for, so it cannot
 * change. The *title* is prose, and "r2 infrastructure is error" was prose
 * that claimed something untrue. None of the three usage probes touches the
 * service it is named after -- `r2Snapshot` only reads Cloudflare's GraphQL
 * analytics, never a bucket -- so a rejected analytics token was paging the
 * on-call with a sentence that reads as "user attachments are down". Uploads
 * were healthy throughout: they authenticate with `R2_ACCESS_KEY_ID` /
 * `R2_SECRET_ACCESS_KEY` against the S3 endpoint and share nothing with
 * `CLOUDFLARE_API_TOKEN`.
 *
 * A dependency with no entry here falls back to the old wording rather than
 * being dropped, so adding a probe cannot silently produce a nameless alert.
 */
export const INFRASTRUCTURE_DEPENDENCY_SUBJECTS: Readonly<
  Record<string, string>
> = {
  railway: "Railway usage analytics",
  r2: "Cloudflare R2 usage analytics",
  prisma: "Prisma Postgres usage analytics",
  database: "Application database inventory",
};

export const infrastructureIncidentTitle = (
  dependency: string,
  status: "warning" | "error"
) => {
  const subject = INFRASTRUCTURE_DEPENDENCY_SUBJECTS[dependency];
  if (!subject) return `${dependency} infrastructure is ${status}`;
  return status === "error"
    ? `${subject} read failed`
    : `${subject} reported a warning`;
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
  /**
   * The reason codes the probe already worked out (`R2_API_ERROR` vs
   * `R2_USAGE_API_UNAVAILABLE`). They were computed and then thrown away at
   * this boundary, so the alert carried the upstream's bare sentence -- "not
   * authorized for that account" -- with nothing naming which credential it
   * came from. Empty when the probe supplied none.
   */
  reasonCodes: string[];
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
  // `healthy`, `unconfigured` and `disabled` are all non-events: an operator
  // switching a monitor off for an environment must not page Sentry, Resend or
  // Slack/Discord, and must not be re-routed through the warning path below.
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
      title: infrastructureIncidentTitle(dependency, signal.status),
      error: signal.message,
      severity: signal.status === "error" ? "fatal" : "warning",
      reasonCodes: (signal.warningReasons || []).map((reason) => reason.code),
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
