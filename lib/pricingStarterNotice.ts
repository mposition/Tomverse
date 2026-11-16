import { findChatStarterEntry } from "@/lib/chatStarterCatalog";

/** Return the localized catalogue label for a starter id carried into pricing. */
export const getPricingStarterLabelKey = (
  starterId: string | null | undefined
): string | null => {
  if (!starterId) return null;
  return findChatStarterEntry(starterId)?.labelKey ?? null;
};
