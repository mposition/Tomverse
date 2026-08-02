import { NextAuthOptions } from "next-auth";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { logAuthAuditEvent } from "@/lib/securityAudit";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";
import { verifyEmailLoginCode, verifyEmailLoginLink } from "@/lib/emailLogin";
import { appUrl } from "@/lib/accountEmails";
import { sessionCookiesAreSecure } from "@/lib/sessionCookiePolicy";

// next-auth v4's CredentialsProvider only exposes authorize()'s second
// argument as a RequestInternal (plain headers object, not a Headers
// instance) -- lib/emailLogin.ts's functions expect a real Request so they
// can reuse the same rate-limit/IP/audit-log helpers used by ordinary route
// handlers. This best-effort adapter is only used for IP/header extraction;
// if the header shape is ever unexpected, it falls back to an empty Request
// rather than failing the whole sign-in attempt.
const toRequestLike = (headers: Record<string, unknown> | undefined): Request => {
    try {
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers || {})) {
            if (typeof value === "string") normalized[key] = value;
        }
        return new Request("http://internal.invalid/auth/email-code", {
            headers: new Headers(normalized),
        });
    } catch {
        return new Request("http://internal.invalid/auth/email-code");
    }
};
import { sessionRevocationReason } from "@/lib/sessionRevocationCore";
import { readSessionSecuritySnapshot } from "@/lib/sessionSecurity";

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
    // SEC-010. NextAuth otherwise derives this from whether NEXTAUTH_URL starts
    // with https, so a deployment served over http -- or one relying on
    // x-forwarded-* with NEXTAUTH_URL unset -- silently issued the session
    // cookie without `Secure` and without the `__Secure-` prefix. Stating it
    // means the cookie's protection follows the environment, not a URL string
    // that nothing validated. `getSecurityEnvironmentStatus` now checks that
    // URL as well, so a production deploy that gets it wrong fails /api/ready
    // rather than shipping a downgradeable cookie.
    // The rule itself lives in lib/sessionCookiePolicy.ts, because the admin
    // E2E harness has to mint a cookie under the name this produces and cannot
    // import a server-only module to find out what that is. Stating it in two
    // places is what broke that harness the first time.
    useSecureCookies: sessionCookiesAreSecure(process.env.NODE_ENV),
    adapter: encryptedTokenAdapter,
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_ID as string,
            clientSecret: process.env.GOOGLE_SECRET as string,
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
        CredentialsProvider({
            id: "email-code",
            name: "Email code",
            credentials: {
                email: { label: "Email", type: "email" },
                code: { label: "Code", type: "text" },
                linkToken: { label: "Link token", type: "text" },
            },
            async authorize(credentials, req) {
                const request = toRequestLike(req?.headers);
                const result = credentials?.linkToken
                    ? await verifyEmailLoginLink(request, credentials.linkToken)
                    : credentials?.email && credentials?.code
                        ? await verifyEmailLoginCode(request, credentials.email, credentials.code)
                        : null;
                if (!result) throw new Error("EMAIL_CODE_INVALID");
                if (!result.ok) {
                    throw new Error(
                        result.reason === "locked" ? "EMAIL_CODE_LOCKED" : "EMAIL_CODE_INVALID"
                    );
                }
                return prisma.user.findUniqueOrThrow({
                    where: { id: result.userId },
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        image: true,
                        plan: true,
                        createdAt: true,
                        subscriptionStatus: true,
                        subscriptionCurrentPeriodEnd: true,
                    },
                });
            },
        }),
    ],
    pages: {
        signIn: '/auth/signin',
        error: '/auth/signin',
    },
    session: {
        strategy: "jwt",
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
                if (security.accountStatus === "pending_deletion" || security.accountStatus === "deletion_processing") {
                    // Only reachable after the provider already verified this
                    // identity (OAuth completed, or the emailed code/link was
                    // correct), so showing deletion-specific detail here does
                    // not expose account status to someone who hasn't proven
                    // ownership yet.
                    logAuthAuditEvent("auth.sign_in_denied_pending_deletion", {
                        userId: user.id,
                    });
                    return `${appUrl()}/auth/signin?error=AccountPendingDeletion`;
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
        async jwt({ token, user }) {
            if (user) {
                token.id = user.id;
                const analyticsUser = user as typeof user & {
                    plan?: unknown;
                    createdAt?: unknown;
                    subscriptionStatus?: string | null;
                    subscriptionCurrentPeriodEnd?: Date | null;
                };
                token.plan = effectivePlanForAccess({
                    plan: analyticsUser.plan,
                    subscriptionStatus: analyticsUser.subscriptionStatus,
                    subscriptionCurrentPeriodEnd:
                        analyticsUser.subscriptionCurrentPeriodEnd,
                });
                token.createdAt =
                    analyticsUser.createdAt instanceof Date
                        ? analyticsUser.createdAt.toISOString()
                        : undefined;
                token.authenticatedAt = new Date().toISOString();
                token.sessionIssuedAt = Date.now();
            }
            return token;
        },
        async session({ session, token }) {
            if (!session.user || !token.id) return session;

            // Sessions are JWTs, so there is no session row to delete. Check the
            // server-side revocation epoch and account status on every
            // resolution; otherwise a suspended or signed-out user keeps full
            // API access until their token expires.
            const snapshot = await readSessionSecuritySnapshot(token.id);
            const revocation = sessionRevocationReason({
                issuedAt: token.sessionIssuedAt ?? token.authenticatedAt,
                snapshot,
            });
            if (revocation) {
                logAuthAuditEvent("auth.session_rejected", {
                    userId: token.id,
                    reason: revocation,
                });
                // Strip the whole user object. Every authenticated route gates on
                // `session.user.id`, and admin routes additionally match on
                // email, so removing both makes the request unauthenticated
                // everywhere rather than only on the id check.
                return {
                    expires: session.expires,
                    user: {},
                } as typeof session;
            }

            session.user.id = token.id;
            session.user.plan = token.plan;
            session.user.createdAt = token.createdAt;
            session.user.authenticatedAt = token.authenticatedAt;
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
