import { z } from "zod";
import { SEVERITY_ORDER, normalizeReviewPath, reviewFinding, type MergedFinding, type ReviewFinding, type ReviewModelResult } from "./review-contract";

/**
 * What a reviewer writes back, and how several reviewers' lists become one. The reviewer is a model: its text
 * is data. It is checked against the finding schema one finding at a time, so one bad entry costs one finding.
 */

const MAX_FINDINGS = 60;
const envelope = z.object({ summary: z.string().max(8_000).nullish(), findings: z.array(z.unknown()) });

const severityWords: Record<string, ReviewFinding["severity"]> = {
  critical: "critical", blocker: "critical", high: "high", major: "high", error: "high",
  medium: "medium", moderate: "medium", warning: "medium", low: "low", minor: "low",
  info: "info", nit: "info", nitpick: "info", suggestion: "info", note: "info",
};

export type ParsedReview = { summary: string; findings: ReviewFinding[]; dropped: number };

/** The first JSON object in the reply (a fenced block is fine), or null when there is none that fits the schema. */
export function parseReviewReply(text: string): ParsedReview | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return null;
  const findings: ReviewFinding[] = [];
  let dropped = Math.max(0, parsed.data.findings.length - MAX_FINDINGS);
  for (const raw of parsed.data.findings.slice(0, MAX_FINDINGS)) {
    const candidate: unknown = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : raw;
    if (candidate && typeof candidate === "object") {
      const row = candidate as Record<string, unknown>;
      // Models write 0 or leave the line out for a finding about the whole file, and use their own words for severity.
      for (const key of ["line", "endLine"]) if (row[key] === 0) row[key] = null;
      const word = typeof row.severity === "string" ? severityWords[row.severity.trim().toLowerCase()] : undefined;
      if (word) row.severity = word;
    }
    const finding = reviewFinding.safeParse(candidate);
    if (finding.success) findings.push({ ...finding.data, file: normalizeReviewPath(finding.data.file) });
    else dropped += 1;
  }
  return { summary: (parsed.data.summary ?? "").trim(), findings, dropped };
}

const sameText = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One list for every model: the same finding (same file, line and wording) reported by two models appears once and
 * names both; the rest are ordered by severity, then file and line. Each keeps the models that reported it.
 */
export function mergeReviewResults(results: readonly ReviewModelResult[]): MergedFinding[] {
  const merged = new Map<string, Omit<MergedFinding, "id">>();
  for (const result of results) {
    if (result.status !== "ok") continue;
    for (const finding of result.findings) {
      const key = JSON.stringify([normalizeReviewPath(finding.file), finding.line, sameText(finding.description)]);
      const existing = merged.get(key);
      if (!existing) merged.set(key, { ...finding, file: normalizeReviewPath(finding.file), models: [result.modelName] });
      else {
        if (!existing.models.includes(result.modelName)) existing.models.push(result.modelName);
        // Two models rating one finding differently: the higher rating stands.
        if (SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(existing.severity)) existing.severity = finding.severity;
        existing.suggestion ??= finding.suggestion;
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) || a.models.join().localeCompare(b.models.join()))
    .map((finding, index) => ({ ...finding, id: `f${index + 1}` }));
}

/** The diff file a finding is about: its path as written, or without the a/ b/ prefix a model copies from a diff header. */
export function matchFindingPath(file: string, paths: ReadonlySet<string>): string | null {
  const path = normalizeReviewPath(file);
  if (paths.has(path)) return path;
  const bare = path.replace(/^[ab]\//, "");
  return bare !== path && paths.has(bare) ? bare : null;
}
