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
  readDecisionMakerWorkspaceChunk,
  readDecisionMakerWorkspaceSource,
} from "@/lib/amux/decisionMakerWorkspaceService";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * One chunk of one evidence file of a Decision Maker request's workspace
 * (docs/policy/amux-v22-result-transfer.md 10.2). The file is the one
 * `../parts/route.ts` described, named by the sha256 it gave: the app opens the
 * request's source again, checks the file whole again (or serves the bytes this
 * process checked a moment ago), and gives bytes [start, end) of
 * `amuxV22TransferChunkRange` as base64. A file that is gone, refused by the
 * checks or no longer that sha256 is not served in part. A read: nothing is
 * written.
 */

const MAX_BODY_BYTES = 1_024;
const requestSchema = z
  .object({
    request_id: z.unknown(),
    name: z.unknown(),
    index: z.unknown(),
    sha256: z.unknown(),
  })
  .strict();
const OPERATION = "decision_maker_workspace_chunk";
const refused = dmRouteRefusal("found");
const SHA256 = /^[0-9a-f]{64}$/;

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      if (
        typeof body.request_id !== "string" ||
        typeof body.name !== "string" ||
        typeof body.sha256 !== "string" ||
        !SHA256.test(body.sha256) ||
        typeof body.index !== "number" ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0
      ) {
        return refused(400, "invalid_request");
      }
      const requestId = body.request_id;
      const chunk = await readDecisionMakerWorkspaceChunk(
        { requestId, name: body.name, sha256: body.sha256, index: body.index },
        () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerWorkspaceRead, (tx) =>
          readDecisionMakerWorkspaceSource(tx, requestId)),
      );
      if (!chunk.ok) {
        if (chunk.reason === "request_unknown" || chunk.reason === "evidence_absent") return refused(404, chunk.reason);
        if (chunk.reason === "index_out_of_range") return refused(400, chunk.reason);
        return refused(409, chunk.reason);
      }
      return amuxJsonNoStore({
        found: true,
        name: body.name,
        index: body.index,
        total_bytes: chunk.totalBytes,
        chunk_count: chunk.chunkCount,
        sha256: chunk.sha256,
        bytes_base64: chunk.bytes.toString("base64"),
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
