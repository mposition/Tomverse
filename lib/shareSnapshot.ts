import { z } from "zod";

export const SHARE_SNAPSHOT_VERSION = 1;
export const MAX_SHARE_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export const shareSnapshotSchema = z.object({
    version: z.literal(SHARE_SNAPSHOT_VERSION),
    /**
     * Whether an answer in this snapshot could have been influenced by the
     * author's account memory (§13.3). Recorded at share time rather than read
     * when the page is viewed: turning injection off later does not un-influence
     * answers that were already generated, and turning it on later does not
     * influence these.
     *
     * It is a global fact at that moment, never a per-author one — the notice
     * has to be unconditional for everyone, because showing it conditionally
     * would itself disclose whether this author uses memory.
     *
     * Optional so snapshots written before this field parse unchanged; absent
     * reads as false, which is correct for every snapshot taken before
     * injection existed.
     */
    personalizationPossible: z.boolean().optional(),
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
