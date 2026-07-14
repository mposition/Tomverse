import { NextAuthOptions } from "next-auth";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import NaverProvider from "next-auth/providers/naver";
import AzureADProvider from "next-auth/providers/azure-ad";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { logAuthAuditEvent } from "@/lib/securityAudit";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
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
        async session({ session, user }) {
            if (session.user && user.id) {
                session.user.id = user.id;
                const analyticsUser = user as typeof user & {
                    plan?: unknown;
                    createdAt?: unknown;
                };
                session.user.plan =
                    analyticsUser.plan === "Pro" || analyticsUser.plan === "Max"
                        ? analyticsUser.plan
                        : "Free";
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
