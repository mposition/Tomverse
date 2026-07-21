export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { claimPendingAutoFixRuns } from "@/lib/scheduledJobs";

const authorized = (request: Request) => {
  const secret = process.env.AUTO_FIX_SYNC_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const runs = await claimPendingAutoFixRuns();
  return NextResponse.json({
    runs: runs.map((run) => ({
      id: run.id,
      jobKey: run.jobKey,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() || null,
    })),
  });
}
