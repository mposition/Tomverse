import { randomUUID } from "node:crypto";
import { encode } from "next-auth/jwt";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable, requireDesktopBearer } from "@/lib/desktopAuthServer";
import { buildDesktopSettingsClaim, desktopRecentAuthEnabled, readLiveDesktopFamilyCreatedAt } from "@/lib/desktopSettingsSessionCore";
import { effectivePlanForAccess, STORE_ENTITLEMENT_SELECT } from "@/lib/foundingTesterPassCore";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const settingsSessionSeconds = 300;

export async function POST(request: Request) {
  if (process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED !== "true") return desktopAuthUnavailable();
  const auth = await requireDesktopBearer(request);
  if (!auth.ok) return auth.response;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return desktopAuthResponse({ ok: false, code: "NOT_AVAILABLE" }, 503);
  try {
    await consumeApiRateLimit(request, auth.identity.userId, "desktop-settings-session", { minute: 15, day: 500 });
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthUnavailable());
  }

  const account = await prisma.user.findUnique({
    where: { id: auth.identity.userId },
    select: {
      id: true, name: true, email: true, createdAt: true, plan: true, accountStatus: true,
      subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, ...STORE_ENTITLEMENT_SELECT,
    },
  });
  if (!account || account.accountStatus !== "active") {
    return desktopAuthResponse({ ok: false, code: "UNAUTHORIZED" }, 401);
  }

  const now = new Date();
  // Default off. When on, the claim is the creation time of this device's live
  // token family (set by the real sign-in; a refresh never moves it). A family
  // that is not this user's, this device's, or live yields no session at all.
  const recentAuth = desktopRecentAuthEnabled();
  let familyCreatedAt: Date | null = null;
  if (recentAuth) {
    familyCreatedAt = await readLiveDesktopFamilyCreatedAt(prisma, auth.identity, now);
    if (!familyCreatedAt) return desktopAuthResponse({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const expiresAt = now.getTime() + settingsSessionSeconds * 1_000;
  const token = await encode({
    secret,
    maxAge: settingsSessionSeconds,
    token: {
      sub: account.id, id: account.id, name: account.name, email: account.email,
      createdAt: account.createdAt?.toISOString(),
      plan: effectivePlanForAccess(account, now),
      sessionIssuedAt: now.getTime(), absoluteExpiresAt: expiresAt,
      // The embedded session follows the Desktop device and token family.
      desktopSettings: buildDesktopSettingsClaim({
        familyId: auth.identity.familyId, deviceId: auth.identity.deviceId, tokenId: randomUUID(),
        familyCreatedAt, enabled: recentAuth,
      }),
    },
  });
  return desktopAuthResponse({ token, expiresAt });
}
