import { interpolate, providerLabel } from "@/components/imports/importFormatting";

/**
 * The name an imported conversation is listed under.
 *
 * Its own title when the server sent one. A locked snapshot's title is not
 * sent at all (IMPORT-LOCK-TITLE-01), so it is named by what the owner may
 * still see: that it is locked, where it came from and when it was imported.
 * Not "Untitled": that would claim the conversation has no name.
 */
export function importedConversationTitle(
    row: { title: string | null; provider: string; importedAt?: string | null },
    t: (key: string) => string
): string {
    if (row.title !== null && row.title.trim() !== "") return row.title;
    if (row.title === null) {
        return interpolate(t("externalImport.lockedTitle"), {
            provider: providerLabel(row.provider),
            date: row.importedAt ? new Date(row.importedAt).toLocaleDateString() : "",
        });
    }
    return t("continuation.quickUntitled");
}
