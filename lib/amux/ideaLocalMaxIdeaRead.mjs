import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

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

/** Fetch one exact claimed idea. The v19 policy has no idea byte ceiling; do
 * not inherit the v4 preview cap. The caller must keep plaintext out of logs. */
export async function readAmuxV19MaxIdeaOnce({ origin, reservationId, ideaId,
  claimId, fetchImpl = fetch }) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  const endpoint = endpointFor(origin);
  if (!endpoint || !UUID.test(reservationId ?? "") ||
      !UUID.test(ideaId ?? "") || !UUID.test(claimId ?? "") ||
      !SECRET.test(secret ?? "") || typeof fetchImpl !== "function") {
    return { kind: "refused" };
  }
  try {
    const response = await fetchImpl(endpoint, { method: "POST",
      redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: ["Bearer", secret].join(" "),
        "x-amux-agent-id": "amux-intake-max",
        "content-type": "application/json" },
      body: JSON.stringify({ reservationId, ideaId, claimId }),
    });
    if (response.status !== 200 ||
        (response.url && response.url !== endpoint) ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json") {
      try { await response.body?.cancel(); } catch { /* No body logging. */ }
      return { kind: "unavailable" };
    }
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof value.idea !== "string" || !value.idea.trim()) {
      return { kind: "unavailable" };
    }
    return { kind: "ready", idea: value.idea };
  } catch { return { kind: "unavailable" }; }
}

/** A lost-response claim may be committed, but it does not authorize a
 * plaintext read or CLI dispatch. Keep the exact new identity attached. */
export async function readAmuxV19MaxClaimedIdeaOnce({ origin, selection,
  fetchImpl = fetch }) {
  const identity = selection?.identity;
  const claim = selection?.claim;
  if (selection?.kind !== "claimed" ||
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
