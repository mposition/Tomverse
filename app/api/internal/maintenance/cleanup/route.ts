import { createHash, timingSafeEqual } from "node:crypto";
import { cleanupExpiredData } from "@/lib/maintenance";

const isAuthorized = (request: Request) => {
  const configured = process.env.MAINTENANCE_SECRET;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!configured || configured.length < 32 || !provided) return false;

  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  try {
    const deleted = await cleanupExpiredData();
    return Response.json(
      { success: true, deleted },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Scheduled maintenance cleanup failed:", error);
    return Response.json(
      { error: "Maintenance cleanup failed." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
