import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";

/** One content-free v19 session reservation poll by the local intake Agent.
 * This is discovery only: no claim, decryption, CLI launch or retry. Each
 * candidate names its CLI channel (`provider`). */
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

function validQueue(value) {
  if (!exactKeys(value, ["candidates", "hasMore", "nextCursor"]) ||
      !Array.isArray(value.candidates) || value.candidates.length > 32 ||
      typeof value.hasMore !== "boolean" ||
      (value.hasMore ? typeof value.nextCursor !== "string" ||
        !CURSOR.test(value.nextCursor) || value.candidates.length !== 32
        : value.nextCursor !== null)) return false;
  return value.candidates.every((candidate) =>
    exactKeys(candidate, ["reservationId", "ideaId", "provider", "modelId",
      "expiresAt", "nextInvocationOrdinal"]) &&
    isAmuxIdeaAnalysisProvider(candidate.provider) &&
    typeof candidate.reservationId === "string" && UUID.test(candidate.reservationId) &&
    typeof candidate.ideaId === "string" && ID.test(candidate.ideaId) &&
    typeof candidate.modelId === "string" && MODEL_ID.test(candidate.modelId) &&
    validIso(candidate.expiresAt) &&
    Number.isSafeInteger(candidate.nextInvocationOrdinal) &&
    candidate.nextInvocationOrdinal >= 0 &&
    candidate.nextInvocationOrdinal <= 2_147_483_647);
}

async function pollCandidates({ origin, agentSecret,
  after = null, fetchImpl = fetch }, agentId) {
  const endpoint = endpointFromOrigin(origin);
  const pinned = endpointFromOrigin(process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
  if (!endpoint || !pinned || endpoint !== pinned ||
      !["amux-intake", "amux-intake-max"].includes(agentId) ||
      typeof agentSecret !== "string" || !SECRET.test(agentSecret) ||
      (after !== null && (typeof after !== "string" || !CURSOR.test(after))) ||
      typeof fetchImpl !== "function") return { kind: "refused" };
  // Discovery is read-only even though it is a POST: asking again is safe.
  const reply = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "POST", purpose: "read", timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    headers: { authorization: ["Bearer", agentSecret].join(" "),
      "x-amux-agent-id": agentId, "content-type": "application/json" },
    body: JSON.stringify(after === null ? {} : { after }) });
  const data = amuxV19ReplyJson(reply);
  if (reply.kind !== "response") return { kind: "unavailable",
    reason: amuxV19ReplyReason(reply) };
  if (reply.status === 409) return { kind: "disabled" };
  if (reply.status === 400 && after !== null) return { kind: "cursor_rejected" };
  return reply.status === 200 && validQueue(data)
    ? { kind: "candidates", ...data }
    : { kind: "unavailable", reason: "response_invalid" };
}

export async function pollAmuxV19SessionAnalysisCandidateIds(input) {
  return pollCandidates(input, "amux-intake");
}

/** The Max launcher discovers content-free reservations with its own secret. */
export async function pollAmuxV19MaxSessionAnalysisCandidateIds(input) {
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  return pollCandidates({ ...input, agentSecret }, "amux-intake-max");
}
