import "server-only";

import { createHmac } from "node:crypto";
import { getTrustedClientIp } from "@/lib/clientIp";

type AuthAuditEvent =
    | "auth.create_user"
    | "auth.sign_in"
    | "auth.sign_in_denied_suspended"
    | "auth.sign_in_denied_pending_deletion"
    | "auth.sign_out"
    | "auth.link_account"
    // A presented token was rejected during session resolution because the
    // account was revoked (sessionsRevokedAt) or is no longer active.
    | "auth.session_rejected";
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
    // Release B5 §7: the same lock, applied to an imported snapshot. Separate
    // event names rather than a `resourceType` field, so an existing alert on
    // `conversation.lock.*` keeps meaning what it meant.
    | "external_conversation.lock.set"
    | "external_conversation.lock.change"
    | "external_conversation.lock.remove"
    | "external_conversation.lock.verify"
    | "account.deletion.schedule"
    // Release B §13.1-§13.2. Content-free by construction: these carry the
    // hashed subject and an outcome, never a statement, evidence or count of
    // anything a memory says. Retention follows the existing audit-log
    // convention (90 days).
    | "memory.export.create"
    | "memory.export.download"
    | "memory.delete_all"
    // The unified account export (PRIVACY-02). Three events rather than two,
    // because the refusal is the one that matters most: it means somebody
    // presented a download link they should not have, and a trail recording
    // only successes cannot show that.
    | "account.data_export.request"
    | "account.data_export.download"
    | "account.data_export.refused";
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
        /** Short machine-readable cause, e.g. why a session was rejected. */
        reason?: string | null;
    } = {}
) => logSecurityAuditEvent(event, details);
