import { createHash, randomBytes } from "node:crypto";

/**
 * External inference API keys: format, digest and input rules.
 *
 * Pure so the parts that decide whether a string is a key -- and what may be
 * stored about it -- are testable without a database. See
 * docs/policy/external-api.md.
 *
 * A key looks like `tvk_<8 lowercase alphanumerics>_<43 base64url chars>`.
 * The first two segments are the public prefix: shown in lists, receipts and
 * logs, and stored in clear. The whole key is the secret. Only its SHA-256
 * digest is stored -- 256 bits of randomness make a keyed hash unnecessary,
 * and a plain digest means verification needs no server secret that could be
 * rotated out from under every issued key.
 */

export const EXTERNAL_API_KEY_PREFIX_PATTERN = /^tvk_[0-9a-z]{8}$/;
const KEY_PATTERN = /^(tvk_[0-9a-z]{8})_([A-Za-z0-9_-]{43})$/;
const PREFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export const EXTERNAL_API_KEY_LIMITS = {
    maxNameLength: 80,
    maxKeysPerUser: 10,
    maxCreditCap: 1_000_000,
    expiryDays: [7, 30, 90, 365] as const,
} as const;

export type ExternalApiKeyExpiryDays =
    (typeof EXTERNAL_API_KEY_LIMITS.expiryDays)[number];

export const digestExternalApiKey = (key: string) =>
    createHash("sha256").update(key, "utf8").digest("hex");

export const generateExternalApiKey = (
    random: (size: number) => Buffer = randomBytes
) => {
    const prefixBytes = random(8);
    let prefixBody = "";
    for (const byte of prefixBytes) {
        prefixBody += PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length];
    }
    const keyPrefix = `tvk_${prefixBody}`;
    const secret = random(32).toString("base64url");
    const key = `${keyPrefix}_${secret}`;
    return { key, keyPrefix, secretDigest: digestExternalApiKey(key) };
};

export type BearerParse =
    | { kind: "missing" }
    | { kind: "malformed" }
    | { kind: "key"; key: string; keyPrefix: string };

/**
 * Reads an `Authorization` header. Anything present that is not exactly one
 * well-formed key is `malformed` -- never a reason to look for a cookie.
 */
export const parseExternalApiBearer = (header: string | null): BearerParse => {
    if (header === null || header.trim() === "") return { kind: "missing" };
    const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
    if (!match?.[1]) return { kind: "malformed" };
    const key = KEY_PATTERN.exec(match[1]);
    if (!key) return { kind: "malformed" };
    return { kind: "key", key: match[1], keyPrefix: key[1] };
};

export const normalizeExternalApiKeyName = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const name = value.replace(/\s+/g, " ").trim();
    if (!name || name.length > EXTERNAL_API_KEY_LIMITS.maxNameLength) return null;
    // Control characters would make a name that prints differently from what
    // it stores; a key name is a label, not a place for markup.
    if (/[\u0000-\u001f\u007f]/.test(name)) return null;
    return name;
};

/** `null` clears the cap; `undefined` means "not a valid value". */
export const normalizeExternalApiCreditCap = (
    value: unknown
): number | null | undefined => {
    if (value === null) return null;
    if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= EXTERNAL_API_KEY_LIMITS.maxCreditCap
    ) {
        return value;
    }
    return undefined;
};

export const externalApiKeyExpiry = (
    days: unknown,
    now: Date
): Date | null | undefined => {
    if (days === null || days === undefined) return null;
    if (
        typeof days === "number" &&
        (EXTERNAL_API_KEY_LIMITS.expiryDays as readonly number[]).includes(days)
    ) {
        return new Date(now.getTime() + days * 86_400_000);
    }
    return undefined;
};

export type ExternalApiKeyState = "active" | "expired" | "revoked";

export const externalApiKeyState = (
    key: { revokedAt: Date | null; expiresAt: Date | null },
    now: Date
): ExternalApiKeyState => {
    if (key.revokedAt) return "revoked";
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return "expired";
    return "active";
};

/**
 * Credits a key has committed against its cap, from the shared reservations.
 *
 * A reservation still `reserved` -- in flight, or dispatched with an outcome
 * nobody has recorded yet -- counts at its full held amount. A settled or
 * refunded one counts at what it settled for. There is no third number: the
 * reservation is the ledger, and this only reads it.
 */
export const externalApiKeyCommittedCredits = (
    reservations: readonly {
        status: string;
        reservedCredits: number;
        settledCredits: number;
    }[]
) =>
    reservations.reduce(
        (total, row) =>
            total + (row.status === "reserved" ? row.reservedCredits : row.settledCredits),
        0
    );

/** Lowercase hex SHA-256 of an arbitrary string, for digests of client values. */
export const sha256Hex = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
