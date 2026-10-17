/** One content-free v19 session reservation poll by the local intake Agent.
 * This is discovery only: no claim, decryption, CLI launch or retry. */
export const AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV =
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const exactKeys = (value, expected) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const validIso = (value) => typeof value === "string" && UTC_ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function endpointFromOrigin(origin) {
  if (typeof origin !== "string" || origin.length > 512) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return new URL("/api/internal/amux/v19/analysis-queue", url).toString();
  } catch { return null; }
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch { return null; }
  finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* Never log response content. */ }
    reader.releaseLock();
  }
}

function validQueue(value) {
  if (!exactKeys(value, ["candidates", "hasMore", "nextCursor"]) ||
      !Array.isArray(value.candidates) || value.candidates.length > 32 ||
      typeof value.hasMore !== "boolean" ||
      (value.hasMore ? typeof value.nextCursor !== "string" ||
        !CURSOR.test(value.nextCursor) || value.candidates.length !== 32
        : value.nextCursor !== null)) return false;
  return value.candidates.every((candidate) =>
    exactKeys(candidate, ["reservationId", "ideaId", "modelId", "expiresAt"]) &&
    typeof candidate.reservationId === "string" && UUID.test(candidate.reservationId) &&
    typeof candidate.ideaId === "string" && ID.test(candidate.ideaId) &&
    typeof candidate.modelId === "string" && MODEL_ID.test(candidate.modelId) &&
    validIso(candidate.expiresAt));
}

export async function pollAmuxV19SessionAnalysisCandidateIds({ origin, agentSecret,
  after = null, fetchImpl = fetch }) {
  const endpoint = endpointFromOrigin(origin);
  const pinned = endpointFromOrigin(process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
  if (!endpoint || !pinned || endpoint !== pinned ||
      typeof agentSecret !== "string" || !SECRET.test(agentSecret) ||
      (after !== null && (typeof after !== "string" || !CURSOR.test(after))) ||
      typeof fetchImpl !== "function") return { kind: "refused" };
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${agentSecret}`,
        "x-amux-agent-id": "amux-intake", "content-type": "application/json" },
      body: JSON.stringify(after === null ? {} : { after }),
    });
    if (response.url && response.url !== endpoint) {
      try { await response.body?.cancel(); } catch { /* No response logging. */ }
      return { kind: "unavailable" };
    }
    if (response.status === 409) return { kind: "disabled" };
    if (response.status !== 200 ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return { kind: "unavailable" };
    const data = await readBoundedJson(response);
    return validQueue(data) ? { kind: "candidates", ...data } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}
