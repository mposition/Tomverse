import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const OAUTH_TOKEN_ENCRYPTED_PREFIX = "enc:v1:";
const TOKEN_FIELDS = [
    "access_token",
    "refresh_token",
    "id_token",
    "session_state",
] as const;

const ACCOUNT_FIELDS = new Set([
    "id",
    "userId",
    "type",
    "provider",
    "providerAccountId",
    "refresh_token",
    "access_token",
    "expires_at",
    "token_type",
    "scope",
    "id_token",
    "session_state",
]);

const getEncryptionKey = () => {
    const secret = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    if (!secret || secret.length < 32) {
        throw new Error(
            "A dedicated OAUTH_TOKEN_ENCRYPTION_KEY of at least 32 characters is required."
        );
    }
    return createHash("sha256").update(secret).digest();
};

export const assertOAuthTokenEncryptionConfigured = () => {
    getEncryptionKey();
};

const encryptString = (value: string) => {
    if (value.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX)) return value;

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${OAUTH_TOKEN_ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
};

export const isEncryptedOAuthToken = (value: string | null | undefined) =>
    Boolean(value?.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX));

export const decryptOAuthToken = (value: string | null | undefined) => {
    if (!value?.startsWith(OAUTH_TOKEN_ENCRYPTED_PREFIX)) return value || null;

    const payload = Buffer.from(
        value.slice(OAUTH_TOKEN_ENCRYPTED_PREFIX.length),
        "base64url"
    );
    if (payload.length <= 28) throw new Error("Invalid encrypted OAuth token.");

    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString("utf8");
};

export const encryptOAuthAccountTokens = <T extends object>(account: T) => {
    const encrypted = Object.fromEntries(
        Object.entries(account).filter(([key]) => ACCOUNT_FIELDS.has(key))
    );
    const writable = encrypted as Record<string, unknown>;
    for (const field of TOKEN_FIELDS) {
        const value = writable[field];
        if (typeof value === "string" && value.length > 0) {
            writable[field] = encryptString(value);
        }
    }
    return encrypted as T;
};
