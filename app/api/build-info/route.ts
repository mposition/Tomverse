export const dynamic = "force-dynamic";

// Public, unauthenticated endpoint (STG-F010, extended by AUD-R002): lets QA
// and users confirm which commit/deployment is actually running on a given
// environment without logging in. Only ever returns the PublicBuildInfo
// allowlist fields -- never raw process.env, hostnames, Railway tokens, or
// anything else from lib/buildInfo.ts.
import { getPublicBuildInfo } from "@/lib/buildInfo";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export async function GET() {
  return Response.json(await getPublicBuildInfo(), { status: 200, headers });
}
