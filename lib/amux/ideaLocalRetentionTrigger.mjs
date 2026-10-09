/** One retention tick from the credential-isolated Ubuntu supervisor. A
 * durable marker is acquired before the request and is cleared only after a
 * known response. A crash or unknown outcome therefore stops future ticks. */
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const REQUEST_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 2_048;

function endpointFromOrigin(origin) {
  if (typeof origin !== "string" || origin.length > 512) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return new URL("/api/internal/amux/v4/content-retention", url).toString();
  } catch { return null; }
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return null;
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts, bytes).toString("utf8"));
  } catch { return null; }
  finally {
    try { await reader.cancel(); } catch { /* Never log response text. */ }
    reader.releaseLock();
  }
}

const object = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value);
const boundedCount = (value) => Number.isSafeInteger(value) && value >= 0 &&
  value <= 8;

function validCountGroup(value, fields) {
  return object(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => boundedCount(value[field]));
}

function validCompletedBody(value) {
  return object(value) && Object.keys(value).length === 5 &&
    validCountGroup(value.holdNotices, ["sent", "scanned", "batchLimit"]) &&
    validCountGroup(value.cancellation, ["cancelled", "scanned", "batchLimit"]) &&
    validCountGroup(value.raw, ["bodiesPurged", "keysDeleted", "scanned", "batchLimit"]) &&
    validCountGroup(value.analysis, ["bodiesPurged", "keysDeleted", "scanned", "batchLimit"]) &&
    object(value.taskResults) && Object.keys(value.taskResults).length === 2 &&
    value.taskResults.available === false &&
    value.taskResults.reason === "v22_task_result_retention_disabled";
}

export async function runAmuxV4LocalRetentionOnce({ origin, secret, claim, release,
  fetchImpl = fetch }) {
  const endpoint = endpointFromOrigin(origin);
  if (!endpoint || typeof secret !== "string" || !SECRET.test(secret) ||
      typeof claim !== "function" || typeof release !== "function" ||
      typeof fetchImpl !== "function") return { kind: "refused" };
  try {
    if (!await claim()) return { kind: "halted" };
  } catch { return { kind: "refused" }; }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-v4-intake-retention",
        "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
  } catch { return { kind: "halted" }; }
  if (response.url && response.url !== endpoint) return { kind: "halted" };
  if (response.headers.get("content-type")?.split(";")[0]?.trim()
    .toLowerCase() !== "application/json") return { kind: "halted" };
  const body = await readBoundedJson(response);
  const known = response.status === 200 ? validCompletedBody(body) :
    response.status === 409 && object(body) &&
      Object.keys(body).length === 2 && body.available === false &&
      body.reason === "content_retention_disabled";
  if (!known) return { kind: "halted" };
  try { await release(); }
  catch { return { kind: "halted" }; }
  return { kind: response.status === 200 ? "completed" : "disabled" };
}
