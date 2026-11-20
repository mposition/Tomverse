export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { reportAmuxOperationalIncident } from "@/lib/amux/operationalError";
import { AMUX_V22_CONTEXT_PART_NAMES, amuxV22ContextChunk } from
  "@/lib/amux/v22ContextPartsCore";
import { readAmuxV22ContextPart } from "@/lib/amux/v22ContextStore";

/**
 * One chunk of a context file a delivery named in `context_parts`
 * (docs/policy/amux-v22-result-transfer.md 10.1, owner direction 2026-11-19).
 * The app rebuilds the file from its source rows for every request; the box
 * checks the whole against the sha256 the pull named, so a file that changed
 * in between is never handed to a run. The answer keys and status codes are
 * the Rust bridge's contract.
 */
const bodySchema = z.object({
  attemptId: z.string().uuid(),
  worker: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  name: z.enum(AMUX_V22_CONTEXT_PART_NAMES),
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

/** An outcome this route cannot name: the box asks again. Recorded by class
 * and code only, never the body. */
const outcomeUnknown = (error: unknown) => {
  reportAmuxOperationalIncident("v22_context_chunk", error);
  return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
};

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof bodySchema>;
  try {
    body = await readLimitedJson(request, 1_024, bodySchema);
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const part = await readAmuxV22ContextPart({ attemptId: body.attemptId,
      worker: body.worker, name: body.name });
    if (part.kind === "binding_mismatch")
      return amuxJsonNoStore({ error: "binding_mismatch" }, 409);
    if (part.kind === "absent") return amuxJsonNoStore({ error: "context_absent" }, 404);
    let chunk: ReturnType<typeof amuxV22ContextChunk>;
    try { chunk = amuxV22ContextChunk(part.text, body.index); }
    catch (error) {
      if (error instanceof RangeError)
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      throw error;
    }
    return amuxJsonNoStore({ attemptId: body.attemptId, name: body.name,
      index: body.index, totalBytes: chunk.totalBytes, chunkCount: chunk.chunkCount,
      sha256: chunk.sha256, bytesBase64: chunk.bytes.toString("base64") });
  } catch (error) { return outcomeUnknown(error); }
}
