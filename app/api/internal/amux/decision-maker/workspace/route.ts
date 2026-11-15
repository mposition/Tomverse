export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  dmInternalRoutesEnabled,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { dmEncodeWorkspaceFiles } from "@/lib/amux/decisionMakerWorkspaceCore";
import {
  openDecisionMakerWorkspaceEvidence,
  readDecisionMakerWorkspaceSource,
} from "@/lib/amux/decisionMakerWorkspaceService";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker workspace evidence (owner decision 2026-11-15; lib/amux/
 * decisionMakerWorkspaceCore.ts): before the transmission intent, the bridge
 * asks what a request's workspace holds -- the commit and the whole evidence
 * files of the card it was routed for -- and hands it to the broker, which
 * checks it again, confirms the commit on GitHub's public API and answers the
 * manifest lines the intent then records. A read: nothing is written.
 *
 * `workspace: null` is the card alone: the workspace is switched off
 * (TOMVERSE_AMUX_DM_WORKSPACE=disabled). Files are base64, so the answer's
 * size is the evidence's (at most DM_WORKSPACE_EVIDENCE_MAX_BYTES and a third).
 * Closed until TOMVERSE_AMUX_DM_ROUTING=enabled.
 */

const MAX_BODY_BYTES = 1_024;
const requestSchema = z.object({ request_id: z.unknown() }).strict();
const OPERATION = "decision_maker_workspace";
const refused = dmRouteRefusal("found");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      if (typeof body.request_id !== "string") return refused(400, "invalid_request");
      const requestId = body.request_id;
      const source = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerWorkspaceRead,
        (tx) => readDecisionMakerWorkspaceSource(tx, requestId));
      if (source === null) return refused(404, "request_unknown");
      const evidence = await openDecisionMakerWorkspaceEvidence(source);
      return amuxJsonNoStore({
        found: true,
        workspace: evidence === null ? null : {
          target_sha: evidence.targetSha,
          files: dmEncodeWorkspaceFiles(evidence.files),
          excluded: evidence.excluded,
        },
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
