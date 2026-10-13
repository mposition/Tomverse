export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore } from
  "@/lib/amux/internalRoute";
import { amuxV22ApiModelAccessResultSchema,
  pendingAmuxV22ApiModelAccess, readAmuxV22ApiModelAccess,
  reportAmuxV22ApiModelAccess } from "@/lib/amux/v22ApiModelAccessService";

const worker = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const uuid = z.string().uuid();

export async function GET(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  try {
    const query = new URL(request.url).searchParams;
    const workerName = query.get("worker");
    const evidenceId = query.get("evidence_id");
    if ((workerName === null) === (evidenceId === null) || query.size !== 1)
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
    if (workerName !== null) {
      if (!worker.safeParse(workerName).success)
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxJsonNoStore(await pendingAmuxV22ApiModelAccess(workerName), 200);
    }
    if (!uuid.safeParse(evidenceId).success)
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
    return amuxJsonNoStore(await readAmuxV22ApiModelAccess(evidenceId!), 200);
  } catch (error) { return amuxInternalErrorResponse("v22_api_model_access_read", error); }
}

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  try {
    const body = await readLimitedJson(request, 8_192,
      amuxV22ApiModelAccessResultSchema);
    return amuxJsonNoStore(await reportAmuxV22ApiModelAccess(body), 200);
  } catch (error) { return amuxInternalErrorResponse("v22_api_model_access_write", error); }
}
