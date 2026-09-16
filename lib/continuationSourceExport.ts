import "server-only";

import { createHash } from "node:crypto";

import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { hasConversationUnlockGrant, hasResourceUnlockGrant } from "@/lib/conversationLock";
import { formatExportMessage } from "@/lib/exportConversation";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";

/**
 * The TXT a continued conversation's owner downloads with its imported
 * original included (CONT-EXPORT-01B).
 *
 * Policy: docs/policy/external-conversation-continuation.md §9.
 *
 * ## Why it is built before it is sent, and not streamed
 *
 * The ordinary export streams page after page, each its own read. That is fine
 * for a conversation nobody else is writing to, but this file has to be one
 * document made of two halves that agree with each other: the snapshot the
 * bridge names, the messages inside it, the conversation's own turns, and the
 * name at the top. Read across several transactions, a rename, a new answer or
 * a source deletion landing mid-file would produce a file that never existed
 * at any moment. So everything is read inside one READ ONLY REPEATABLE READ
 * transaction, the bytes are assembled from what was read, and only then is
 * anything sent -- with the byte count and digest in headers, so the browser
 * saves the file only if it received all of it.
 *
 * ## What "the whole original" means
 *
 * Exactly the text Tomverse stored for that snapshot. Content dropped at
 * import (truncated messages, attachments that were never stored) is not
 * recoverable here and is stated rather than quietly missing.
 */

/** Caps on the finished file, not on any one query. Provisional, and stated in the policy. */
export const CONTINUATION_SOURCE_EXPORT_LIMITS = {
    /** UTF-8 bytes of the finished document. */
    maxBytes: 10 * 1024 * 1024,
    /** Imported and Tomverse messages together. */
    maxMessages: 10_000,
    /** Rows per query page inside the snapshot transaction. */
    pageSize: 500,
} as const;

export type ContinuationSourceExportRefusal =
    | { code: "EXPORT_SOURCE_NOT_CONTINUATION"; status: 400 }
    | { code: "EXPORT_SOURCE_DELETED"; status: 409 }
    | { code: "EXPORT_SOURCE_LOCKED"; status: 423 }
    | { code: "EXPORT_TOO_LARGE"; status: 413 }
    | { code: "EXPORT_INCONSISTENT"; status: 500 };

export type ContinuationSourceExportDocument = {
    bytes: Uint8Array;
    sha256: string;
    importedMessageCount: number;
    nativeMessageCount: number;
};

type SourceMessage = {
    role: string;
    content: string;
    ordinal: number;
    sourceModelLabel: string | null;
    sourceTimestamp: Date | null;
    truncated: boolean;
};

const BOUNDARY = "===== Continued in Tomverse =====";

/**
 * One imported turn, marked as somebody else's and dated by their clock.
 *
 * Never `formatExportMessage`: that resolves a model id against this app's
 * catalogue, and an imported answer's model is a name this app may not serve.
 * The label is the provider and whatever the export called the model, or the
 * role when it said nothing.
 */
export function formatImportedExportMessage(
    message: Pick<SourceMessage, "role" | "content" | "sourceModelLabel" | "sourceTimestamp" | "truncated">,
    providerLabel: string
): string {
    const who =
        message.role === "user"
            ? "User"
            : (message.sourceModelLabel ?? "Assistant");
    return [
        "==================================================",
        `[Imported · ${providerLabel} · ${who}]${
            message.sourceTimestamp ? ` ${message.sourceTimestamp.toISOString()}` : " time unknown"
        }`,
        "--------------------------------------------------",
        message.content,
        ...(message.truncated ? ["(This message was shortened when it was imported.)"] : []),
        "",
    ].join("\n");
}

/** The closing line, which says what the file holds so a truncated copy is visible. */
export function continuationSourceExportFooter(counts: {
    importedMessageCount: number;
    nativeMessageCount: number;
}): string {
    return `===== End of export (${counts.importedMessageCount} imported, ${counts.nativeMessageCount} Tomverse messages) =====\n`;
}

/**
 * Reads the whole document in one snapshot and returns its bytes.
 *
 * `header` is built by the caller from the same conversation row this reads,
 * so the file's name and its `Conversation:` line come from the snapshot too:
 * the caller passes a function rather than a string because the title depends
 * on rows only this transaction has read.
 */
export async function buildContinuationSourceExport(input: {
    request: Request;
    userId: string;
    conversationId: string;
    header: (context: {
        conversation: { title: string; createdAt: Date; kind: string; password: string | null };
        bridge: {
            provider: string;
            sourceImportedAt: Date;
            createdAt: Date;
            externalConversationId: string | null;
            externalConversation: { title: string | null; password: string | null } | null;
        };
    }) => { title: string; text: string };
    providerLabel: (provider: string) => string;
    /**
     * Awaited inside the transaction, after its snapshot is fixed and before
     * any content is read.
     *
     * A seam for the test that has to prove the file is one snapshot: without
     * it, a concurrent write can land before the snapshot is taken and the
     * test passes for the wrong reason. Nothing in the product passes it.
     */
    afterSnapshot?: () => Promise<void>;
}): Promise<
    | {
          ok: true;
          document: ContinuationSourceExportDocument;
          title: string;
          /** What the state was read as, for the check after the snapshot closes. */
          permission: {
              bridgeId: string;
              externalConversationId: string;
              conversationPassword: string | null;
              snapshotPassword: string | null;
          };
      }
    | { ok: false; refusal: ContinuationSourceExportRefusal }
    | { ok: false; notFound: true }
    | { ok: false; locked: true }
    | { ok: false; kindNotSupported: true }
> {
    const limits = CONTINUATION_SOURCE_EXPORT_LIMITS;
    const read = await readOnlySnapshotTransaction(
        async (tx) => {
            const conversation = await tx.conversation.findFirst({
                where: { id: input.conversationId, userId: input.userId },
                select: {
                    id: true,
                    title: true,
                    createdAt: true,
                    password: true,
                    kind: true,
                    continuationBridge: {
                        select: {
                            id: true,
                            provider: true,
                            createdAt: true,
                            sourceImportedAt: true,
                            externalConversationId: true,
                            externalConversation: {
                                select: { id: true, title: true, password: true, userId: true, finalized: true, messageCount: true },
                            },
                        },
                    },
                },
            });
            // The snapshot is fixed by that first read.
            if (input.afterSnapshot) await input.afterSnapshot();
            if (!conversation) return { kind: "not_found" as const };
            if (
                !hasConversationUnlockGrant(
                    input.request,
                    input.userId,
                    conversation.id,
                    conversation.password
                )
            ) {
                return { kind: "locked" as const };
            }
            if (!isChatConversationKind(conversation.kind)) return { kind: "kind" as const };
            const bridge = conversation.continuationBridge;
            if (!bridge) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_SOURCE_NOT_CONTINUATION") };
            }
            const snapshot = bridge.externalConversation;
            // Deleted, or a foreign key this account cannot read, or not
            // finalized: one answer, decided after ownership.
            if (
                !bridge.externalConversationId ||
                !snapshot ||
                snapshot.userId !== input.userId ||
                !snapshot.finalized
            ) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_SOURCE_DELETED") };
            }
            if (
                !hasResourceUnlockGrant(
                    "external_conversation",
                    input.request,
                    input.userId,
                    snapshot.id,
                    snapshot.password
                )
            ) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_SOURCE_LOCKED") };
            }

            // Cheap refusal before any content is read, from the same snapshot.
            const [importedCount, nativeCount] = await Promise.all([
                tx.externalMessage.count({
                    where: { userId: input.userId, externalConversationId: snapshot.id },
                }),
                tx.message.count({ where: { conversationId: conversation.id } }),
            ]);
            if (importedCount + nativeCount > limits.maxMessages) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_TOO_LARGE") };
            }
            /*
              And the bytes, from the same snapshot, before a single message is
              read into memory. Ten thousand messages can still be far past the
              size cap, and finding that out after assembling them is an OOM or
              a transaction timeout reported as a generic failure. The exact
              check on the finished document stays below: this one cannot see
              the header, the labels or the divider.
            */
            const [{ bytes: importedBytes }] = await tx.$queryRaw<Array<{ bytes: bigint }>>`
                SELECT COALESCE(SUM(octet_length(content)), 0)::bigint AS bytes
                FROM "ExternalMessage"
                WHERE "userId" = ${input.userId} AND "externalConversationId" = ${snapshot.id}
            `;
            const [{ bytes: nativeBytes }] = await tx.$queryRaw<Array<{ bytes: bigint }>>`
                SELECT COALESCE(SUM(octet_length(content)), 0)::bigint AS bytes
                FROM "Message"
                WHERE "conversationId" = ${conversation.id}
            `;
            if (Number(importedBytes) + Number(nativeBytes) > limits.maxBytes) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_TOO_LARGE") };
            }

            const imported: SourceMessage[] = [];
            let ordinalCursor: number | null = null;
            for (;;) {
                const page: SourceMessage[] = await tx.externalMessage.findMany({
                    where: {
                        userId: input.userId,
                        externalConversationId: snapshot.id,
                        ...(ordinalCursor === null ? {} : { ordinal: { gt: ordinalCursor } }),
                    },
                    orderBy: { ordinal: "asc" },
                    take: limits.pageSize,
                    select: {
                        role: true,
                        content: true,
                        ordinal: true,
                        sourceModelLabel: true,
                        sourceTimestamp: true,
                        truncated: true,
                    },
                });
                if (page.length === 0) break;
                for (const message of page) {
                    // Ordinals are unique per snapshot and read ascending, so a
                    // repeat or a step backwards means the page walk is wrong.
                    if (ordinalCursor !== null && message.ordinal <= ordinalCursor) {
                        return { kind: "refusal" as const, refusal: refusal("EXPORT_INCONSISTENT") };
                    }
                    ordinalCursor = message.ordinal;
                    imported.push(message);
                }
                if (page.length < limits.pageSize) break;
            }

            const native: Array<{
                id: string;
                role: string;
                content: string;
                modelId: string | null;
                createdAt: Date;
            }> = [];
            let cursor: string | undefined;
            for (;;) {
                const page = await tx.message.findMany({
                    where: { conversationId: conversation.id },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: limits.pageSize,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                    select: { id: true, role: true, content: true, modelId: true, createdAt: true },
                });
                if (page.length === 0) break;
                native.push(...page);
                cursor = page.at(-1)?.id;
                if (page.length < limits.pageSize) break;
            }

            // What the counts promised is what was read; anything else and the
            // file would be a partial document that looks complete.
            if (imported.length !== importedCount || native.length !== nativeCount) {
                return { kind: "refusal" as const, refusal: refusal("EXPORT_INCONSISTENT") };
            }

            return {
                kind: "ok" as const,
                conversation,
                bridge: { ...bridge, externalConversation: snapshot },
                imported,
                native,
            };
        },
        { timeout: 20_000, maxWait: 5_000 }
    );

    if (read.kind === "not_found") return { ok: false, notFound: true };
    if (read.kind === "locked") return { ok: false, locked: true };
    if (read.kind === "kind") return { ok: false, kindNotSupported: true };
    if (read.kind === "refusal") return { ok: false, refusal: read.refusal };

    const { title, text: headerText } = input.header({
        conversation: read.conversation,
        bridge: read.bridge,
    });
    const providerLabel = input.providerLabel(read.bridge.provider);
    const body = [
        headerText,
        ...read.imported.map((message) => formatImportedExportMessage(message, providerLabel)),
        `${BOUNDARY}\n`,
        ...read.native.map((message) => formatExportMessage(message)),
        continuationSourceExportFooter({
            importedMessageCount: read.imported.length,
            nativeMessageCount: read.native.length,
        }),
    ].join("\n");
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > limits.maxBytes) {
        return { ok: false, refusal: refusal("EXPORT_TOO_LARGE") };
    }

    return {
        ok: true,
        title,
        permission: {
            bridgeId: read.bridge.id,
            externalConversationId: read.bridge.externalConversation.id,
            conversationPassword: read.conversation.password,
            snapshotPassword: read.bridge.externalConversation.password,
        },
        document: {
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            importedMessageCount: read.imported.length,
            nativeMessageCount: read.native.length,
        },
    };
}

/**
 * The state the file was built from, checked again outside the snapshot.
 *
 * The snapshot is a moment in the past by the time the bytes exist. Permission
 * is decided by this check: a source deleted or re-locked since is refused
 * here, and a file already sent cannot be recalled.
 */
export async function continuationSourceExportStillPermitted(
    input: {
        request: Request;
        userId: string;
        conversationId: string;
        bridgeId: string;
        externalConversationId: string;
        conversationPassword: string | null;
        snapshotPassword: string | null;
    }
): Promise<ContinuationSourceExportRefusal | null> {
    // Its own short READ ONLY REPEATABLE READ snapshot: Prisma reads a nested
    // relation as several statements, so outside one the conversation's lock,
    // the bridge and the snapshot's lock can each be read from a different
    // moment -- and a combination that never held at once would let a file
    // through after its source was re-locked.
    return readOnlySnapshotTransaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: {
            password: true,
            continuationBridge: {
                select: {
                    id: true,
                    externalConversationId: true,
                    externalConversation: {
                        select: { id: true, password: true, finalized: true, userId: true },
                    },
                },
            },
        },
    });
    const bridge = conversation?.continuationBridge;
    const snapshot = bridge?.externalConversation;
    if (!conversation || !bridge || bridge.id !== input.bridgeId) {
        return refusal("EXPORT_SOURCE_DELETED");
    }
    if (
        bridge.externalConversationId !== input.externalConversationId ||
        !snapshot ||
        snapshot.userId !== input.userId ||
        !snapshot.finalized
    ) {
        return refusal("EXPORT_SOURCE_DELETED");
    }
    // A password changed since the read is a different lock, and the grant the
    // request holds was for the old one.
    if (
        conversation.password !== input.conversationPassword ||
        snapshot.password !== input.snapshotPassword
    ) {
        return refusal("EXPORT_SOURCE_LOCKED");
    }
    if (!hasConversationUnlockGrant(input.request, input.userId, input.conversationId, conversation.password)) {
        return refusal("EXPORT_SOURCE_LOCKED");
    }
    if (
        !hasResourceUnlockGrant(
            "external_conversation",
            input.request,
            input.userId,
            snapshot.id,
            snapshot.password
        )
    ) {
        return refusal("EXPORT_SOURCE_LOCKED");
    }
    return null;
    }, { timeout: 5_000, maxWait: 5_000 });
}

const STATUS: Record<ContinuationSourceExportRefusal["code"], ContinuationSourceExportRefusal["status"]> = {
    EXPORT_SOURCE_NOT_CONTINUATION: 400,
    EXPORT_SOURCE_DELETED: 409,
    EXPORT_SOURCE_LOCKED: 423,
    EXPORT_TOO_LARGE: 413,
    EXPORT_INCONSISTENT: 500,
};

function refusal(code: ContinuationSourceExportRefusal["code"]): ContinuationSourceExportRefusal {
    return { code, status: STATUS[code] } as ContinuationSourceExportRefusal;
}


