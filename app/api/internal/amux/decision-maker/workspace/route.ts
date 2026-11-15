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
import { readDecisionMakerCardText } from "@/lib/amux/decisionMakerBodyStore";
import { DM_EVIDENCE_OPEN } from "@/lib/amux/decisionMakerCore";
import { amuxDmWorkspaceEnabled, dmEncodeWorkspaceFiles } from "@/lib/amux/decisionMakerWorkspaceCore";
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
      const workspaceOn = amuxDmWorkspaceEnabled();
      const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerWorkspaceRead, async (tx) => {
        const source = await readDecisionMakerWorkspaceSource(tx, requestId);
        // With the workspace off, a card the app filed must carry its evidence
        // itself; one filed while the workspace was on points at files only.
        const cardText = source && source.kind !== "none" && !workspaceOn ?
          await readDecisionMakerCardText(tx, requestId) : null;
        return { source, cardText };
      });
      const { source } = read;
      if (source === null) return refused(404, "request_unknown");
      if (!workspaceOn && source.kind !== "none" && !read.cardText?.card.context.includes(DM_EVIDENCE_OPEN)) {
        // A DM never judges without the evidence: the bridge discards the request.
        return refused(409, "workspace_off_evidence_missing");
      }
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
