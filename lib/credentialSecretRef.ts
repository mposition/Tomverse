/**
 * Resolving a credential secret from a reference.
 *
 * The row holds a reference, a billing owner and a status. The secret is
 * looked up by that reference from a caller-supplied vault. This function
 * does not open a database, does not read an environment variable, and does
 * not accept a secret field on the facts: a plaintext key beside the
 * reference would store the secret itself, which this module does not do.
 *
 * A missing expiry is not treated as expired. Choosing a lifetime would be
 * inventing one. A missing rotation instant does not refuse the lookup.
 *
 * Pure. The request path does not import this.
 */

import { CREDENTIAL_BILLING_OWNERS } from "@/lib/deploymentIdentity";

/** The status check on the credential row. `disabled` is the default. */
export const CREDENTIAL_SECRET_STATUSES = ["disabled", "active", "revoked"] as const;

export type CredentialSecretStatus = (typeof CREDENTIAL_SECRET_STATUSES)[number];

export type CredentialSecretFacts = {
    secretRef: string;
    billingOwner: string;
    status: string;
    expiresAt?: Date | null;
    lastRotatedAt?: Date | null;
};

export const CREDENTIAL_SECRET_REFUSALS = [
    "secret_ref_blank",
    "billing_owner_unknown",
    "status_not_active",
    "expired",
    "rotation_after_expiry",
    "secret_not_in_vault",
    "secret_blank",
] as const;

export type CredentialSecretRefusal = (typeof CREDENTIAL_SECRET_REFUSALS)[number];

const isOwner = (value: string) =>
    (CREDENTIAL_BILLING_OWNERS as readonly string[]).includes(value);

const isStatus = (value: string): value is CredentialSecretStatus =>
    (CREDENTIAL_SECRET_STATUSES as readonly string[]).includes(value);

/**
 * Why these facts cannot be resolved, before any vault is asked.
 *
 * `rotation_after_expiry` is the one ordering the two instants can violate.
 * Either instant being absent skips that comparison.
 */
export const credentialSecretRefusal = (
    facts: CredentialSecretFacts,
    at: Date
): CredentialSecretRefusal | null => {
    if (!Number.isFinite(at.getTime())) return null;
    if (facts.secretRef.trim().length === 0) return "secret_ref_blank";
    if (!isOwner(facts.billingOwner)) return "billing_owner_unknown";
    if (!isStatus(facts.status) || facts.status !== "active") return "status_not_active";
    if (
        facts.lastRotatedAt instanceof Date &&
        facts.expiresAt instanceof Date &&
        Number.isFinite(facts.lastRotatedAt.getTime()) &&
        Number.isFinite(facts.expiresAt.getTime()) &&
        facts.lastRotatedAt.getTime() > facts.expiresAt.getTime()
    ) {
        return "rotation_after_expiry";
    }
    if (
        facts.expiresAt instanceof Date &&
        Number.isFinite(facts.expiresAt.getTime()) &&
        at.getTime() >= facts.expiresAt.getTime()
    ) {
        return "expired";
    }
    return null;
};

/**
 * The secret for these facts, or why there isn't one.
 *
 * The lookup is called only after the facts themselves are usable, so a
 * disabled row never reaches the vault.
 */
export const resolveCredentialSecret = (
    facts: CredentialSecretFacts,
    at: Date,
    lookup: (secretRef: string) => string | undefined
): { ok: true; secret: string } | { ok: false; code: CredentialSecretRefusal } | null => {
    if (!Number.isFinite(at.getTime())) return null;
    const refusal = credentialSecretRefusal(facts, at);
    if (refusal) return { ok: false, code: refusal };
    const secret = lookup(facts.secretRef);
    if (secret === undefined) return { ok: false, code: "secret_not_in_vault" };
    if (secret.trim().length === 0) return { ok: false, code: "secret_blank" };
    return { ok: true, secret };
};
