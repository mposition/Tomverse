import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPLY_BYTES = 512;

function endpointFor(origin) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    return new URL("/api/internal/amux/v19/checkout-reference", requested).toString();
  } catch { return null; }
}

/** The worker may resolve a repository only through the app's exact active
 * claim. A redirect, malformed body or uncertain response grants no checkout. */
export async function readAmuxV19SessionCheckoutReference(input) {
  const endpoint = endpointFor(input?.origin);
  if (!endpoint || !UUID.test(input?.claimId ?? "") ||
      !UUID.test(input?.reservationId ?? "") ||
      !UUID.test(input?.ideaId ?? "") ||
      !Number.isSafeInteger(input?.referenceOrdinal) ||
      input.referenceOrdinal < 0 || input.referenceOrdinal > 2_147_483_647 ||
      !SECRET.test(input?.agentSecret ?? "") ||
      typeof input?.fetchImpl !== "function") return { kind: "unavailable" };
  try {
    const response = await input.fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${input.agentSecret}`,
        "x-amux-agent-id": "amux-intake", "content-type": "application/json" },
      body: JSON.stringify({ reservationId: input.reservationId,
        ideaId: input.ideaId, claimId: input.claimId,
        referenceOrdinal: input.referenceOrdinal }),
    });
    if (response.status !== 200 || response.url && response.url !== endpoint ||
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
        if (size > MAX_REPLY_BYTES) return { kind: "unavailable" };
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks, size);
      try {
        const target = JSON.parse(raw.toString("utf8"));
        if (!target || typeof target !== "object" || Array.isArray(target) ||
            Object.keys(target).length !== 5 ||
            !Number.isSafeInteger(target.referenceCount) ||
            target.referenceCount <= input.referenceOrdinal ||
            !["repository", "pull_request"].includes(target.kind) ||
            typeof target.repository !== "string" ||
            !REPOSITORY.test(target.repository) ||
            target.repository.split("/").some((part) => part === "." || part === "..") ||
            typeof target.pinnedCommitSha !== "string" ||
            !SHA.test(target.pinnedCommitSha) ||
            (target.kind === "repository" && target.pullRequestNumber !== null) ||
            (target.kind === "pull_request" &&
              (!Number.isSafeInteger(target.pullRequestNumber) ||
               target.pullRequestNumber <= 0))) return { kind: "unavailable" };
        return target;
      } finally { raw.fill(0); }
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      try { await reader.cancel(); } catch { /* No response logging. */ }
      reader.releaseLock();
    }
  } catch { return { kind: "unavailable" }; }
}
