import { z } from "zod";
import { POST as requestExistingEmailCode } from "@/app/api/auth/email-login/request/route";
import { readLimitedJson } from "@/lib/apiSecurity";
import { desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable } from "@/lib/desktopAuthServer";
import { verifyEmailLoginCode } from "@/lib/emailLogin";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "@/lib/emailValidation";
import { enforceMobileAuthAdmission, mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { issueMobileSession } from "@/lib/mobileAuthService";
import { nativeEmailLoginAccountActive } from "@/lib/nativeEmailLoginAccount";

export const dynamic = "force-dynamic";
const email = z.string().trim().toLowerCase().max(MAX_LOGIN_EMAIL_LENGTH).refine(isValidLoginEmail);
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), email, turnstileToken: z.string().trim().min(1).max(2_048).optional() }).strict(),
  z.object({ action: z.literal("verify"), email, code: z.string().regex(/^\d{6}$/),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(32) }).strict(),
]);

export async function POST(request: Request) {
  if (!desktopAuthEnabled() || process.env.TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED !== "true") return desktopAuthUnavailable();
  if (request.headers.has("origin") || request.headers.has("cookie")) {
    return desktopAuthResponse({ ok: false, code: "DESKTOP_LOGIN_REFUSED" }, 403);
  }
  try {
    await enforceMobileAuthAdmission(request, "desktop");
    const body = await readLimitedJson(request, 4_096, input);
    if (body.action === "request") {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("cookie");
      return desktopAuthNoStore(await requestExistingEmailCode(new Request(request.url, {
        method: "POST", headers, body: JSON.stringify({ email: body.email, turnstileToken: body.turnstileToken }),
      })));
    }
    const proof = await verifyEmailLoginCode(request, body.email, body.code, "signin");
    if (!proof.ok) return desktopAuthResponse({ ok: false,
      code: proof.reason === "locked" ? "EMAIL_CODE_LOCKED" : "EMAIL_CODE_INVALID" }, 401);
    if (!(await nativeEmailLoginAccountActive(proof.userId))) return desktopAuthResponse({ ok: false, code: "DESKTOP_LOGIN_REFUSED" }, 403);
    const { tokens } = await issueMobileSession({ request, userId: proof.userId, platform: "desktop", deviceLabel: "Desktop", appVersion: body.appVersion });
    return desktopAuthResponse({ ok: true, ...tokens });
  } catch (error) {
    const response = mobileApiSecurityResponse(error);
    return response ? desktopAuthNoStore(response) : desktopAuthResponse({ ok: false, code: "DESKTOP_LOGIN_FAILED" }, 500);
  }
}
