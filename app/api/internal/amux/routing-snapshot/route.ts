export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";

const requestSchema = z
  .object({
    task_id: z.string().trim().min(1).max(120),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  try {
    const body = await readLimitedJson(
      request,
      2 * 1_024,
      requestSchema,
    );

    const snapshot = await buildAmuxRoutingSnapshot(
      body.task_id,
      body.expected_revision,
    );

    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Invalid request." },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
