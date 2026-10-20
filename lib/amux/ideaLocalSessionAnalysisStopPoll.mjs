import { AMUX_V19_STOP_UNREACHABLE, amuxV19AppRequest, amuxV19ReplyJson } from
  "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_REPLY_BYTES = 256;

function pinnedEndpoint(origin) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    return new URL("/api/internal/amux/v19/session-analysis-stop", requested);
  } catch { return null; }
}

/** One stop read: `false` only for the exact continue receipt,
 * AMUX_V19_STOP_UNREACHABLE when no answer arrived (a network failure or a
 * gateway answer), `true` for every answer the app did give otherwise. The
 * caller's stop rule decides how long an unanswered read may last. */
async function stopAnswer(input, agentId) {
  const endpoint = pinnedEndpoint(input?.origin);
  if (!endpoint || !UUID.test(input?.claimId ?? "") ||
      !UUID.test(input?.reservationId ?? "") ||
      !UUID.test(input?.ideaId ?? "") ||
      !SECRET.test(input?.agentSecret ?? "") ||
      typeof input?.fetchImpl !== "function") return true;
  endpoint.searchParams.set("claimId", input.claimId);
  endpoint.searchParams.set("reservationId", input.reservationId);
  endpoint.searchParams.set("ideaId", input.ideaId);
  const reply = await amuxV19AppRequest({ fetchImpl: input.fetchImpl,
    url: endpoint.toString(), method: "GET", purpose: "poll",
    timeoutMs: 8_000, maxBytes: MAX_REPLY_BYTES, signal: input.signal,
    headers: { authorization: `Bearer ${input.agentSecret}`,
      "x-amux-agent-id": agentId } });
  const parsed = amuxV19ReplyJson(reply);
  if (input.signal?.aborted) return true;
  if (reply.kind === "failed") {
    return reply.reason === "response_invalid" ? true : AMUX_V19_STOP_UNREACHABLE;
  }
  return !(reply.status === 200 && parsed && typeof parsed === "object" &&
    !Array.isArray(parsed) && Object.keys(parsed).length === 3 &&
    parsed.claimId === input.claimId &&
    parsed.reservationId === input.reservationId &&
    parsed.stop === false);
}

/** Any ambiguous stop poll terminates the exact local invocation. */
export async function shouldStopAmuxV19SessionAnalysis(input) {
  return await stopAnswer(input, "amux-intake") !== false;
}

/** The Max launcher's stop check under its dedicated identity: `false`,
 * `true` or AMUX_V19_STOP_UNREACHABLE (see stopAnswer). A missing launcher
 * secret is a stop. */
export async function checkAmuxV19MaxSessionAnalysisStop(input) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!SECRET.test(secret ?? "")) return true;
  return stopAnswer({ ...input, agentSecret: secret }, "amux-intake-max");
}

/** Boolean form for callers without a stop rule; any uncertainty stops. */
export async function shouldStopAmuxV19MaxSessionAnalysis(input) {
  return await checkAmuxV19MaxSessionAnalysisStop(input) !== false;
}
