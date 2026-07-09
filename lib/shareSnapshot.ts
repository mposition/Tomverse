import { z } from "zod";

export const SHARE_SNAPSHOT_VERSION = 1;
export const MAX_SHARE_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export const shareSnapshotSchema = z.object({
    version: z.literal(SHARE_SNAPSHOT_VERSION),
    title: z.string().min(1).max(500),
    conversationCreatedAt: z.string().datetime(),
    sharedAt: z.string().datetime(),
    messages: z
        .array(
            z.object({
                id: z.string().min(1).max(100),
                role: z.enum(["user", "assistant"]),
                content: z.string().max(100_000),
                modelId: z.string().max(100).nullable(),
                createdAt: z.string().datetime(),
            })
        )
        .max(10_000),
});

export type ShareSnapshot = z.infer<typeof shareSnapshotSchema>;
