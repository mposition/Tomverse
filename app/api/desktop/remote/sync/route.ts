import { consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable, requireDesktopBearer } from "@/lib/desktopAuthServer";
import { DESKTOP_REMOTE_LIMITS, desktopRemoteSyncRequest, desktopRemoteWithdrawRequest } from "@/lib/desktopRemoteControlContract";
import { syncDesktopRemote, withdrawDesktopRemote } from "@/lib/desktopRemoteControlStore";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { DESKTOP_APP_ORIGIN, desktopRemoteControlEnabled } from "@/lib/nativeBearerGate";

export const dynamic = "force-dynamic";

/**
 * The PC's side of remote control (docs/ops/desktop-remote-control.md): `POST` replaces its report and picks up the
 * answers waiting for it, `DELETE` removes both. Only the Desktop bearer of the device itself; never a cookie. Both
 * carry the PC's request number: a report that is not newer than the last one taken, or than the withdrawal, is
 * answered 409 with the number the server holds, and changes nothing.
 */
async function authorize(request: Request) {
  if (!desktopRemoteControlEnabled()) return { response: desktopAuthUnavailable() };
  if (request.headers.get("origin") !== DESKTOP_APP_ORIGIN || request.headers.has("cookie")) {
    return { response: desktopAuthResponse({ ok: false, code: "INVALID_AUTH_CONTEXT" }, 403) };
  }
  const auth = await requireDesktopBearer(request);
  if (!auth.ok) return { response: auth.response };
  return { identity: auth.identity };
}

export async function POST(request: Request) {
  const auth = await authorize(request);
  if (!auth.identity) return auth.response;
  const { userId, deviceId, familyId } = auth.identity;
  try {
    // About one sync every two seconds while an approval is on the PC's screen, every eight otherwise.
    await consumeApiRateLimit(request, userId, "desktop-remote-sync", { minute: 90, day: 40_000 });
    const body = await readLimitedJson(request, DESKTOP_REMOTE_LIMITS.uploadBytes, desktopRemoteSyncRequest);
    const synced = await syncDesktopRemote({ userId, deviceId, familyId }, body);
    if (!synced) return desktopAuthResponse({ ok: false, code: "UNAUTHORIZED" }, 401);
    if (synced.stale) return desktopAuthResponse({ ok: false, code: "STALE_SYNC", seq: synced.seq }, 409);
    return desktopAuthResponse({ ok: true, deviceId: synced.deviceId, commands: synced.commands });
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "SYNC_FAILED" }, 500));
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize(request);
  if (!auth.identity) return auth.response;
  const { userId, deviceId, familyId } = auth.identity;
  try {
    const body = await readLimitedJson(request, 1024, desktopRemoteWithdrawRequest);
    await withdrawDesktopRemote({ userId, deviceId, familyId }, body.seq);
    return desktopAuthNoStore(new Response(null, { status: 204 }));
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "WITHDRAW_FAILED" }, 500));
  }
}
