import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";
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
async function readReference(input, agentId) {
  const endpoint = endpointFor(input?.origin);
  if (!endpoint || !UUID.test(input?.claimId ?? "") ||
      !UUID.test(input?.reservationId ?? "") ||
      !UUID.test(input?.ideaId ?? "") ||
      !Number.isSafeInteger(input?.referenceOrdinal) ||
      input.referenceOrdinal < 0 || input.referenceOrdinal > 2_147_483_647 ||
      !SECRET.test(input?.agentSecret ?? "") ||
      typeof input?.fetchImpl !== "function") return { kind: "unavailable" };
  // A read-only lookup sent as POST: asking again changes nothing.
  const reply = await amuxV19AppRequest({ fetchImpl: input.fetchImpl,
    url: endpoint, method: "POST", purpose: "read", timeoutMs: 5_000,
    maxBytes: MAX_REPLY_BYTES,
    headers: { authorization: `Bearer ${input.agentSecret}`,
      "x-amux-agent-id": agentId, "content-type": "application/json" },
    body: JSON.stringify({ reservationId: input.reservationId,
      ideaId: input.ideaId, claimId: input.claimId,
      referenceOrdinal: input.referenceOrdinal }) });
  const target = amuxV19ReplyJson(reply);
  if (reply.kind !== "response" || reply.status !== 200) return {
    kind: "unavailable", reason: amuxV19ReplyReason(reply) };
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
         target.pullRequestNumber <= 0))) return { kind: "unavailable",
    reason: "response_invalid" };
  return target;
}

export async function readAmuxV19SessionCheckoutReference(input) {
  return readReference(input, "amux-intake");
}

/** The Max launcher never needs the v4 Agent credential for this reference. */
export async function readAmuxV19MaxCheckoutReference(input) {
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!SECRET.test(secret ?? "")) return { kind: "unavailable" };
  return readReference({ ...input, agentSecret: secret }, "amux-intake-max");
}
