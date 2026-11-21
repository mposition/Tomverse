export const dynamic = "force-dynamic";

import { GET as requestStatus } from "@/app/api/v1/requests/status/route";

// The same receipt lookup on the coding API: a request of this key, whichever
// API it was sent through. Read only.
export async function GET(request: Request) {
    return requestStatus(request);
}
