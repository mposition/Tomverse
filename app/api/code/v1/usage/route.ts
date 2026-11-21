export const dynamic = "force-dynamic";

import { GET as keyUsage } from "@/app/api/v1/usage/route";

// The same key usage on the coding API: one key, one cap, one ledger for both APIs.
export async function GET(request: Request) {
    return keyUsage(request);
}
