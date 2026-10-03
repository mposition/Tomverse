/** One metadata-only poll from the local Ubuntu source collector. Its result
 * must never be sent to the model child. No retry, claim or GitHub read here. */
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
export const AMUX_V4_COLLECTION_APP_ORIGIN_ENV = "TOMVERSE_AMUX_V4_COLLECTION_APP_ORIGIN";
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ownKeys = (value, expected) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const validIso = (value) => typeof value === "string" && UTC_ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function endpointFromOrigin(origin) {
  if (typeof origin !== "string" || origin.length > 512) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return new URL("/api/internal/amux/v4/collection-queue", url).toString();
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
    try { await reader.cancel(); } catch { /* Never log response text. */ }
    reader.releaseLock();
  }
}

function validQueue(value) {
  if (!ownKeys(value, ["candidates", "hasMore", "nextCursor"]) ||
      !Array.isArray(value.candidates) || value.candidates.length > 32 ||
      typeof value.hasMore !== "boolean" ||
      (value.hasMore ? value.candidates.length !== 32 ||
        typeof value.nextCursor !== "string" || !CURSOR.test(value.nextCursor)
        : value.nextCursor !== null)) return false;
  return value.candidates.every((candidate) =>
    ownKeys(candidate, ["collectionRequestId", "expiresAt"]) &&
    typeof candidate.collectionRequestId === "string" &&
    UUID.test(candidate.collectionRequestId) && validIso(candidate.expiresAt));
}

export async function pollAmuxV4CollectionCandidateIds({ origin, collectorSecret,
  after = null, fetchImpl = fetch }) {
  const endpoint = endpointFromOrigin(origin);
  // The pinned origin is operator-controlled process configuration, never
  // idea/model/document data supplied by a caller. Refuse before fetch if it
  // is absent or the caller tries to redirect the bearer token elsewhere.
  const pinnedEndpoint = endpointFromOrigin(process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV]);
  if (!endpoint || !pinnedEndpoint || endpoint !== pinnedEndpoint ||
      typeof collectorSecret !== "string" || !SECRET.test(collectorSecret) ||
      (after !== null && (typeof after !== "string" || !CURSOR.test(after))) ||
      typeof fetchImpl !== "function") return { kind: "refused" };
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${collectorSecret}`,
        "x-amux-agent-id": "amux-v4-source-collector", "content-type": "application/json" },
      body: JSON.stringify(after === null ? {} : { after }),
    });
    if (response.status === 409) return { kind: "disabled" };
    if (response.status !== 200 ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return { kind: "unavailable" };
    const data = await readBoundedJson(response);
    return validQueue(data) ? { kind: "candidates", ...data } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}
