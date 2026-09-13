import { z } from "zod";

export const CHAT_DRAFT_NEW_SCOPE = "new" as const;
export const CHAT_DRAFT_REVISION_CONFLICT = "CHAT_DRAFT_REVISION_CONFLICT" as const;
export const CHAT_DRAFT_INVALID = "CHAT_DRAFT_INVALID" as const;

const opaqueId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const chatDraftScopeKeySchema = opaqueId.refine(
  (value) => value === CHAT_DRAFT_NEW_SCOPE || !value.startsWith("guest_"),
  "A durable draft must use the new scope or an account conversation id."
);

const uploadReferenceSchema = z.object({ uploadId: opaqueId }).strict();
const attachmentReferenceSchema = z.object({ attachmentId: opaqueId }).strict();

export const chatDraftAttachmentReferenceSchema = z.union([
  uploadReferenceSchema,
  attachmentReferenceSchema,
]);

export type ChatDraftAttachmentReference = z.infer<
  typeof chatDraftAttachmentReferenceSchema
>;

export const chatDraftAttachmentReferencesSchema = z
  .array(chatDraftAttachmentReferenceSchema)
  .max(5)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    for (const [index, reference] of references.entries()) {
      const identity =
        "uploadId" in reference
          ? `upload:${reference.uploadId}`
          : `attachment:${reference.attachmentId}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Attachment references must be unique and ordered.",
          path: [index],
        });
      }
      seen.add(identity);
    }
  });

export const chatComposerDraftPutSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    text: z.string().max(50_000),
    attachmentReferences: chatDraftAttachmentReferencesSchema,
  })
  .strict();

export const chatComposerDraftDeleteSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();

export type ChatComposerDraftPut = z.infer<typeof chatComposerDraftPutSchema>;

export type ChatComposerDraftRecord = {
  scopeKey: string;
  conversationId: string | null;
  text: string;
  attachmentReferences: ChatDraftAttachmentReference[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DraftCasDecision =
  | { action: "create"; nextRevision: 1 }
  | { action: "update"; nextRevision: number }
  | { action: "conflict"; currentRevision: number | null };

export function decideDraftCas(
  currentRevision: number | null,
  expectedRevision: number
): DraftCasDecision {
  if (currentRevision === null) {
    return expectedRevision === 0
      ? { action: "create", nextRevision: 1 }
      : { action: "conflict", currentRevision: null };
  }
  if (expectedRevision !== currentRevision || currentRevision >= 2_147_483_647) {
    return { action: "conflict", currentRevision };
  }
  return { action: "update", nextRevision: currentRevision + 1 };
}
export function draftConversationId(scopeKey: string): string | null {
  return scopeKey === CHAT_DRAFT_NEW_SCOPE ? null : scopeKey;
}

export function validateDraftReferencesForScope(
  scopeKey: string,
  references: readonly ChatDraftAttachmentReference[]
): boolean {
  return (
    scopeKey !== CHAT_DRAFT_NEW_SCOPE ||
    references.every((reference) => "uploadId" in reference)
  );
}

export function parseStoredDraftReferences(
  value: unknown
): ChatDraftAttachmentReference[] {
  const parsed = chatDraftAttachmentReferencesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Stored Chat composer draft references are unreadable.");
  }
  return parsed.data;
}

export function publicChatComposerDraft(record: ChatComposerDraftRecord) {
  return {
    scopeKey: record.scopeKey,
    text: record.text,
    attachmentReferences: record.attachmentReferences,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
