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

/** Any ambiguous stop poll terminates the exact local invocation. */
export async function shouldStopAmuxV19SessionAnalysis(input) {
  const endpoint = pinnedEndpoint(input?.origin);
  if (!endpoint || !UUID.test(input?.claimId ?? "") ||
      !UUID.test(input?.reservationId ?? "") ||
      !SECRET.test(input?.agentSecret ?? "") ||
      typeof input?.fetchImpl !== "function") return true;
  endpoint.searchParams.set("claimId", input.claimId);
  endpoint.searchParams.set("reservationId", input.reservationId);
  const url = endpoint.toString();
  try {
    const response = await input.fetchImpl(url, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(8_000),
        input.signal ?? new AbortController().signal]),
      headers: { authorization: `Bearer ${input.agentSecret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (input.signal?.aborted || response.status !== 200 ||
        response.url && response.url !== url ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json") {
      try { await response.body?.cancel(); } catch { /* No response logging. */ }
      return true;
    }
    const reader = response.body?.getReader();
    if (!reader) return true;
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) return true;
        bytes += value.byteLength;
        if (bytes > MAX_REPLY_BYTES) return true;
        parts.push(value);
      }
      const combined = Buffer.concat(parts, bytes);
      try {
        const parsed = JSON.parse(combined.toString("utf8"));
        return !(parsed && typeof parsed === "object" &&
          !Array.isArray(parsed) && Object.keys(parsed).length === 3 &&
          parsed.claimId === input.claimId &&
          parsed.reservationId === input.reservationId &&
          parsed.stop === false);
      } finally { combined.fill(0); }
    } finally {
      for (const part of parts) part.fill(0);
      try { await reader.cancel(); } catch { /* No response logging. */ }
      reader.releaseLock();
    }
  } catch { return true; }
}
