import { mobileAppLinks } from "@/lib/mobileAppLinks";

export const dynamic = "force-dynamic";

export function GET() {
  const { ios } = mobileAppLinks();
  return Response.json({ applinks: { apps: [], details: ios } }, {
    status: ios.length ? 200 : 404, headers: { "Cache-Control": "no-store" },
  });
}
