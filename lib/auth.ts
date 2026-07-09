import { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import NaverProvider from "next-auth/providers/naver";
import AzureADProvider from "next-auth/providers/azure-ad";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { logAuthAuditEvent } from "@/lib/securityAudit";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export const authOptions: NextAuthOptions = {
    secret: process.env.NEXTAUTH_SECRET,
    adapter: PrismaAdapter(prisma) as Adapter,
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_ID as string,
            clientSecret: process.env.GOOGLE_SECRET as string,
        }),
        NaverProvider({
            clientId: process.env.NAVER_ID as string,
            clientSecret: process.env.NAVER_SECRET as string,
        }),
        AzureADProvider({
            clientId: process.env.AZURE_AD_CLIENT_ID as string,
            clientSecret: process.env.AZURE_AD_CLIENT_SECRET as string,
            tenantId: process.env.AZURE_AD_TENANT_ID || "common",
        }),
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
            }
            return session;
        },
    },
    events: {
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
