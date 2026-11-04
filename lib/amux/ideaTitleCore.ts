/**
 * The plaintext title an AMUX idea is listed under (owner decision 2026-11-04).
 * An idea's body is encrypted and a lane idea registers no card, so without it
 * the Ideas tab could only show a request id. The title is the body's first
 * non-blank line, trimmed and cut to AMUX_IDEA_TITLE_MAX characters; no model
 * call makes it. It lives only while the body does: the raw purge clears both
 * (lib/amux/ideaRawRetentionService.ts, CHECK AmuxIdeaSubmission_title_check).
 *
 * The backfill in prisma/migrations/20261104130000_amux_idea_title repeats this
 * rule in SQL for Scout suggestions already sent; keep the two in step.
 */

export const AMUX_IDEA_TITLE_MAX = 80;

/** suggestionIdeaText (lib/productResearchScoutCore.ts) opens a Scout idea with it. */
const SCOUT_PREFIX = "[Scout 제안]";

export function amuxIdeaTitleFromText(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return null;
  let title = line.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  if (title.startsWith(SCOUT_PREFIX)) title = title.slice(SCOUT_PREFIX.length).trim();
  // Code points, so a cut never splits a surrogate pair and matches SQL char_length.
  const points = Array.from(title);
  if (points.length > AMUX_IDEA_TITLE_MAX) {
    title = `${points.slice(0, AMUX_IDEA_TITLE_MAX - 1).join("").trimEnd()}…`;
  }
  return title === "" ? null : title;
}

/** The first 8 characters of the request id, the idea's short id. */
export const amuxIdeaShortId = (requestId: string) => requestId.slice(0, 8);

/**
 * What names an idea, in order: its first card's display key, its title (with
 * the short id beside it), else "Untitled" and the short id.
 */
export function amuxIdeaName(row: { displayKey: string | null; title?: string | null; requestId: string },
  untitled: string): { primary: string; shortId: string | null } {
  if (row.displayKey) return { primary: row.displayKey, shortId: null };
  if (row.title) return { primary: row.title, shortId: amuxIdeaShortId(row.requestId) };
  return { primary: `${untitled} ${amuxIdeaShortId(row.requestId)}`, shortId: null };
}

/** The same name as one string, for an aria-label or a line of text. */
export function amuxIdeaNameText(row: Parameters<typeof amuxIdeaName>[0], untitled: string): string {
  const name = amuxIdeaName(row, untitled);
  return name.shortId ? `${name.primary} (${name.shortId})` : name.primary;
}
