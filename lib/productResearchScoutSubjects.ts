/**
 * What a Scout subject id names, for the Admin view: `pricing.ko` is the
 * Korean pricing page, `pdf.document` a PDF from a fixed specification,
 * `generated.pdf` one the product made for a real prompt, `catalogue` the model
 * catalogue. The id is what the walker sent and the suggestion stored; the
 * labels themselves live in the Admin messages.
 */
import { SCOUT_GENERATIONS, SCOUT_PAGES, SCOUT_SIGNED_IN_PAGES } from "@/lib/productResearchScoutBrowserPolicy.mjs";

export type ScoutSubjectInfo =
  | { readonly kind: "page"; readonly page: string; readonly lang: string; readonly path: string; readonly href: string }
  | { readonly kind: "file"; readonly format: string }
  | { readonly kind: "catalogue" }
  | { readonly kind: "other" };

export function scoutSubjectInfo(subject: string): ScoutSubjectInfo {
  if (subject === "catalogue") return { kind: "catalogue" };
  const page = ([...SCOUT_PAGES, ...SCOUT_SIGNED_IN_PAGES] as readonly { id: string; path: string; lang: string }[]).find(
    (entry) => entry.id === subject,
  );
  if (page) {
    const name = subject.slice(0, subject.lastIndexOf("."));
    // Relative, so the link opens the page on the environment the viewer is on.
    return { kind: "page", page: name, lang: page.lang, path: page.path, href: page.path };
  }
  const generated = /^generated\.(pdf|docx|xlsx|pptx|image)$/.exec(subject);
  if (generated) return { kind: "file", format: `generated-${generated[1]}` };
  const file = /^(pdf|docx|xlsx|pptx)\.[a-z]+$/.exec(subject);
  if (file) return { kind: "file", format: file[1] };
  return { kind: "other" };
}

/** The generations a walker asked for, in the table's order; anything else in its body is ignored. */
export function requestedScoutGenerations(body: unknown): string[] {
  const asked = (body as { generations?: unknown } | null)?.generations;
  if (!Array.isArray(asked)) return [];
  return (SCOUT_GENERATIONS as readonly { id: string }[]).map((generation) => generation.id).filter((id) => asked.includes(id));
}
