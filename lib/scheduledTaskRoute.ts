import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { ScheduledTaskError } from "@/lib/scheduledTaskService";

/** Shared by the two /api/scheduled-tasks routes: the session, a rate limit, and one error shape. */
export async function scheduledTaskUser(request: Request, write: boolean) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return { response: NextResponse.json({ code: "AUTHENTICATION_REQUIRED" }, { status: 401 }) } as const;
  await consumeApiRateLimit(
    request,
    userId,
    write ? "scheduled-tasks-write" : "scheduled-tasks-read",
    write ? { minute: 20, day: 300 } : { minute: 60, day: 2_000 }
  );
  return { userId } as const;
}

export function scheduledTaskErrorResponse(error: unknown, event: string) {
  const security = apiSecurityResponse(error);
  if (security) return security;
  if (error instanceof ScheduledTaskError) {
    return NextResponse.json({ code: error.code, ...(error.details ?? {}) }, { status: error.status });
  }
  console.error(JSON.stringify({
    event,
    error: error instanceof Error ? error.name : "unknown",
    timestamp: new Date().toISOString(),
  }));
  return NextResponse.json({ code: "SCHEDULED_TASK_FAILED" }, { status: 500 });
}
