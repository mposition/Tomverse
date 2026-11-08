export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { createHash, timingSafeEqual } from "node:crypto";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { exportModelCatalog, modelCatalogExportSecret } from "@/lib/modelCatalogEnvSync";

// Production's model catalogue, read by staging's and dev's weekly sync
// (lib/modelCatalogEnvSync.ts). Read-only and catalogue tables only. Answers
// 404 anywhere but production and to any caller without the export secret, so
// a lower environment cannot become another one's source.

const notFound = () =>
  Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });

const authorized = (request: Request) => {
  const secret = modelCatalogExportSecret();
  if (!secret) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

export async function GET(request: Request) {
  if (resolveDeploymentEnvironment() !== "production" || !authorized(request)) return notFound();
  const payload = await exportModelCatalog();
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
