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

/** Read-only current audited Max price ID. Claim admission rechecks it. */
export async function readAmuxV19MaxPriceSelection({ origin, reservationId,
  ideaId, fetchImpl = fetch }) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!UUID.test(reservationId ?? "") || !UUID.test(ideaId ?? "") ||
      !SECRET.test(secret ?? "") || typeof fetchImpl !== "function") {
    return { kind: "refused" };
  }
  const endpoint = endpointFor(origin, reservationId, ideaId);
  if (!endpoint) return { kind: "refused" };
  try {
    const response = await fetchImpl(endpoint, { method: "GET",
      redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-intake-max" },
    });
    if (response.status !== 200 ||
        (response.url && response.url !== endpoint) ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json") {
      try { await response.body?.cancel(); } catch { /* No response logging. */ }
      return { kind: "unavailable" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { kind: "unavailable" };
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) return { kind: "unavailable" };
        size += value.byteLength;
        if (size > 512) return { kind: "unavailable" };
        chunks.push(value);
      }
      const selected = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      if (!selected || typeof selected !== "object" ||
          Object.keys(selected).length !== 4 || selected.kind !== "ready" ||
          !PRICE_ID.test(selected.priceVersionId) ||
          !MODEL_ID.test(selected.modelId) ||
          !/^[A-Za-z0-9_-]{1,32}$/.test(selected.reasoningEffort)) {
        return { kind: "unavailable" };
      }
      return { kind: "ready", priceVersionId: selected.priceVersionId,
        modelId: selected.modelId,
        reasoningEffort: selected.reasoningEffort };
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      try { await reader.cancel(); } catch { /* No response logging. */ }
      reader.releaseLock();
    }
  } catch { return { kind: "unavailable" }; }
}
