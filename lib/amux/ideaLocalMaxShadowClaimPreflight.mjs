import { AMUX_V19_TRACKED_CHECKOUT_CLI_ENV } from
  "./ideaTrackedCheckoutHostRunner.mjs";
import { signAmuxV19MaxClaimAttestation } from
  "./ideaSessionMaxLauncherAttestation.mjs";
import { amuxV19ChannelAdmits, amuxV19CliChannel } from
  "./ideaV19CliChannels.mjs";
import { verifyAmuxV19ChannelAuthSource } from "./ideaV19CliChannelHost.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRICE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Content-free identity for one fixed Ubuntu claim on one subscription CLI
 * channel (`provider`). Claude admits only its approved tuple; another
 * launchable channel admits a model its CLI takes by name and an effort it
 * supports. */
export function inspectAmuxV19MaxShadowClaimIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !UUID.test(input.claimId) || !UUID.test(input.requestId) ||
      !UUID.test(input.reservationId) || !UUID.test(input.ideaId) ||
      !Number.isSafeInteger(input.invocationOrdinal) ||
      input.invocationOrdinal < 0 || input.invocationOrdinal > 2_147_483_647 ||
      !PRICE_ID.test(input.priceVersionId) ||
      !amuxV19ChannelAdmits({ provider: input.provider, modelId: input.modelId,
        reasoningEffort: input.reasoningEffort })) return null;
  return Object.freeze({ claimId: input.claimId, requestId: input.requestId,
    reservationId: input.reservationId, ideaId: input.ideaId,
    invocationOrdinal: input.invocationOrdinal,
    priceVersionId: input.priceVersionId, provider: input.provider,
    modelId: input.modelId, reasoningEffort: input.reasoningEffort });
}

/** The fixed launcher calls this after receiving an exact queue/price
 * selection. It checks only the channel's sign-in file; no CLI or paid call
 * occurs. The signed proof binds the channel, so the app records the claim
 * on the channel whose sign-in was checked. */
export async function prepareAmuxV19MaxShadowClaim(input) {
  const identity = inspectAmuxV19MaxShadowClaimIdentity(input);
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!identity || process.platform !== "linux" ||
      process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] !== "enabled" ||
      !SECRET.test(secret ?? "")) return { kind: "refused" };
  try { await verifyAmuxV19ChannelAuthSource(identity.provider); }
  catch { return { kind: "auth_unavailable" }; }
  const authVerifiedAt = new Date().toISOString();
  const authProof = signAmuxV19MaxClaimAttestation(secret, identity,
    authVerifiedAt);
  return { kind: "ready", identity, authVerifiedAt, authProof,
    authProfile: amuxV19CliChannel(identity.provider).authProfile };
}
