import { createHash, timingSafeEqual } from "node:crypto";

/** The idea analysis intake bridge. The existing AMUX sync credential cannot
 * discover operator ideas; only the dedicated agent secret can read the queue. */
export const AMUX_V4_ANALYSIS_AGENT_SECRET_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET";
export const AMUX_V4_ANALYSIS_AGENT_ID = "amux-intake";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Only the dedicated local Agent identity may read candidate IDs. This
 * helper never grants payload access or permission to claim a receipt. */
export function isAmuxV4AnalysisAgentAuthorized(request: Request,
  configured: string | undefined, syncSecret?: string): boolean {
  if (typeof configured !== "string" || !SECRET.test(configured) ||
      configured === syncSecret ||
      request.headers.get("x-amux-agent-id") !== AMUX_V4_ANALYSIS_AGENT_ID) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest());
}
