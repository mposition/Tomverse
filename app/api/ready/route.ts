export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";
import { reportOperationalDependencyStatus } from "@/lib/operationalMonitoring";
import { getImageProviderBudgetReadiness } from "@/lib/imageProviderBudgetReadiness";
import { getSendingIdentityReadiness } from "@/lib/emailSendingIdentity";
import { AVAILABLE_MODELS } from "@/lib/models";
import {
  getActiveProviders,
  getProviderBudgetReadiness,
} from "@/lib/providerCostBudget";

const DATABASE_CHECK_TIMEOUT_MS = 5_000;
const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const checkDatabase = async () => {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Database readiness check timed out.")),
        DATABASE_CHECK_TIMEOUT_MS
      );
    });
    const result = await Promise.race([
      prisma.$queryRaw<Array<{ ready: number }>>`SELECT 1 AS "ready"`,
      timeoutPromise,
    ]);
    return {
      ready: result[0]?.ready === 1,
      error: undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ready: false,
      error,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const readinessResponse = async (head = false) => {
  const traceId = randomUUID();
  const databaseResult = await checkDatabase();
  const securityStatus = getSecurityEnvironmentStatus();
  const securityEnvironment =
    process.env.NODE_ENV !== "production" || securityStatus.ready;
  // A provider budget is a global cap: misconfigured, it refuses every user of
  // that provider at once. Refusing traffic here is the cheaper failure.
  const budgetStatus = getProviderBudgetReadiness(
    getActiveProviders(AVAILABLE_MODELS)
  );
  const providerBudgets = budgetStatus.ready;
  // The image budget gates readiness only while the image generation flag is
  // ON: "flag off, budget absent" is the legal intermediate state of the
  // env-first deploy order (docs/policy/image-generation.md section 8). That
  // state is decided inside the function, which returns ready, so a thrown
  // error is never it -- it means the derivation itself failed, and the honest
  // answer to "is the budget usable?" is that nobody knows.
  //
  // This used to read `status?.ready ?? true`, which answered that question
  // with "yes". A missing environment variable was fatal while the check that
  // finds missing environment variables blowing up was healthy, so the louder
  // the failure the quieter the endpoint.
  const imageBudgetStatus = await getImageProviderBudgetReadiness().then(
    (status) => ({ status, error: null as string | null }),
    (error: unknown) => ({
      status: null,
      error:
        error instanceof Error
          ? error.message
          : "The image provider budget readiness check threw.",
    })
  );
  const imageProviderBudget = imageBudgetStatus.status?.ready ?? false;
  // The sending domains. Errors here are configurations that would send from
  // the wrong domain or from nothing at all; the outstanding move of
  // transactional mail onto its own subdomain
  // (docs/policy/email-notifications.md §14.1) is a warning, because gating on
  // it would refuse readiness on today's deployment in order to announce a
  // planned migration.
  const sendingIdentity = getSendingIdentityReadiness();
  const emailSendingIdentity = sendingIdentity.ready;
  const database = databaseResult.ready;
  const ready =
    database && securityEnvironment && providerBudgets &&
    imageProviderBudget && emailSendingIdentity;
  const headers = ready
    ? { ...baseHeaders, "X-Tomverse-Trace-Id": traceId }
    : {
        ...baseHeaders,
        "Retry-After": "5",
        "X-Tomverse-Trace-Id": traceId,
      };

  const failedSecurityChecks = Object.entries(securityStatus.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  after(async () => {
    await Promise.all([
      reportOperationalDependencyStatus({
        dependency: "postgresql",
        healthy: database,
        code: "DATABASE_READINESS_FAILED",
        title: "Database readiness check failed",
        error:
          databaseResult.error ||
          (database ? "Database is healthy." : "SELECT 1 returned no ready row."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          durationMs: databaseResult.durationMs,
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "provider-cost-budgets",
        healthy: providerBudgets,
        code: "PROVIDER_COST_BUDGET_NOT_READY",
        title: "Provider spend budgets are not configured correctly",
        error:
          budgetStatus.errors.length > 0
            ? budgetStatus.errors.map((problem) => problem.message).join(" | ")
            : "Provider spend budgets are configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          failedProviders:
            [
              ...new Set(budgetStatus.errors.map((problem) => problem.provider)),
            ].join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "image-provider-cost-budget",
        healthy: imageProviderBudget,
        code: "IMAGE_PROVIDER_COST_BUDGET_NOT_READY",
        title: "Image provider spend budget is not configured correctly",
        error: imageProviderBudget
          ? "Image provider budget is configured (or the feature flag is off)."
          : imageBudgetStatus.error ??
            ((imageBudgetStatus.status?.providers ?? [])
              .flatMap((entry) =>
                entry.resolved.problems.map(
                  (problem) => `${entry.provider}: ${problem.message}`
                )
              )
              .join(" | ") ||
              "Image generation is enabled but its provider budget is unusable."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          imageBudgetCheckThrew: imageBudgetStatus.error !== null,
          imageGenerationFlagEnabled:
            imageBudgetStatus.status?.flagEnabled ?? false,
          imageProviders:
            (imageBudgetStatus.status?.providers ?? [])
              .map((entry) => entry.provider)
              .join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-sending-identity",
        healthy: emailSendingIdentity,
        code: "EMAIL_SENDING_IDENTITY_NOT_READY",
        title: "Email sending domains are not configured correctly",
        error:
          sendingIdentity.errors.length > 0
            ? sendingIdentity.errors.map((problem) => problem.message).join(" | ")
            : "Email sending domains are configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          warnings:
            sendingIdentity.warnings.map((problem) => problem.code).join(",") ||
            "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "security-environment",
        healthy: securityEnvironment,
        code: "SECURITY_ENVIRONMENT_NOT_READY",
        title: "Production security environment validation failed",
        error:
          failedSecurityChecks.length > 0
            ? `Failed checks: ${failedSecurityChecks.join(", ")}`
            : "Security environment is healthy.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          failedChecks: failedSecurityChecks.join(",") || "none",
          traceId,
        },
      }),
    ]);
  });

  if (head) {
    return new Response(null, {
      status: ready ? 204 : 503,
      headers,
    });
  }

  return Response.json(
    {
      ok: ready,
      checks: {
        database,
        securityEnvironment,
        providerBudgets,
        imageProviderBudget,
        emailSendingIdentity,
      },
      traceId,
    },
    {
      status: ready ? 200 : 503,
      headers,
    }
  );
};

export async function GET() {
  return readinessResponse();
}

export async function HEAD() {
  return readinessResponse(true);
}
