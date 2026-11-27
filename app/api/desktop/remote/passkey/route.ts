import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopRemoteNeedsPasskey, desktopRemotePasskeyRequest } from "@/lib/desktopRemoteControlContract";
import { precheckDesktopRemoteCommand } from "@/lib/desktopRemoteControlStore";
import { desktopRemoteMayAct, desktopRemoteWebSession, remoteJson } from "@/lib/desktopRemoteControlWeb";
import {
  assertionOptions, commandBinding, confirmPasskey, PasskeyRefused, passkeyRelyingParty, registerPasskey, registrationOptions, removalBinding,
  removePasskey,
} from "@/lib/desktopRemotePasskeyStore";
import { desktopRemotePasskeyEnabled } from "@/lib/nativeBearerGate";

export const dynamic = "force-dynamic";

const STATUS: Record<PasskeyRefused["code"], number> = {
  RELYING_PARTY: 403, LIMIT: 409, NO_PASSKEY: 409, CHALLENGE: 409, INVALID: 403, DUPLICATE: 409, NOT_FOUND: 404, CONFIRMATION_REQUIRED: 428,
};

/**
 * Passkeys that confirm remote approvals (docs/ops/desktop-remote-control.md): the options for registering one, for
 * confirming one command or one removal, and the registration and removal themselves. Browser session only, signed in
 * recently, from one of this deployment's own origins. An account that has a passkey adds or removes one only with it.
 */
export async function POST(request: Request) {
  const auth = await desktopRemoteWebSession(request);
  if (!auth.session) return auth.response;
  if (!desktopRemotePasskeyEnabled()) return remoteJson(503, { ok: false, code: "NOT_AVAILABLE" });
  if (!desktopRemoteMayAct(auth.session)) return remoteJson(428, { ok: false, code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  const rp = passkeyRelyingParty(request);
  if (!rp) return remoteJson(403, { ok: false, code: "PASSKEY_RELYING_PARTY" });
  const userId = auth.session.user.id;
  try {
    await consumeApiRateLimit(request, userId, "desktop-remote-passkey", { minute: 20, day: 300 });
    const body = await readLimitedJson(request, 48 * 1024, desktopRemotePasskeyRequest);
    if (body.action === "options-register") return remoteJson(200, { ok: true, ...await registrationOptions(auth.session, rp) });
    if (body.action === "options-remove") return remoteJson(200, { ok: true, ...await assertionOptions(userId, rp, "remove", removalBinding(body.passkeyId)) });
    if (body.action === "options-command") {
      // Deny and stop reduce what happens: there is nothing to confirm.
      if (!desktopRemoteNeedsPasskey(body.command)) throw new PasskeyRefused("INVALID");
      // No challenge, and no biometric prompt, for a command the PC's latest report no longer allows.
      const stale = await precheckDesktopRemoteCommand(userId, body.command);
      if (stale) return remoteJson(stale === "DEVICE_NOT_FOUND" ? 404 : 409, { ok: false, code: stale });
      return remoteJson(200, { ok: true, ...await assertionOptions(userId, rp, "command", commandBinding(body.command)) });
    }
    if (body.action === "register") {
      const created = await registerPasskey({
        session: auth.session, request, rp, label: body.label, challengeId: body.challengeId, credentialId: body.credentialId,
        clientDataJSON: body.clientDataJSON, attestationObject: body.attestationObject, passkey: body.passkey,
      });
      return remoteJson(201, { ok: true, passkey: created });
    }
    const confirmed = await confirmPasskey({ userId, rp, purpose: "remove", bindingHash: removalBinding(body.passkeyId), assertion: body.passkey });
    await removePasskey({ session: auth.session, request, passkeyId: body.passkeyId, confirmedBy: confirmed.passkeyId });
    return remoteJson(200, { ok: true });
  } catch (error) {
    if (error instanceof PasskeyRefused) return remoteJson(STATUS[error.code], { ok: false, code: `PASSKEY_${error.code}` });
    return apiSecurityResponse(error) ?? remoteJson(500, { ok: false, code: "PASSKEY_FAILED" });
  }
}
