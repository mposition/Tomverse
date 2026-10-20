import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
/** A page prompt carries at most an 8 KiB idea and a 64 KiB previous page
 * plus the fixed template; JSON escaping can grow that at most six-fold. */
const MAX_REPLY_BYTES = 1_048_576;

function endpointFor(origin) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    return new URL("/api/internal/amux/v19/analysis-idea",
      requested).toString();
  } catch { return null; }
}

/** Fetch the app-built prompt for one exact claimed page. It carries the idea
 * text; the caller must keep it out of logs. */
export async function readAmuxV19MaxIdeaOnce({ origin, reservationId, ideaId,
  claimId, fetchImpl = fetch }) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  const endpoint = endpointFor(origin);
  if (!endpoint || !UUID.test(reservationId ?? "") ||
      !UUID.test(ideaId ?? "") || !UUID.test(claimId ?? "") ||
      !SECRET.test(secret ?? "") || typeof fetchImpl !== "function") {
    return { kind: "refused" };
  }
  // A read-only page read sent as POST (the route writes nothing): asking
  // again is safe.
  const reply = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "POST", purpose: "read", timeoutMs: 8_000,
    maxBytes: MAX_REPLY_BYTES,
    headers: { authorization: ["Bearer", secret].join(" "),
      "x-amux-agent-id": "amux-intake-max",
      "content-type": "application/json" },
    body: JSON.stringify({ reservationId, ideaId, claimId }) });
  const value = amuxV19ReplyJson(reply);
  if (reply.kind !== "response" || reply.status !== 200) return {
    kind: "unavailable", reason: amuxV19ReplyReason(reply) };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.prompt !== "string" || !value.prompt.trim()) {
    return { kind: "unavailable", reason: "response_invalid" };
  }
  return { kind: "ready", prompt: value.prompt };
}

/** A lost-response claim may be committed, but it does not authorize a
 * plaintext read or CLI dispatch. Keep the exact new identity attached. */
export async function readAmuxV19MaxClaimedIdeaOnce({ origin, selection,
  fetchImpl = fetch }) {
  const identity = selection?.identity;
  const claim = selection?.claim;
  if (selection?.kind !== "claimed" ||
      !identity || typeof identity !== "object" ||
      Array.isArray(identity) ||
      selection.retryWrite !== false || claim?.kind !== "claimed" ||
      claim.recovered !== false || claim.retryWrite !== false ||
      claim.claimId !== identity?.claimId ||
      claim.requestId !== identity?.requestId ||
      claim.reservationId !== identity?.reservationId) return {
    kind: "refused" };
  return readAmuxV19MaxIdeaOnce({ origin,
    claimId: identity.claimId, reservationId: identity.reservationId,
    ideaId: identity.ideaId, fetchImpl });
}
