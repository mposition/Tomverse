import { createHash } from "node:crypto";

export type MemoryHistorySource = { id: string; digest: string };
export type MemoryHistoryAnchor = {
    version: 1;
    queryDigest: string;
    sources: MemoryHistorySource[];
};

export const memoryCurrentQueryDigest = (query: string) =>
    createHash("sha256").update(query.normalize("NFC"), "utf8").digest("hex");

// Digest the stored body, including whitespace. Editing a source invalidates it.
export const memoryHistoryContentDigest = (content: string) =>
    createHash("sha256").update(JSON.stringify(["user", content]), "utf8").digest("hex");

export function isMemoryHistoryAnchor(value: unknown): value is MemoryHistoryAnchor {
    if (!value || typeof value !== "object") return false;
    const anchor = value as Partial<MemoryHistoryAnchor>;
    return anchor.version === 1 && typeof anchor.queryDigest === "string" &&
        /^[a-f0-9]{64}$/.test(anchor.queryDigest) && Array.isArray(anchor.sources) &&
        anchor.sources.length > 0 && anchor.sources.length <= 2 &&
        anchor.sources.every(source => source && typeof source.id === "string" &&
            source.id.length > 0 && source.id.length <= 160 &&
            typeof source.digest === "string" && /^[a-f0-9]{64}$/.test(source.digest)) &&
        new Set(anchor.sources.map(source => source.id)).size === anchor.sources.length;
}
