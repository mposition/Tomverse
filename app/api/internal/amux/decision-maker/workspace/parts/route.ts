export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import {
  describeDecisionMakerWorkspaceEvidence,
  readDecisionMakerWorkspaceSource,
} from "@/lib/amux/decisionMakerWorkspaceService";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * The Decision Maker workspace's evidence described, not carried
 * (docs/policy/amux-v22-result-transfer.md 10.2): the same read as
 * `../route.ts`, but each file is answered by its name, its size, its sha256
 * and its git blob id, and the bridge reads the bytes in chunks from
 * `../chunk/route.ts` when the broker asks for them. No size of ours bounds a
 * file or the evidence. Every file has passed the whole-file checks
 * (`dmWorkspaceAcceptFiles`) before it is described, and `excluded` counts
 * what did not, as the older route's does. A read: nothing is written.
 *
 * A relay that does not know this route gets the framework's 404 and asks the
 * older route; this is how a relay says it speaks the parts protocol.
 */

const MAX_BODY_BYTES = 1_024;
const requestSchema = z.object({ request_id: z.unknown() }).strict();
const OPERATION = "decision_maker_workspace_parts";
const refused = dmRouteRefusal("found");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      if (typeof body.request_id !== "string") return refused(400, "invalid_request");
      const requestId = body.request_id;
      const source = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerWorkspaceRead, (tx) =>
        readDecisionMakerWorkspaceSource(tx, requestId),
      );
      if (source === null) return refused(404, "request_unknown");
      const described = await describeDecisionMakerWorkspaceEvidence(source);
      return amuxJsonNoStore({
        found: true,
        workspace: described === null ? null : {
          target_sha: described.targetSha,
          parts: described.parts,
          excluded: described.excluded,
        },
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
