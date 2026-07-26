export const dynamic = "force-dynamic";

// Public, unauthenticated endpoint (STG-F010): lets QA and users confirm
// which commit/deployment is actually running on a given environment
// without logging in. Only ever returns the four PublicBuildInfo fields --
// never raw process.env, hostnames, or anything else from lib/buildInfo.ts.
import { getPublicBuildInfo } from "@/lib/buildInfo";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export function GET() {
  return Response.json(getPublicBuildInfo(), { status: 200, headers });
}
