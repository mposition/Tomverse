export const dynamic = "force-dynamic";

import { claimAmuxIdeaLane, isAmuxIdeaLaneAuthorized } from "@/lib/amux/ideaLaneService";

const NO_STORE = { "Cache-Control": "no-store" };

/** POST: claim the next owner idea for .github/workflows/amux-idea-lane.yml.
 * The idea text goes to that one job and is never logged here. */
export async function POST(request: Request) {
  if (!isAmuxIdeaLaneAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  try {
    const claim = await claimAmuxIdeaLane();
    return Response.json(claim ? { claimed: true, ...claim } : { claimed: false }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Unavailable" }, { status: 503, headers: NO_STORE });
  }
}
