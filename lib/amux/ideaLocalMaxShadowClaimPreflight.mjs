import { amuxV4ApprovedAnalysisCliForModel } from
  "./ideaLocalApprovedCliCatalog.mjs";
import { AMUX_V19_TRACKED_CHECKOUT_CLI_ENV } from
  "./ideaTrackedCheckoutHostRunner.mjs";
import { AMUX_V19_CLAUDE_MAX_AUTH_PATH,
  verifyAmuxV19ClaudeMaxAuthSource } from "./ideaV19ClaudeMaxAuth.mjs";
import { signAmuxV19MaxClaimAttestation } from
  "./ideaSessionMaxLauncherAttestation.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRICE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Content-free identity for one fixed Ubuntu claim. */
export function inspectAmuxV19MaxShadowClaimIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !UUID.test(input.claimId) || !UUID.test(input.requestId) ||
      !UUID.test(input.reservationId) || !UUID.test(input.ideaId) ||
      !Number.isSafeInteger(input.invocationOrdinal) ||
      input.invocationOrdinal < 0 || input.invocationOrdinal > 2_147_483_647 ||
      !PRICE_ID.test(input.priceVersionId)) return null;
  const approved = amuxV4ApprovedAnalysisCliForModel(input.modelId);
  if (approved?.provider !== "anthropic" ||
      approved.reasoningEffort !== input.reasoningEffort ||
      approved.egressHosts?.length !== 1 ||
      approved.egressHosts[0] !== "api.anthropic.com") return null;
  return Object.freeze({ claimId: input.claimId, requestId: input.requestId,
    reservationId: input.reservationId, ideaId: input.ideaId,
    invocationOrdinal: input.invocationOrdinal,
    priceVersionId: input.priceVersionId, modelId: approved.modelId,
    reasoningEffort: approved.reasoningEffort });
}

/** The fixed Max launcher calls this after receiving an exact queue/price
 * selection. It reads only OAuth file metadata; no CLI or paid call occurs. */
export async function prepareAmuxV19MaxShadowClaim(input) {
  const identity = inspectAmuxV19MaxShadowClaimIdentity(input);
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!identity || process.platform !== "linux" ||
      process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] !== "enabled" ||
      !SECRET.test(secret ?? "")) return { kind: "refused" };
  try { await verifyAmuxV19ClaudeMaxAuthSource(AMUX_V19_CLAUDE_MAX_AUTH_PATH); }
  catch { return { kind: "auth_unavailable" }; }
  const authVerifiedAt = new Date().toISOString();
  const authProof = signAmuxV19MaxClaimAttestation(secret, identity,
    authVerifiedAt);
  return { kind: "ready", identity,
    authVerifiedAt, authProof, authProfile: "claude-max-oauth" };
}
