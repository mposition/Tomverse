/**
 * What a Scout subject id names, for the Admin view: `pricing.ko` is the
 * Korean pricing page, `pdf.document` a generated PDF, `catalogue` the model
 * catalogue. The id is what the walker sent and the suggestion stored; the
 * labels themselves live in the Admin messages.
 */
import { SCOUT_PAGE_ORIGIN, SCOUT_PAGES } from "@/lib/productResearchScoutBrowserPolicy.mjs";

export type ScoutSubjectInfo =
  | { readonly kind: "page"; readonly page: string; readonly lang: string; readonly path: string; readonly href: string }
  | { readonly kind: "file"; readonly format: string }
  | { readonly kind: "catalogue" }
  | { readonly kind: "other" };

export function scoutSubjectInfo(subject: string): ScoutSubjectInfo {
  if (subject === "catalogue") return { kind: "catalogue" };
  const page = (SCOUT_PAGES as readonly { id: string; path: string; lang: string }[]).find((entry) => entry.id === subject);
  if (page) {
    const name = subject.slice(0, subject.lastIndexOf("."));
    return { kind: "page", page: name, lang: page.lang, path: page.path, href: `${SCOUT_PAGE_ORIGIN}${page.path}` };
  }
  const file = /^(pdf|docx|xlsx|pptx)\.[a-z]+$/.exec(subject);
  if (file) return { kind: "file", format: file[1] };
  return { kind: "other" };
}
