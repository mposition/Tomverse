import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { listDesktopRemoteDevices } from "@/lib/desktopRemoteControlStore";
import { desktopRemoteMayAct, desktopRemoteWebSession, remoteJson } from "@/lib/desktopRemoteControlWeb";

export const dynamic = "force-dynamic";

/** The signed-in account's PCs that report now, their running tasks and the request on each PC's screen. */
export async function GET(request: Request) {
  const auth = await desktopRemoteWebSession(request);
  if (!auth.session) return auth.response;
  const userId = auth.session.user.id;
  try {
    // The screen refreshes every few seconds while it is open.
    await consumeApiRateLimit(request, userId, "desktop-remote-read", { minute: 60, day: 20_000 });
    const devices = await listDesktopRemoteDevices(userId);
    return remoteJson(200, { ok: true, canAct: desktopRemoteMayAct(auth.session), devices });
  } catch (error) {
    return apiSecurityResponse(error) ?? remoteJson(500, { ok: false, code: "READ_FAILED" });
  }
}
