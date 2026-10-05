export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { getProviderBudgetStatuses } from "@/lib/providerBudgetStatus";
import { computeReadinessChecks } from "@/lib/readinessChecks";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { opsObserverCaller } from "@/scripts/ops-observer/route-auth-core.mjs";
import { buildSnapshot, settleWithin } from "@/scripts/ops-observer/snapshot-core.mjs";

// The machine read the ops observers poll (docs/policy/sre-ops.md §1, §3
// rule 7, §7, §8). POST so the request leaves nothing in URLs, caches or
// intermediate logs -- it creates and changes no row, claims nothing and
// reports nothing. Both services may call it; with no usable secret it is 404.
//
// The sections are computed independently, readiness first, from the same
// functions /api/ready and the admin dashboards use; a section that fails is
// "unknown" on its own. The snapshot is validated by the runner's own parser
// before it leaves. Each read is logged without a body: when, which service,
// and whether the snapshot was valid.

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
const REFUSALS: Readonly<Record<number, string>> = { 401: "unauthorized", 403: "forbidden", 404: "not_found" };

export async function POST(request: Request) {
  const caller = opsObserverCaller({
    route: "ops-snapshot",
    authorization: request.headers.get("authorization"),
    env: process.env,
  }) as { service?: "page" | "digest"; status?: number };
  if (!caller.service) {
    const status = caller.status ?? 404;
    return json({ error: REFUSALS[status] ?? "not_found" }, status);
  }

  const now = new Date();
  // Readiness before the database aggregates: it is the one a broken
  // database must not starve. Every section has its own time limit, so a
  // source that never answers costs only its own section.
  const readiness = await settleWithin(computeReadinessChecks());
  const [jobs, budgets] = await Promise.all([
    settleWithin(getScheduledJobsDashboard(now)),
    settleWithin(getProviderBudgetStatuses({ now })),
  ]);
  const built = buildSnapshot({
    readiness,
    jobs,
    budgets,
    now,
    commitSha: process.env.RAILWAY_GIT_COMMIT_SHA,
  }) as { ok: true; snapshot: unknown } | { ok: false; reason: string };

  console.info(
    JSON.stringify({
      event: "ops_snapshot_read",
      at: now.toISOString(),
      service: caller.service,
      result: built.ok ? "ok" : `invalid:${built.reason}`,
    }),
  );
  if (!built.ok) return json({ error: "snapshot_invalid" }, 500);
  return json(built.snapshot);
}
