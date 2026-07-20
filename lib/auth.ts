import { cookies } from "next/headers";
import { NextAuthOptions } from "next-auth";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import NaverProvider from "next-auth/providers/naver";
import AzureADProvider from "next-auth/providers/azure-ad";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { logAuthAuditEvent } from "@/lib/securityAudit";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
const SESSION_COOKIE_NAMES = [
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
];
const azureTenantId = process.env.AZURE_AD_TENANT_ID?.trim();
const hasCompleteAzureConfiguration = [
    process.env.AZURE_AD_CLIENT_ID,
    process.env.AZURE_AD_CLIENT_SECRET,
    azureTenantId,
].every((value) => typeof value === "string" && value.trim().length > 0);

const baseAdapter = PrismaAdapter(prisma) as Adapter;
const encryptedTokenAdapter: Adapter = {
    ...baseAdapter,
    async linkAccount(account: AdapterAccount) {
        return baseAdapter.linkAccount?.(encryptOAuthAccountTokens(account));
    },
};

export const authOptions: NextAuthOptions = {
    secret: process.env.NEXTAUTH_SECRET,
    adapter: encryptedTokenAdapter,
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_ID as string,
            clientSecret: process.env.GOOGLE_SECRET as string,
        }),
        NaverProvider({
            clientId: process.env.NAVER_ID as string,
            clientSecret: process.env.NAVER_SECRET as string,
        }),
        ...(hasCompleteAzureConfiguration
            ? [
                  AzureADProvider({
                      clientId: process.env.AZURE_AD_CLIENT_ID as string,
                      clientSecret: process.env.AZURE_AD_CLIENT_SECRET as string,
                      tenantId: azureTenantId as string,
                  }),
              ]
            : []),
    ],
    pages: {
        signIn: '/auth/signin',
        error: '/auth/signin',
    },
    session: {
        strategy: "database",
        maxAge: SESSION_MAX_AGE_SECONDS,
        updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    callbacks: {
        async signIn({ user }) {
            if (!user.id) return false;
            try {
                const security = await prisma.user.findUnique({
                    where: { id: user.id },
                    select: {
                        accountStatus: true,
                        accountSuspendedUntil: true,
                    },
                });
                if (!security || security.accountStatus === "active") {
                    return true;
                }
                if (
                    security.accountStatus === "suspended" &&
                    security.accountSuspendedUntil &&
                    security.accountSuspendedUntil <= new Date()
                ) {
                    await prisma.user.update({
                        where: { id: user.id },
                        data: {
                            accountStatus: "active",
                            accountSuspendedAt: null,
                            accountSuspendedUntil: null,
                            accountSuspensionReason: null,
                            accountSuspendedById: null,
                            accountSuspendedByEmail: null,
                        },
                    });
                    return true;
                }
                logAuthAuditEvent("auth.sign_in_denied_suspended", {
                    userId: user.id,
                });
                return false;
            } catch (error) {
                console.error("Account suspension check failed during sign-in:", error);
                return false;
            }
        },
        async session({ session, user }) {
            if (session.user && user.id) {
                session.user.id = user.id;
                try {
                    const cookieStore = await cookies();
                    const sessionToken = SESSION_COOKIE_NAMES.reduce<string | undefined>(
                        (found, name) => found ?? cookieStore.get(name)?.value,
                        undefined
                    );
                    const activeSession = sessionToken
                        ? await prisma.session.findUnique({
                              where: { sessionToken },
                              select: { userId: true, createdAt: true },
                          })
                        : null;
                    session.user.authenticatedAt =
                        activeSession && activeSession.userId === user.id
                            ? activeSession.createdAt.toISOString()
                            : undefined;
                } catch (error) {
                    console.error("Failed to resolve session token for authenticatedAt:", error);
                    session.user.authenticatedAt = undefined;
                }
                const analyticsUser = user as typeof user & {
                    plan?: unknown;
                    createdAt?: unknown;
                    subscriptionStatus?: string | null;
                    subscriptionCurrentPeriodEnd?: Date | null;
                };
                session.user.plan = effectivePlanForAccess({
                    plan: analyticsUser.plan,
                    subscriptionStatus: analyticsUser.subscriptionStatus,
                    subscriptionCurrentPeriodEnd:
                        analyticsUser.subscriptionCurrentPeriodEnd,
                });
                session.user.createdAt =
                    analyticsUser.createdAt instanceof Date
                        ? analyticsUser.createdAt.toISOString()
                        : undefined;
            }
            return session;
        },
    },
    events: {
        async createUser({ user }) {
            logAuthAuditEvent("auth.create_user", {
                userId: user.id,
            });
        },
        async signIn({ user, account, isNewUser }) {
            await prisma.user
                .update({
                    where: { id: user.id },
                    data: { lastLoginAt: new Date() },
                })
                .catch((error) => {
                    console.error("Failed to record last login time:", error);
                });
            logAuthAuditEvent("auth.sign_in", {
                userId: user.id,
                provider: account?.provider,
                isNewUser,
            });
        },
        async signOut(message) {
            const adapterSession = message as unknown as {
                session?: { userId?: string };
            };
            logAuthAuditEvent("auth.sign_out", {
                userId: adapterSession.session?.userId,
            });
        },
        async linkAccount({ user, account }) {
            logAuthAuditEvent("auth.link_account", {
                userId: user.id,
                provider: account.provider,
            });
        },
    },
};
