const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const READ_TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 256;

/** Only an exact authenticated 200 with stop:false lets a live CLI continue.
 * All transport, parsing and authority uncertainty requests process-group
 * termination; no prompt, response text or credential reaches diagnostics. */
export async function shouldStopAmuxV19LocalAnalysis(input) {
  if (!input || !ID.test(input.holdId ?? "") ||
      !SECRET.test(input.agentSecret ?? "") ||
      typeof input.fetchImpl !== "function") return true;
  let endpoint;
  try {
    const origin = new URL(input.origin);
    if (origin.protocol !== "https:" || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash) return true;
    endpoint = new URL("/api/internal/amux/v19/analysis-stop", origin);
    endpoint.searchParams.set("holdId", input.holdId);
  } catch { return true; }
  const url = endpoint.toString();
  try {
    const response = await input.fetchImpl(url, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(READ_TIMEOUT_MS),
        input.signal ?? new AbortController().signal]),
      headers: { authorization: `Bearer ${input.agentSecret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (input.signal?.aborted || response.status !== 200 ||
        response.url && response.url !== url ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json") {
      try { await response.body?.cancel(); } catch { /* No reply body in logs. */ }
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
          !Array.isArray(parsed) && Object.keys(parsed).length === 2 &&
          parsed.holdId === input.holdId && parsed.stop === false);
      } finally { combined.fill(0); }
    } finally {
      for (const part of parts) part.fill(0);
      try { await reader.cancel(); } catch { /* No body text in diagnostics. */ }
      reader.releaseLock();
    }
  } catch { return true; }
}
