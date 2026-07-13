export const dynamic = "force-dynamic";

import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const isReady = () =>
  process.env.NODE_ENV !== "production" || getSecurityEnvironmentStatus().ready;

export function GET() {
  const ready = isReady();
  return Response.json(
    { ok: ready },
    {
      status: ready ? 200 : 503,
      headers,
    }
  );
}

export function HEAD() {
  const ready = isReady();
  return new Response(null, {
    status: ready ? 204 : 503,
    headers,
  });
}
