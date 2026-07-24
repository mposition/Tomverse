import "server-only";

import { createHmac } from "node:crypto";
import { getTrustedClientIp } from "@/lib/clientIp";

type AuthAuditEvent =
    | "auth.create_user"
    | "auth.sign_in"
    | "auth.sign_in_denied_suspended"
    | "auth.sign_in_denied_pending_deletion"
    | "auth.sign_out"
    | "auth.link_account";
export type SecurityAuditEvent =
    | AuthAuditEvent
    | "auth.email_code.request"
    | "auth.email_code.verify"
    | "auth.login_method.link"
    | "auth.login_method.remove"
    | "conversation.share.create"
    | "conversation.share.revoke"
    | "conversation.lock.set"
    | "conversation.lock.change"
    | "conversation.lock.remove"
    | "conversation.lock.verify"
    | "conversation.delete"
    | "account.deletion.schedule";
type AuditOutcome = "attempt" | "success" | "denied" | "rate_limited" | "failure";

const auditValue = (
    namespace: "subject" | "resource" | "ip",
    value: string | null | undefined
) => {
    if (!value) return undefined;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) return undefined;
    return createHmac("sha256", secret)
        .update(`audit:${namespace}:${value}`)
        .digest("base64url")
        .slice(0, 24);
};

const sanitizeProvider = (provider: string | null | undefined) =>
    provider && /^[a-z0-9._-]{1,40}$/i.test(provider)
        ? provider
        : undefined;

const sanitizeReason = (reason: string | null | undefined) =>
    reason && /^[A-Z0-9_.-]{1,64}$/i.test(reason) ? reason : undefined;

export const logSecurityAuditEvent = (
    event: SecurityAuditEvent,
    details: {
        userId?: string | null;
        resourceId?: string | null;
        request?: Request;
        provider?: string | null;
        isNewUser?: boolean;
        outcome?: AuditOutcome;
        reason?: string | null;
    } = {}
) => {
    console.info(
        JSON.stringify({
            event,
            occurredAt: new Date().toISOString(),
            outcome: details.outcome || "success",
            subject: auditValue("subject", details.userId),
            resource: auditValue("resource", details.resourceId),
            sourceIp: details.request
                ? auditValue("ip", getTrustedClientIp(details.request))
                : undefined,
            provider: sanitizeProvider(details.provider),
            reason: sanitizeReason(details.reason),
            isNewUser:
                typeof details.isNewUser === "boolean"
                    ? details.isNewUser
                    : undefined,
        })
    );
};

export const logAuthAuditEvent = (
    event: AuthAuditEvent,
    details: {
        userId?: string | null;
        provider?: string | null;
        isNewUser?: boolean;
    } = {}
) => logSecurityAuditEvent(event, details);
