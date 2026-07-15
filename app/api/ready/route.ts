export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";
import { reportOperationalDependencyStatus } from "@/lib/operationalMonitoring";

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
  const database = databaseResult.ready;
  const ready = database && securityEnvironment;
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
