export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { prisma } from "@/lib/prisma";
import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";

const DATABASE_CHECK_TIMEOUT_MS = 5_000;
const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const checkDatabase = async () => {
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
    return result[0]?.ready === 1;
  } catch (error) {
    console.error(
      "[readiness] Database check failed:",
      error instanceof Error ? error.message : "Unknown database error"
    );
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const readinessResponse = async (head = false) => {
  const database = await checkDatabase();
  const securityEnvironment =
    process.env.NODE_ENV !== "production" ||
    getSecurityEnvironmentStatus().ready;
  const ready = database && securityEnvironment;
  const headers = ready
    ? baseHeaders
    : { ...baseHeaders, "Retry-After": "5" };

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
