import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable, desktopLoginContext } from "@/lib/desktopAuthServer";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { isPkceChallenge, issueMobileLoginGrant } from "@/lib/mobileLoginGrant";

const schema = z.object({
  ...desktopLoginContext,
  codeChallenge: z.string().refine(isPkceChallenge),
  codeChallengeMethod: z.literal("S256"),
}).strict();

export async function POST(request: Request) {
  if (!desktopAuthEnabled()) return desktopAuthUnavailable();
  try {
    const userId = (await getServerSession(authOptions))?.user?.id;
    if (!userId) return desktopAuthResponse({ ok: false, code: "UNAUTHORIZED" }, 401);
    await consumeApiRateLimit(request, userId, "desktop-login-grant", { minute: 5, day: 20 });
    const body = await readLimitedJson(request, 1024, schema);
    const result = await issueMobileLoginGrant({ userId, codeChallenge: body.codeChallenge, desktop: body });
    return desktopAuthResponse({ ok: true, ...result });
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "GRANT_FAILED" }, 500));
  }
}
