import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { DESKTOP_AUTH_CLIENT, DESKTOP_AUTH_VALUE, isDesktopRedirect } from "@/lib/desktopAuthContract";
import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { enforceMobileAuthAdmission, requireMobileBearer } from "@/lib/mobileAuthRoute";

export const desktopAuthEnabled = () => process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && mobileAuthReady();

export const desktopLoginContext = {
  clientId: z.literal(DESKTOP_AUTH_CLIENT),
  redirectUri: z.string().max(64).refine(isDesktopRedirect),
  state: z.string().regex(DESKTOP_AUTH_VALUE),
};

export const desktopAuthResponse = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const desktopAuthUnavailable = () => desktopAuthResponse({ ok: false, code: "NOT_AVAILABLE" }, 503);

export function desktopAuthNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

const refresh = z.object({ refreshToken: z.string().min(1).max(512) }).strict();

export async function readDesktopRefreshToken(request: Request): Promise<string> {
  await enforceMobileAuthAdmission(request, "desktop");
  return (await readLimitedJson(request, 1_024, refresh)).refreshToken;
}

export async function requireDesktopBearer(request: Request) {
  if (!desktopAuthEnabled()) return { ok: false as const, response: desktopAuthUnavailable() };
  const result = await requireMobileBearer(request, "desktop");
  if (!result.ok) desktopAuthNoStore(result.response);
  return result;
}
