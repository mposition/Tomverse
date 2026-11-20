import { infoPages } from "@/components/marketing/marketingInfoContent";
import type { MarketingInfoCopy } from "@/components/marketing/MarketingInfoPage";
import type { Language } from "@/lib/language";

export type PolicyDocumentCard = Pick<MarketingInfoCopy, "eyebrow" | "title" | "description" | "updated">;
type Localized<T> = { en: T } & Partial<Record<Language, T>>;
export type PolicyDocumentCards = Record<"terms" | "refund", Localized<PolicyDocumentCard>>;

const headings = (content: Localized<MarketingInfoCopy>) => Object.fromEntries(Object.entries(content).map(([lang, copy]) => [lang, {
  eyebrow: copy.eyebrow, title: copy.title, description: copy.description, updated: copy.updated,
}])) as Localized<PolicyDocumentCard>;

/**
 * The heading lines of the terms and the refund policy, as written, for the
 * safety page's document cards. Built on the server so the clauses themselves
 * stay out of the safety page's client bundle.
 */
export const policyDocumentCards = (): PolicyDocumentCards => ({
  terms: headings(infoPages.terms),
  refund: headings(infoPages.refund),
});
