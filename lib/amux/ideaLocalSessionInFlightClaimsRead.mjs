import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const AGENT_ID = "amux-intake-max";
/** A byte bound on the reply, not a count of claims: an identity is about 250
 * bytes, so this holds tens of thousands of them. */
const MAX_REPLY_BYTES = 8 * 1_024 * 1_024;
const CLAIM_KEYS = ["claimId", "requestId", "reservationId", "ideaId",
  "invocationOrdinal"];

function endpointFor(origin, beforeMs) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    const endpoint = new URL("/api/internal/amux/v19/analysis-budget/in-flight",
      requested);
    endpoint.searchParams.set("before", new Date(beforeMs).toISOString());
    return endpoint.toString();
  } catch { return null; }
}

const exactKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

const validClaim = (claim) => exactKeys(claim, CLAIM_KEYS) &&
  CLAIM_KEYS.slice(0, 4).every((key) => UUID.test(claim[key])) &&
  Number.isSafeInteger(claim.invocationOrdinal) &&
  claim.invocationOrdinal >= 0 && claim.invocationOrdinal <= 2_147_483_647;

/** One read of the subscription claims the app still holds in flight that
 * were written before `beforeMs` (a marker's mtime). Read-only: it asks again
 * through a dropped link and never writes. `listed` carries identities only,
 * rebuilt field by field; a reply that does not match the exact shape is
 * `unavailable`, never a partial list, so the caller keeps its marker. */
export async function readAmuxV19SessionInFlightShadowClaims({ origin,
  beforeMs, fetchImpl = fetch }) {
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  // A time in the future is the app's own refusal too; asking would only
  // spend a request.
  if (!Number.isFinite(beforeMs) || beforeMs <= 0 || beforeMs > Date.now() ||
      !SECRET.test(agentSecret ?? "") || typeof fetchImpl !== "function") {
    return { kind: "refused" };
  }
  const endpoint = endpointFor(origin, beforeMs);
  if (!endpoint) return { kind: "refused" };
  const reply = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "GET", purpose: "read", timeoutMs: 8_000,
    maxBytes: MAX_REPLY_BYTES,
    headers: { authorization: `Bearer ${agentSecret}`,
      "x-amux-agent-id": AGENT_ID } });
  const value = amuxV19ReplyJson(reply);
  if (reply.kind !== "response" || reply.status !== 200) {
    return { kind: "unavailable", reason: amuxV19ReplyReason(reply) };
  }
  if (!exactKeys(value, ["claims"]) || !Array.isArray(value.claims) ||
      !value.claims.every(validClaim)) {
    return { kind: "unavailable", reason: "response_invalid" };
  }
  return { kind: "listed", claims: value.claims.map((claim) =>
    Object.fromEntries(CLAIM_KEYS.map((key) => [key, claim[key]]))) };
}
