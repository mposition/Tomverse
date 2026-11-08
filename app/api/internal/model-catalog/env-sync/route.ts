export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { createHash, timingSafeEqual } from "node:crypto";
import { runModelCatalogEnvSync } from "@/lib/modelCatalogEnvSync";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

// An operator's run of the weekly catalogue copy, outside its Sunday slot
// (the Maintenance Cron runs the same function). Same rules: staging and dev
// only, and it writes only with MODEL_CATALOG_ENV_SYNC_APPLY=true -- without
// it the response is the plan.

const authorized = (request: Request) => {
  const secret = process.env.MAINTENANCE_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await runModelCatalogEnvSync();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await reportOperationalIncident({
      code: "MODEL_CATALOG_ENV_SYNC_FAILED",
      title: "Model catalogue copy from production failed",
      error,
      severity: "warning",
      context: { component: "model-catalog-env-sync", route: "/api/internal/model-catalog/env-sync" },
    }).catch(() => undefined);
    return Response.json(
      { error: error instanceof Error ? error.message : "Model catalogue copy failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
