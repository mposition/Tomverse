import "server-only";

import { randomBytes } from "node:crypto";

const SHARE_TOKEN_BYTES = 24;
const MIN_STRONG_TOKEN_BYTES = 16;
const MAX_TOKEN_LENGTH = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const createShareToken = () =>
    randomBytes(SHARE_TOKEN_BYTES).toString("base64url");

export const isStrongShareToken = (token: string | null | undefined) => {
    if (
        !token ||
        token.length > MAX_TOKEN_LENGTH ||
        !BASE64URL_PATTERN.test(token)
    ) {
        return false;
    }
    try {
        return Buffer.from(token, "base64url").byteLength >= MIN_STRONG_TOKEN_BYTES;
    } catch {
        return false;
    }
};
