export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";
import { reportOperationalDependencyStatus } from "@/lib/operationalMonitoring";
import { getImageProviderBudgetReadiness } from "@/lib/imageProviderBudgetReadiness";
import { getSearchProviderBudgetReadiness } from "@/lib/searchProviderBudgetReadiness";
import { getSendingIdentityReadiness } from "@/lib/emailSendingIdentity";
import { snapshotKeyringReadiness } from "@/lib/emailSnapshotCrypto";
import { businessIdentityReadiness } from "@/lib/emailBusinessIdentity";
import { unsubscribeKeyringReadiness } from "@/lib/emailUnsubscribeReadiness";
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
  // The search vendor this application calls itself. Unlike the image budget
  // there is no flag to be off: the capability register is compiled in, so a
  // build that ships Google models searching through a backend has already
  // decided. What this refuses is a production deployment that would offer the
  // search switch with no credential behind it, or spend at a vendor whose
  // operational cap could not be read. Deploy the variables first, the build
  // second -- the same order the provider budgets take.
  const searchBudgetStatus = (() => {
    try {
      return {
        status: getSearchProviderBudgetReadiness(),
        error: null as string | null,
      };
    } catch (error) {
      // The derivation itself failed, which is never "the budget is fine". Same
      // reasoning as the image budget above: the louder the failure, the
      // quieter this endpoint must not become.
      return {
        status: null,
        error:
          error instanceof Error
            ? error.message
            : "The search provider budget readiness check threw.",
      };
    }
  })();
  const searchProviderBudget = searchBudgetStatus.status?.ready ?? false;
  // The sending domains. Errors here are configurations that would send from
  // the wrong domain or from nothing at all; the outstanding move of
  // transactional mail onto its own subdomain
  // (docs/policy/email-notifications.md §14.1) is a warning, because gating on
  // it would refuse readiness on today's deployment in order to announce a
  // planned migration.
  const sendingIdentity = getSendingIdentityReadiness();
  const emailSendingIdentity = sendingIdentity.ready;
  // The keyring the standard lane seals its render snapshots with. Unlike the
  // image budget, there is no flag to be off: the lane is live wherever this
  // code is, it refuses to store the snapshot unencrypted, and its callers
  // swallow the throw so the user's own action still succeeds. Without this
  // check a deployment answers ready while every welcome email, receipt and
  // deletion notice is dropped -- and the first report of it is somebody
  // saying they never got a receipt.
  const snapshotKeyring = snapshotKeyringReadiness();
  const emailSnapshotKeyring = snapshotKeyring.ready;
  // The one-click unsubscribe keyring, and the only email dependency here that
  // is conditional. It becomes an error once MARKETING_EMAIL_FROM is set --
  // the state where a deployment answers ready while every marketing send is
  // refused for having no unsubscribe link (EM-10). Until then a missing key
  // is a warning, because gating on it would refuse today's deployment to
  // announce a capability nobody has turned on. A keyring that is present and
  // broken is an error either way.
  const unsubscribeKeyring = unsubscribeKeyringReadiness();
  const emailUnsubscribeKeyring = unsubscribeKeyring.ready;
  // Who the footer says sent the message. Conditional in the same shape as the
  // unsubscribe keyring, and for the same reason: an unset value drops the
  // whole footer rather than one line, but transactional mail is deliberately
  // not held for it, so gating readiness here would refuse today's deployment
  // over a gap that has been there since the footer shipped. It becomes an
  // error once MARKETING_EMAIL_FROM is set, because from then on an incomplete
  // identity means every marketing send is refused while this endpoint answers
  // yes -- the exact state EM-10 describes for the keyring.
  const businessIdentity = businessIdentityReadiness();
  const emailBusinessIdentity = businessIdentity.ready;
  const database = databaseResult.ready;
  const ready =
    database && securityEnvironment && providerBudgets &&
    imageProviderBudget && searchProviderBudget && emailSendingIdentity &&
    emailSnapshotKeyring && emailUnsubscribeKeyring && emailBusinessIdentity;
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
        dependency: "search-provider-cost-budget",
        healthy: searchProviderBudget,
        code: "SEARCH_PROVIDER_COST_BUDGET_NOT_READY",
        title: "Application-managed web search is not configured correctly",
        error: searchProviderBudget
          ? "Search backend credentials and spend budget are configured."
          : searchBudgetStatus.error ??
            ((searchBudgetStatus.status?.problems ?? [])
              .map((problem) => problem.message)
              .join(" | ") ||
              "A search backend is unusable."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          searchBudgetCheckThrew: searchBudgetStatus.error !== null,
          // Names, never values. Which backends this deployment holds a
          // credential for is operational fact; the credential is not.
          configuredSearchBackends:
            (searchBudgetStatus.status?.configuredBackends ?? []).join(",") ||
            "none",
          requiredSearchBackends:
            (searchBudgetStatus.status?.requiredBackends ?? []).join(",") ||
            "none",
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
        dependency: "email-snapshot-keyring",
        healthy: emailSnapshotKeyring,
        code: "EMAIL_SNAPSHOT_KEYRING_NOT_READY",
        title: "Email render snapshots cannot be sealed",
        error:
          snapshotKeyring.errors.length > 0
            ? snapshotKeyring.errors.map((problem) => problem.message).join(" | ")
            : "The email snapshot keyring is configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // Counts, never the version label or the secret: a keyring is
          // misconfigured most often by a value pasted into the wrong
          // variable, and the wrong variable here holds key material.
          versionCount: snapshotKeyring.versionCount,
          warnings:
            snapshotKeyring.warnings.map((problem) => problem.code).join(",") ||
            "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-business-identity",
        healthy: emailBusinessIdentity,
        code: "EMAIL_BUSINESS_IDENTITY_NOT_READY",
        title: "Email footers cannot say who sent the message",
        error:
          businessIdentity.errors.length > 0
            ? businessIdentity.errors.map((problem) => problem.message).join(" | ")
            : businessIdentity.warnings.length > 0
              ? businessIdentity.warnings.map((problem) => problem.message).join(" | ")
              : "The footer's business identity is configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // The variables to set, not just the blocks that are empty: an
          // operator told which footer block is missing still has to work out
          // which variable sets it.
          setInstead:
            [...businessIdentity.errors, ...businessIdentity.warnings]
              .flatMap((problem) => problem.variables)
              .join(",") || "none",
          marketingConfigured: businessIdentity.required,
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-unsubscribe-keyring",
        healthy: emailUnsubscribeKeyring,
        code: "EMAIL_UNSUBSCRIBE_KEYRING_NOT_READY",
        title: "Marketing mail cannot carry a one-click unsubscribe link",
        error:
          unsubscribeKeyring.errors.length > 0
            ? unsubscribeKeyring.errors.map((problem) => problem.message).join(" | ")
            : unsubscribeKeyring.required
              ? "The unsubscribe keyring is configured."
              : "Marketing sending is not configured, so no unsubscribe keyring is required yet.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // Whether this deployment is one the keys are mandatory for, so a
          // warning here can be read without also knowing what
          // MARKETING_EMAIL_FROM is set to. No counts and no labels: unlike the
          // snapshot keyring this can be absent by design, and a version count
          // of zero would read as a fault.
          required: unsubscribeKeyring.required,
          warnings:
            unsubscribeKeyring.warnings.map((problem) => problem.code).join(",") ||
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
        searchProviderBudget,
        emailSendingIdentity,
        emailSnapshotKeyring,
        emailUnsubscribeKeyring,
        emailBusinessIdentity,
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
