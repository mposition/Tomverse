export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V22_STORAGE_MAX_BYTES, AMUX_V22_TRANSFER_BODY_MAX_BYTES,
  AMUX_V22_TRANSFER_PARTS, amuxV22TransferChunkCount,
  amuxV22TransferChunkRange } from "@/lib/amux/v22TransferCore";
import { putAmuxV22TransferChunk } from "@/lib/amux/v22TransferStore";

/**
 * One chunk of a v22 run's result, patch or changed-path list
 * (docs/policy/amux-v22-result-transfer.md 1.6 1, owner decision 2026-11-18).
 * The answer keys and status codes are the Rust bridge's contract.
 */
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const bodySchema = z.object({
  attemptId: z.string().uuid(),
  worker: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  part: z.enum(AMUX_V22_TRANSFER_PARTS),
  totalBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
  baseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  chunkSha256: hex64,
  bytesBase64: z.string().min(4),
}).strict().refine((body) =>
  (body.part === "patch") === (body.baseSha !== undefined) &&
  (body.part === "changed_paths") === (body.count !== undefined));

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof bodySchema>;
  let bytes: Buffer;
  try {
    body = await readLimitedJson(request, AMUX_V22_TRANSFER_BODY_MAX_BYTES, bodySchema);
    // Canonical base64 is what decodes and encodes back to itself: a stray
    // character, missing padding, nonzero padding bits or the URL alphabet
    // all come back different. (A regular expression over a whole chunk's
    // 5.6 million characters overflows V8's backtracking stack.)
    if (body.bytesBase64.length % 4 !== 0) throw new Error("not canonical base64");
    bytes = Buffer.from(body.bytesBase64, "base64");
    if (bytes.toString("base64") !== body.bytesBase64 ||
        createHash("sha256").update(bytes).digest("hex") !== body.chunkSha256)
      throw new Error("chunk digest");
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    if (body.totalBytes > AMUX_V22_STORAGE_MAX_BYTES)
      return amuxJsonNoStore({ error: "exceeds_storage" }, 409);
    // The index lies in the part, and the chunk is exactly its range.
    try {
      const range = amuxV22TransferChunkRange(body.totalBytes, body.index);
      if (bytes.length !== range.end - range.start) throw new RangeError("length");
    } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
    try {
      const stored = await putAmuxV22TransferChunk({ attemptId: body.attemptId,
        worker: body.worker, part: body.part, totalBytes: body.totalBytes,
        sha256: body.sha256, baseSha: body.baseSha ?? null,
        count: body.count ?? null, index: body.index, bytes });
      if (stored.kind === "refused")
        return amuxJsonNoStore({ error: stored.code }, 409);
      return amuxJsonNoStore({ attemptId: body.attemptId, part: body.part,
        index: body.index, duplicate: stored.duplicate, received: stored.received,
        chunkCount: amuxV22TransferChunkCount(body.totalBytes) });
    } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
  } finally { bytes.fill(0); }
}
