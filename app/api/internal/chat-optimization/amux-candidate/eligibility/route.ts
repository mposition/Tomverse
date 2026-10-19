export const dynamic = "force-dynamic";

import { z } from "zod";

import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { classifyChatUnifiedOptimizerAmuxCandidateAttempt } from
  "@/lib/chatUnifiedOptimizerAmuxCandidateStore";
import { readChatUnifiedOptimizerAmuxSourcePin } from
  "@/lib/chatUnifiedOptimizerAmuxSourcePin";

const WRITE_ENV = "TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_WRITE";

/** Metadata-only probe. Generic AMUX results are never posted to the
 * optimizer unless this exact pinned Codex author attempt is eligible. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || !params.has("attemptId"))
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  const attemptId = z.string().uuid().safeParse(params.get("attemptId"));
  if (!attemptId.success)
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const attempt = await classifyChatUnifiedOptimizerAmuxCandidateAttempt(
      attemptId.data);
    if (!attempt.target) return amuxJsonNoStore({ eligible: false });
    if (process.env[WRITE_ENV] !== "enabled")
      return amuxJsonNoStore({ eligible: false, target: true,
        reason: "amux_candidate_write_disabled" });
    if (!attempt.eligible) return amuxJsonNoStore({ eligible: false,
      target: true, reason: "amux_candidate_attempt_ineligible" });
    const sourcePin = readChatUnifiedOptimizerAmuxSourcePin();
    return amuxJsonNoStore({ eligible: true,
      attemptId: attemptId.data, sourcePin });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}
