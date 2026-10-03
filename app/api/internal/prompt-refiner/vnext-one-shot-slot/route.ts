export const dynamic = "force-dynamic";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { consumePromptRefinerVnextOneShotSlot } from
  "@/lib/promptRefinerVnextOneShotSlotConsumption";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
  slotIndex: z.number().int().min(0).max(79),
  runApprovalAuditLogId: z.string().min(1).max(128),
}).strict();

function authorized(request: Request): boolean {
  const expected = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || expected.length > 256 ||
      !provided?.startsWith("Bearer ")) return false;
  const token = provided.slice(7);
  if (token.length < 32 || token.length > 256) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(token).digest()
  );
}

/** Default-off reservation consumption; a successful response is not dispatch approval. */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }
  if (process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED !== "1") {
    return NextResponse.json({ code: "SLOT_CONSUMPTION_DISABLED" },
      { status: 409, headers });
  }
  try {
    const input = await readLimitedJson(request, 2 * 1024, bodySchema);
    const result = await consumePromptRefinerVnextOneShotSlot(input);
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    // An unknown outcome must be inspected, not sent again with a new request ID.
    return NextResponse.json({ code: "SLOT_CONSUMPTION_UNAVAILABLE" },
      { status: 503, headers });
  }
}
