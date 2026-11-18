import { chatAttachmentExtensionsByGroup, type ChatAttachmentUiGroup } from "@/lib/chatAttachmentFormats";
import { GUEST_MAX_ATTACHMENTS_PER_MESSAGE, GUEST_MAX_ATTACHMENT_BYTES } from "@/lib/guestAttachmentPolicy";

/**
 * The supported-format list a guide shows, derived from CHAT_ATTACHMENT_FORMATS
 * (docs/policy/chat-attachment-formats.md §2: that table is the one source of
 * every user-facing format statement). Guide copy never lists extensions.
 */
export type HelpAttachmentFormats = {
  groups: Array<{ group: ChatAttachmentUiGroup; extensions: string[] }>;
  /** Extensions a signed-in reader may attach and a guest may not. */
  signedInOnly: string[];
  guestFiles: number;
  guestMegabytes: number;
};

export function helpAttachmentFormats(): HelpAttachmentFormats {
  const signedIn = chatAttachmentExtensionsByGroup();
  const guest = new Set(Object.values(chatAttachmentExtensionsByGroup({ guest: true })).flat());
  const groups = (Object.entries(signedIn) as Array<[ChatAttachmentUiGroup, string[]]>)
    .filter(([, extensions]) => extensions.length > 0)
    .map(([group, extensions]) => ({ group, extensions }));
  return {
    groups,
    signedInOnly: groups.flatMap((entry) => entry.extensions).filter((extension) => !guest.has(extension)),
    guestFiles: GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
    guestMegabytes: GUEST_MAX_ATTACHMENT_BYTES / (1024 * 1024),
  };
}

/** Guides that show the derived list under their steps. */
export const HELP_ATTACHMENT_FORMAT_GUIDES: ReadonlySet<string> = new Set(["attach-files"]);
