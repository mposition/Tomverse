import { CHAT_ATTACHMENT_FORMATS, type ChatAttachmentUiGroup } from "@/lib/chatAttachmentFormats";
import { GUEST_MAX_ATTACHMENTS_PER_MESSAGE, GUEST_MAX_ATTACHMENT_BYTES } from "@/lib/guestAttachmentPolicy";

/**
 * The supported-format list a guide shows, derived from CHAT_ATTACHMENT_FORMATS
 * (docs/policy/chat-attachment-formats.md §2: that table is the one source of
 * every user-facing format statement). Guide copy never lists formats.
 *
 * Each entry is how a reader recognises the file: `.ext` for an extension, or
 * the exact name for the extensionless or dot-leading files the table accepts
 * by name (`Dockerfile`, `.gitignore`).
 */
export type HelpAttachmentFormats = {
  groups: Array<{ group: ChatAttachmentUiGroup; entries: string[] }>;
  /** Entries a signed-in reader may attach and a guest may not. */
  signedInOnly: string[];
  guestFiles: number;
  guestMegabytes: number;
};

const GROUP_ORDER: readonly ChatAttachmentUiGroup[] = ["image", "document", "data", "markup", "code", "archive"];

const entriesOf = (format: (typeof CHAT_ATTACHMENT_FORMATS)[number]) => [
  ...format.extensions.map((extension) => `.${extension}`),
  ...(format.filenames ?? []),
];

export function helpAttachmentFormats(): HelpAttachmentFormats {
  const byGroup = new Map<ChatAttachmentUiGroup, string[]>(GROUP_ORDER.map((group) => [group, []]));
  const guest = new Set<string>();
  for (const format of CHAT_ATTACHMENT_FORMATS) {
    const entries = entriesOf(format);
    byGroup.get(format.uiGroup)!.push(...entries);
    if (format.guestAllowed) for (const entry of entries) guest.add(entry);
  }
  const groups = GROUP_ORDER.map((group) => ({ group, entries: [...new Set(byGroup.get(group)!)] })).filter(
    (entry) => entry.entries.length > 0
  );
  return {
    groups,
    signedInOnly: groups.flatMap((entry) => entry.entries).filter((entry) => !guest.has(entry)),
    guestFiles: GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
    guestMegabytes: GUEST_MAX_ATTACHMENT_BYTES / (1024 * 1024),
  };
}

/** Guides that show the derived list under their steps. */
export const HELP_ATTACHMENT_FORMAT_GUIDES: ReadonlySet<string> = new Set(["attach-files"]);
