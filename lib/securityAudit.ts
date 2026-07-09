import "server-only";

import { createHmac } from "node:crypto";

type AuthAuditEvent = "auth.sign_in" | "auth.sign_out" | "auth.link_account";

const auditSubject = (userId: string | null | undefined) => {
    if (!userId) return undefined;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) return undefined;
    return createHmac("sha256", secret)
        .update(`audit:${userId}`)
        .digest("base64url")
        .slice(0, 24);
};

const sanitizeProvider = (provider: string | null | undefined) =>
    provider && /^[a-z0-9._-]{1,40}$/i.test(provider)
        ? provider
        : undefined;

export const logAuthAuditEvent = (
    event: AuthAuditEvent,
    details: {
        userId?: string | null;
        provider?: string | null;
        isNewUser?: boolean;
    } = {}
) => {
    console.info(
        JSON.stringify({
            event,
            occurredAt: new Date().toISOString(),
            subject: auditSubject(details.userId),
            provider: sanitizeProvider(details.provider),
            isNewUser:
                typeof details.isNewUser === "boolean"
                    ? details.isNewUser
                    : undefined,
        })
    );
};
