export const dynamic = "force-dynamic";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_IDEA_READBACK_ENV } from "@/lib/amux/ideaSubmissionCore";
import {
  AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
  AMUX_SESSION_INTAKE_READBACK_ENV,
  amuxSessionIntakeReadbackEnabled,
  amuxSessionIntakeReadbackReply,
  amuxSessionIntakeReadbackRequestId,
  isAmuxSessionIntakeClientAuthorized,
} from "@/lib/amux/ideaSessionIntakeReadbackCore";
import { readAmuxIdeaSessionSubmissionRequest } from
  "@/lib/amux/ideaSessionSubmissionService";

const otherCapabilitySecrets = (): Array<string | undefined> => [
  process.env.TOMVERSE_AMUX_SYNC_SECRET,
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
  process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET,
  process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET,
  process.env.TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET,
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET,
  process.env.AUTH_SECRET,
  process.env.NEXTAUTH_SECRET,
];

/** Exact-ID, metadata-only recovery after an uncertain session intake reply. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSessionIntakeClientAuthorized(
    request,
    process.env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV],
    otherCapabilitySecrets(),
  )) return amuxJsonNoStore({ error: "Unauthorized" }, 401);

  if (!amuxSessionIntakeReadbackEnabled(
    process.env[AMUX_SESSION_INTAKE_READBACK_ENV],
    process.env[AMUX_V4_IDEA_READBACK_ENV],
  )) {
    return amuxJsonNoStore({ available: false,
      reason: "session_intake_readback_disabled" }, 409);
  }

  const requestId = amuxSessionIntakeReadbackRequestId(request);
  if (!requestId) return amuxJsonNoStore({ error: "Invalid request." }, 400);

  try {
    const reply = amuxSessionIntakeReadbackReply(
      requestId,
      await readAmuxIdeaSessionSubmissionRequest(requestId),
    );
    return amuxJsonNoStore(reply.body, reply.status);
  } catch {
    return amuxJsonNoStore({ error: "session_intake_readback_unavailable",
      retryWrite: false }, 503);
  }
}
