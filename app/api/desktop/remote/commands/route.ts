import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopRemoteCommandRequest } from "@/lib/desktopRemoteControlContract";
import { DesktopRemoteRefused, recordDesktopRemoteCommand } from "@/lib/desktopRemoteControlStore";
import { desktopRemoteMayAct, desktopRemoteWebSession, remoteJson } from "@/lib/desktopRemoteControlWeb";

export const dynamic = "force-dynamic";

/**
 * One answer (allow once or deny), stop or follow-up for a task on one of the account's PCs. Recorded with the person's
 * audit entry; the PC picks it up and decides whether it still applies. A session that is not recently signed in may
 * only look.
 */
export async function POST(request: Request) {
  const auth = await desktopRemoteWebSession(request);
  if (!auth.session) return auth.response;
  if (!desktopRemoteMayAct(auth.session)) {
    return remoteJson(428, { ok: false, code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  }
  try {
    await consumeApiRateLimit(request, auth.session.user.id, "desktop-remote-command", { minute: 20, day: 400 });
    const command = await readLimitedJson(request, 4 * 1024, desktopRemoteCommandRequest);
    const { id } = await recordDesktopRemoteCommand({ session: auth.session, request, command });
    return remoteJson(201, { ok: true, id });
  } catch (error) {
    if (error instanceof DesktopRemoteRefused) {
      return remoteJson(error.code === "DEVICE_NOT_FOUND" ? 404 : 409, { ok: false, code: error.code });
    }
    return apiSecurityResponse(error) ?? remoteJson(500, { ok: false, code: "COMMAND_FAILED" });
  }
}
