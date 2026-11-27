import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopRemoteCommandRequest, desktopRemoteCommandSubmission, desktopRemoteNeedsPasskey } from "@/lib/desktopRemoteControlContract";
import { DesktopRemoteRefused, precheckDesktopRemoteCommand, recordDesktopRemoteCommand } from "@/lib/desktopRemoteControlStore";
import { desktopRemoteMayAct, desktopRemoteWebSession, remoteJson } from "@/lib/desktopRemoteControlWeb";
import { commandBinding, confirmPasskey, countPasskeys, PasskeyRefused, passkeyRelyingParty } from "@/lib/desktopRemotePasskeyStore";
import { desktopRemotePasskeyEnabled } from "@/lib/nativeBearerGate";

export const dynamic = "force-dynamic";

/**
 * One answer (allow once or deny), stop or follow-up for a task on one of the account's PCs. Recorded with the person's
 * audit entry; the PC picks it up and decides whether it still applies. A session that is not recently signed in may
 * only look. Where the server offers passkeys and the account has one, "allow once" and a follow-up also carry a passkey
 * assertion for exactly that command (docs/ops/desktop-remote-control.md).
 */
export async function POST(request: Request) {
  const auth = await desktopRemoteWebSession(request);
  if (!auth.session) return auth.response;
  if (!desktopRemoteMayAct(auth.session)) {
    return remoteJson(428, { ok: false, code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  }
  try {
    await consumeApiRateLimit(request, auth.session.user.id, "desktop-remote-command", { minute: 20, day: 400 });
    const submission = await readLimitedJson(request, 8 * 1024, desktopRemoteCommandSubmission);
    const passkey = submission.kind === "stop" ? undefined : submission.passkey;
    const command = desktopRemoteCommandRequest.parse(Object.fromEntries(Object.entries(submission).filter(([name]) => name !== "passkey")));
    let passkeyId: string | undefined;
    if (desktopRemotePasskeyEnabled() && desktopRemoteNeedsPasskey(command) && (await countPasskeys(auth.session.user.id)) > 0) {
      if (!passkey) return remoteJson(428, { ok: false, code: "PASSKEY_REQUIRED" });
      // A request that changed or was answered meanwhile is said so before the challenge is used up.
      const stale = await precheckDesktopRemoteCommand(auth.session.user.id, command);
      if (stale) return remoteJson(stale === "DEVICE_NOT_FOUND" ? 404 : 409, { ok: false, code: stale });
      const rp = passkeyRelyingParty(request);
      if (!rp) return remoteJson(403, { ok: false, code: "PASSKEY_INVALID" });
      passkeyId = (await confirmPasskey({ userId: auth.session.user.id, rp, purpose: "command", bindingHash: commandBinding(command), assertion: passkey })).passkeyId;
    }
    const { id } = await recordDesktopRemoteCommand({ session: auth.session, request, command, passkeyId });
    return remoteJson(201, { ok: true, id });
  } catch (error) {
    if (error instanceof PasskeyRefused) return remoteJson(403, { ok: false, code: "PASSKEY_INVALID" });
    if (error instanceof DesktopRemoteRefused) {
      return remoteJson(error.code === "DEVICE_NOT_FOUND" ? 404 : 409, { ok: false, code: error.code });
    }
    return apiSecurityResponse(error) ?? remoteJson(500, { ok: false, code: "COMMAND_FAILED" });
  }
}
