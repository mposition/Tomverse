export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { commitAmuxV22ChangedPaths, readAmuxV22ChangedPathsRecord } from
  "@/lib/amux/v22ChangedPathsStore";
import { AMUX_V22_STORAGE_MAX_BYTES } from "@/lib/amux/v22TransferCore";

/**
 * The commit and readback of a v22 run's changed-path list, whose chunks the
 * box uploaded (docs/policy/amux-v22-result-transfer.md 1.6 4, owner decision
 * 2026-11-18). The answer keys and status codes are the Rust bridge's
 * contract.
 */
const id = z.string().uuid();
const bodySchema = z.object({
  attemptId: id,
  worker: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  transfer: z.literal("chunked_v1"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().min(1).max(AMUX_V22_STORAGE_MAX_BYTES),
}).strict();

export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].length !== 1 || !query.has("attemptId"))
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  const attemptId = id.safeParse(query.get("attemptId"));
  if (!attemptId.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    return amuxJsonNoStore(await readAmuxV22ChangedPathsRecord(attemptId.data));
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof bodySchema>;
  try {
    body = await readLimitedJson(request, 16 * 1024, bodySchema);
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const committed = await commitAmuxV22ChangedPaths({ attemptId: body.attemptId,
      worker: body.worker, sha256: body.sha256, count: body.count, bytes: body.bytes });
    switch (committed.kind) {
      case "recorded":
        return amuxJsonNoStore({ attemptId: body.attemptId, sha256: committed.sha256,
          count: committed.count, duplicate: committed.duplicate });
      case "incomplete":
        return amuxJsonNoStore({ error: "upload_incomplete",
          missing: { changed_paths: committed.missing } }, 409);
      case "digest_mismatch":
        return amuxJsonNoStore({ error: "upload_digest_mismatch",
          part: "changed_paths" }, 409);
      case "refused":
        return amuxJsonNoStore({ error: committed.code }, 409);
    }
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}
