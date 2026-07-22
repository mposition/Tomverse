import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

// Self-service "add Google/Microsoft to my already-logged-in account". NextAuth
// v4's OAuth callbacks.signIn has no access to the incoming request/cookies, so
// there's no supported way to bind an OAuth redirect to "whichever browser
// session started it" from inside NextAuth's own pipeline. This is a small,
// self-contained OAuth2 + PKCE client (plain fetch, no SDK) that bypasses
// NextAuth entirely for just this one action, reusing this codebase's existing
// signed-cookie (HMAC + timingSafeEqual) and token-encryption conventions.

export type LinkableProvider = "google" | "azure-ad";

export class OAuthLinkError extends Error {
    constructor(
        public readonly code: string,
        message: string
    ) {
        super(message);
    }
}

const STATE_COOKIE = "tomverse_oauth_link_state";
const STATE_TTL_SECONDS = 10 * 60;

const secret = () => {
    const value = process.env.NEXTAUTH_SECRET;
    if (!value) throw new OAuthLinkError("NOT_CONFIGURED", "Linking is not configured.");
    return value;
};

function providerConfig(provider: LinkableProvider) {
    if (provider === "google") {
        const clientId = process.env.GOOGLE_ID;
        const clientSecret = process.env.GOOGLE_SECRET;
        if (!clientId || !clientSecret) {
            throw new OAuthLinkError("NOT_CONFIGURED", "Google is not configured.");
        }
        return {
            clientId,
            clientSecret,
            authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
            scope: "openid email profile",
        };
    }
    const clientId = process.env.AZURE_AD_CLIENT_ID;
    const clientSecret = process.env.AZURE_AD_CLIENT_SECRET;
    const tenantId = process.env.AZURE_AD_TENANT_ID?.trim();
    if (!clientId || !clientSecret || !tenantId) {
        throw new OAuthLinkError("NOT_CONFIGURED", "Microsoft is not configured.");
    }
    return {
        clientId,
        clientSecret,
        authorizeUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
        scope: "openid email profile",
    };
}

const redirectUriFor = (request: Request) =>
    `${getPublicAppOrigin(request)}/api/user/login-methods/oauth/callback`;

const signState = (payload: string) =>
    createHmac("sha256", secret()).update(`oauth-link-state:${payload}`).digest("base64url");

const buildStateCookie = (payload: string) => {
    const signature = signState(payload);
    const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${STATE_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secureFlag}`;
};

const readCookie = (request: Request, name: string) => {
    const header = request.headers.get("cookie") || "";
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }
    return null;
};

type LinkState = {
    userId: string;
    provider: LinkableProvider;
    codeVerifier: string;
    nonce: string;
    expiresAt: number;
};

const readStateCookie = (request: Request): LinkState | null => {
    const raw = readCookie(request, STATE_COOKIE);
    if (!raw) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    const signature = decoded.slice(lastDot + 1);

    const expected = signState(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
        return null;
    }

    const [userId, provider, codeVerifier, nonce, expiresAtRaw] = payload.split(":");
    const expiresAt = Number(expiresAtRaw);
    if (
        !userId ||
        (provider !== "google" && provider !== "azure-ad") ||
        !codeVerifier ||
        !nonce ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
    ) {
        return null;
    }
    return { userId, provider, codeVerifier, nonce, expiresAt };
};

export function buildOAuthLinkAuthorizeRedirect(
    request: Request,
    userId: string,
    provider: LinkableProvider
) {
    const config = providerConfig(provider);
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const nonce = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + STATE_TTL_SECONDS * 1000;
    const payload = `${userId}:${provider}:${codeVerifier}:${nonce}:${expiresAt}`;
    const cookie = buildStateCookie(payload);

    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUriFor(request),
        response_type: "code",
        scope: config.scope,
        state: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
    });
    return { url: `${config.authorizeUrl}?${params.toString()}`, cookie };
}

export const clearOAuthLinkStateCookie = () =>
    `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function completeOAuthLink(
    request: Request,
    currentUserId: string,
    provider: LinkableProvider,
    code: string,
    state: string
): Promise<void> {
    const stateData = readStateCookie(request);
    if (!stateData) {
        throw new OAuthLinkError("INVALID_STATE", "This link request expired or is invalid.");
    }

    const stateBuffer = Buffer.from(state);
    const expectedStateBuffer = Buffer.from(stateData.nonce);
    if (
        stateBuffer.length !== expectedStateBuffer.length ||
        !timingSafeEqual(stateBuffer, expectedStateBuffer)
    ) {
        throw new OAuthLinkError("INVALID_STATE", "This link request expired or is invalid.");
    }
    // Confused-deputy check: the callback must be completed by the same
    // session that started it, not just any browser holding the redirect URL.
    if (stateData.provider !== provider || stateData.userId !== currentUserId) {
        throw new OAuthLinkError("SESSION_MISMATCH", "Please retry linking from your account settings.");
    }

    const config = providerConfig(provider);
    const tokenResponse = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUriFor(request),
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: stateData.codeVerifier,
        }),
    });
    if (!tokenResponse.ok) {
        throw new OAuthLinkError("TOKEN_EXCHANGE_FAILED", "Could not complete linking.");
    }
    const tokenJson = (await tokenResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
    };
    if (!tokenJson.access_token) {
        throw new OAuthLinkError("TOKEN_EXCHANGE_FAILED", "Could not complete linking.");
    }

    const userinfoResponse = await fetch(config.userinfoUrl, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!userinfoResponse.ok) {
        throw new OAuthLinkError("USERINFO_FAILED", "Could not complete linking.");
    }
    const userinfo = (await userinfoResponse.json()) as { sub?: string };
    const providerAccountId = userinfo.sub;
    if (!providerAccountId) {
        throw new OAuthLinkError("USERINFO_FAILED", "Could not complete linking.");
    }

    const existingAccount = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        select: { userId: true },
    });
    if (existingAccount) {
        if (existingAccount.userId !== currentUserId) {
            throw new OAuthLinkError(
                "ALREADY_LINKED_ELSEWHERE",
                "This account is already linked to a different Tomverse account."
            );
        }
        return; // already linked to this same user -- nothing to do
    }

    const encrypted = encryptOAuthAccountTokens({
        userId: currentUserId,
        type: "oauth",
        provider,
        providerAccountId,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        id_token: tokenJson.id_token,
        token_type: tokenJson.token_type,
        scope: tokenJson.scope,
        expires_at: tokenJson.expires_in
            ? Math.floor(Date.now() / 1000) + tokenJson.expires_in
            : undefined,
    });

    await prisma.account.create({ data: encrypted });
    logSecurityAuditEvent("auth.link_account", { userId: currentUserId, provider });
}
