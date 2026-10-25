import { mobileAppLinks } from "@/lib/mobileAppLinks";

export const dynamic = "force-dynamic";

export function GET() {
  const { android } = mobileAppLinks();
  return Response.json(android, { status: android.length ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
