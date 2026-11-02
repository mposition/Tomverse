import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptOAuthToken } from "@/lib/oauthTokenCrypto";
import { appleCredentials, revokeAppleToken } from "@/lib/appleAuth";

export async function revokeAppleAccountTokens(userId: string) {
  const accounts = await prisma.account.findMany({ where: { userId, provider: "apple" }, select: { refresh_token: true, access_token: true } });
  if (accounts.length === 0) return;
  const credentials = appleCredentials();
  if (!credentials) throw new Error("APPLE_REVOCATION_NOT_CONFIGURED");
  for (const account of accounts) {
    const refresh = decryptOAuthToken(account.refresh_token);
    const access = decryptOAuthToken(account.access_token);
    if (!refresh && !access) throw new Error("APPLE_REVOCATION_TOKEN_MISSING");
    await revokeAppleToken(credentials, refresh ?? access!, refresh ? "refresh_token" : "access_token");
  }
}
