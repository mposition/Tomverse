import { HELP_GUIDES } from "./catalog";
import type { HelpLocaleCopy } from "./types";

/**
 * Instant filter for the question box while the reader types: guides whose
 * words contain every typed term, title matches first. It narrows a list the
 * reader can already see; answering a question is the assistant's job.
 */
export function searchHelpGuides(copy: HelpLocaleCopy, query: string): string[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: Array<{ id: string; score: number; titleLength: number }> = [];
  for (const guide of HELP_GUIDES) {
    const words = copy.guides[guide.id];
    const title = words.title.toLocaleLowerCase();
    const body = [
      words.summary,
      copy.categories[guide.category].title,
      ...words.steps.flatMap((step) => [step.title, step.body]),
      ...words.faq.flatMap((item) => [item.q, item.a]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (!terms.every((term) => title.includes(term) || body.includes(term))) continue;
    scored.push({ id: guide.id, score: terms.filter((term) => title.includes(term)).length, titleLength: title.length });
  }
  // More title hits first; among equals, the shorter title is the more direct
  // match ("Request a refund" before "Image credits and refunds").
  return scored
    .sort((a, b) => b.score - a.score || (b.score > 0 ? a.titleLength - b.titleLength : 0))
    .map((entry) => entry.id);
}
