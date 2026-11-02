import "server-only";
import { prisma } from "@/lib/prisma";
import { appleCredentials, decryptOAuthToken, revokeAppleToken } from "@/lib/oauthTokenCrypto";

export class AppleAccountRevocationError extends Error {}

export async function revokeAppleAccountTokens(userId: string) {
  const accounts = await prisma.account.findMany({ where: { userId, provider: "apple" }, select: { refresh_token: true, access_token: true } });
  if (accounts.length === 0) return;
  const credentials = appleCredentials();
  if (!credentials) throw new AppleAccountRevocationError("APPLE_REVOCATION_NOT_CONFIGURED");
  try {
    for (const account of accounts) {
      const refresh = decryptOAuthToken(account.refresh_token);
      const access = decryptOAuthToken(account.access_token);
      if (!refresh && !access) throw new AppleAccountRevocationError("APPLE_REVOCATION_TOKEN_MISSING");
      await revokeAppleToken(credentials, refresh ?? access!, refresh ? "refresh_token" : "access_token");
    }
  } catch (error) {
    if (error instanceof AppleAccountRevocationError) throw error;
    // Do not attach provider bodies or decrypted credentials to operational logs.
    throw new AppleAccountRevocationError("APPLE_TOKEN_REVOCATION_FAILED");
  }
}
