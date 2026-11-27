import "server-only";

import type { Prisma } from "@prisma/client";

import { deleteDeepResearchJobsForConversations } from "@/lib/deepResearchJobs";
import { enqueueArtifactCleanupForConversations } from "@/lib/generatedArtifactStorage";
import { enqueueImageAssetCleanupForConversations } from "@/lib/imageAssetLifecycle";
import { enqueueMessageAttachmentCleanupForConversations } from "@/lib/messageAttachmentStorage";
import { applyNativeSourceDeletion } from "@/lib/projectWorkspaceService";
import { conversationDeletionScope } from "@/lib/temporaryChatAccess";

/**
 * The one way conversations are deleted: by the owner (one, or all of them)
 * and by the temporary Chat sweep.
 *
 * DB-first tombstones, in the order the single delete always used:
 * generated-image, generated-file and uploaded-attachment object keys are
 * queued for the fifteen-minute maintenance drain in the same transaction
 * that deletes the rows (docs/policy/user-attachment-persistence.md,
 * docs/policy/generated-artifacts.md section 8), Deep Research jobs are
 * removed, project memories grounded only in these conversations are deleted
 * or suspended, and then the rows go -- everything else follows by cascade.
 * Deleting objects first and rows second would leave the database pointing
 * at missing objects whenever the second step failed.
 *
 * Takes the caller's transaction and opens none of its own. The ids are read
 * again through the deletion scope first, so every cleanup step and the
 * delete itself see the same set, and an id outside the scope -- another
 * account's, or for the sweep anything that is not an expired temporary
 * conversation -- is dropped before any of its files are queued.
 */
export async function deleteOwnedConversations(
    tx: Prisma.TransactionClient,
    input: {
        userId: string;
        conversationIds: readonly string[];
        /** Set only by the temporary Chat sweep. */
        temporaryExpiredBefore?: Date;
    }
): Promise<{ count: number; conversationIds: string[] }> {
    if (input.conversationIds.length === 0) return { count: 0, conversationIds: [] };
    const scope = conversationDeletionScope(input);
    const ids = (await tx.conversation.findMany({ where: scope, select: { id: true } })).map((row) => row.id);
    if (ids.length === 0) return { count: 0, conversationIds: [] };
    await enqueueImageAssetCleanupForConversations(tx, ids);
    await enqueueArtifactCleanupForConversations(tx, ids);
    await enqueueMessageAttachmentCleanupForConversations(tx, ids);
    await deleteDeepResearchJobsForConversations(tx, ids);
    await applyNativeSourceDeletion(tx, input.userId, ids);
    const result = await tx.conversation.deleteMany({ where: { ...scope, id: { in: ids } } });
    return { count: result.count, conversationIds: ids };
}
