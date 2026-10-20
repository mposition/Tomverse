import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const PRICE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function endpointFor(origin, reservationId, ideaId) {
  try {
    const url = new URL(origin);
    const pinned = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash ||
        url.toString() !== pinned.toString()) return null;
    const endpoint = new URL("/api/internal/amux/v19/analysis-price", url);
    endpoint.searchParams.set("reservationId", reservationId);
    endpoint.searchParams.set("ideaId", ideaId);
    return endpoint.toString();
  } catch { return null; }
}

/** Read-only current audited subscription price ID on the reservation's own
 * CLI channel. Claim admission rechecks it. */
export async function readAmuxV19MaxPriceSelection({ origin, reservationId,
  ideaId, fetchImpl = fetch }) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!UUID.test(reservationId ?? "") || !UUID.test(ideaId ?? "") ||
      !SECRET.test(secret ?? "") || typeof fetchImpl !== "function") {
    return { kind: "refused" };
  }
  const endpoint = endpointFor(origin, reservationId, ideaId);
  if (!endpoint) return { kind: "refused" };
  const reply = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "GET", purpose: "read", timeoutMs: 8_000, maxBytes: 512,
    headers: { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": "amux-intake-max" } });
  const selected = amuxV19ReplyJson(reply);
  if (reply.kind !== "response" || reply.status !== 200) return {
    kind: "unavailable", reason: amuxV19ReplyReason(reply) };
  if (!selected || typeof selected !== "object" ||
      Object.keys(selected).length !== 5 || selected.kind !== "ready" ||
      !PRICE_ID.test(selected.priceVersionId) ||
      !isAmuxIdeaAnalysisProvider(selected.provider) ||
      !MODEL_ID.test(selected.modelId) ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(selected.reasoningEffort)) {
    return { kind: "unavailable", reason: "response_invalid" };
  }
  return { kind: "ready", priceVersionId: selected.priceVersionId,
    provider: selected.provider, modelId: selected.modelId,
    reasoningEffort: selected.reasoningEffort };
}
