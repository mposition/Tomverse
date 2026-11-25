import { z } from "zod";

// File saves and irreversible account actions. They cross a second IPC channel
// (`desktop:account-data`) because the main process, not the renderer, owns the
// download, the save dialog and the sign-out that follows an account deletion.

export const DELETE_ACCOUNT_PHRASE = "DELETE MY ACCOUNT";
export const DELETE_ALL_CHATS_PHRASE = "DELETE ALL CHATS";
export const DELETE_ALL_MEMORIES_PHRASE = "DELETE ALL MEMORIES";
export const DELETE_ASSISTANT_PHRASE = "DELETE ASSISTANT";

const accountId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const desktopAccountDataInput = z.discriminatedUnion("action", [
  // Account data export: ask for a single-use link, then save the file it opens.
  z.object({ action: z.literal("requestExport") }).strict(),
  z.object({ action: z.literal("saveExport") }).strict(),
  z.object({ action: z.literal("saveAllConversations") }).strict(),
  z.object({ action: z.literal("deleteAllConversations"), confirmation: z.literal(DELETE_ALL_CHATS_PHRASE) }).strict(),
  z.object({ action: z.literal("deleteAccount"), confirmation: z.literal(DELETE_ACCOUNT_PHRASE) }).strict(),
  z.object({ action: z.literal("saveMemories") }).strict(),
  z.object({ action: z.literal("saveAssistant"), id: accountId, name: z.string().max(200) }).strict(),
  z.object({ action: z.literal("uploadKnowledge"), id: accountId }).strict(),
  z.object({ action: z.literal("deleteAllMemories"), confirmation: z.literal(DELETE_ALL_MEMORIES_PHRASE) }).strict(),
]);

export const accountDataStatus = z.enum([
  "ready", "saved", "uploaded", "cancelled", "deleted", "expired",
  "reauth", "locked", "notIncluded", "unavailable", "failed",
]);

export const desktopAccountDataResult = z.object({
  status: accountDataStatus,
  expiresAt: z.string().optional(),
  code: z.string().max(80).optional(),
  deleted: z.number().int().nonnegative().optional(),
}).strict();

export type DesktopAccountDataInput = z.infer<typeof desktopAccountDataInput>;
export type DesktopAccountDataResult = z.infer<typeof desktopAccountDataResult>;
export type AccountDataStatus = z.infer<typeof accountDataStatus>;
export { accountId as accountDataId };
