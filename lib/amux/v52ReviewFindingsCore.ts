import { detectSecrets } from "../engineeringAgentSecretPatterns.ts";

/**
 * The short reason a v52 review rejected a run, kept on its review record so
 * the owner can decide retry, recover at a higher grade or close from Admin
 * without reading the review server (owner decision 2026-11-14).
 *
 * The box's review launcher builds the lines from the review server's own
 * structured findings (scripts/amux-v52-review-runner.mjs). The app treats
 * them as untrusted display text: a line that looks like a secret is dropped,
 * a link is reduced to a marker (an internal URL is not owner reading), and
 * the whole is bounded before it is stored. It is never authority: the
 * verdict, the job id and the audit row decide everything; this text only
 * informs a person.
 */
export const AMUX_V52_FINDINGS_SUMMARY_MAX_CHARS = 2_000;
export const AMUX_V52_FINDINGS_SUMMARY_MAX_LINES = 12;
/** What the record route accepts before normalising; anything longer is refused. */
export const AMUX_V52_FINDINGS_SUMMARY_INPUT_MAX_CHARS = 8_192;

const LINE_MAX_CHARS = 320;
const SECRET_LINE = "- [redacted: looked like a credential]";
// C0 controls but tab and newline, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const URL = /\b(?:https?|wss?|ftp):\/\/[^\s)>\]]+/gi;

export function normalizeAmuxV52FindingsSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lines: string[] = [];
  let length = 0;
  for (const raw of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (lines.length >= AMUX_V52_FINDINGS_SUMMARY_MAX_LINES) break;
    let line = raw.replace(CONTROL, "").replace(/\t/g, " ").trim();
    if (!line) continue;
    if (detectSecrets(line).length > 0) line = SECRET_LINE;
    line = line.replace(URL, "[link]");
    if (line.length > LINE_MAX_CHARS) line = `${line.slice(0, LINE_MAX_CHARS - 1)}…`;
    const next = length + (lines.length ? 1 : 0) + line.length;
    if (next > AMUX_V52_FINDINGS_SUMMARY_MAX_CHARS) break;
    lines.push(line);
    length = next;
  }
  return lines.length ? lines.join("\n") : null;
}

/** What Admin reads about one attempt's v52 review. */
export type AmuxV52AttemptReviewView = {
  verdict: string;
  jobId: string | null;
  reviewerVendors: string[];
  findingsSummary: string | null;
};

const JOB_ID = /^r-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

/**
 * A rejected review as the owner sees it, or null for any other verdict. A
 * record from before the summary was kept says where the reasons are instead.
 */
export function amuxV52RejectionView(review: unknown):
  | { kind: "summary"; lines: string[]; jobId: string | null; reviewerVendors: string[] }
  | { kind: "job"; jobId: string; reviewerVendors: string[] }
  | { kind: "none"; reviewerVendors: string[] }
  | null {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const item = review as Record<string, unknown>;
  if (item.verdict !== "reject") return null;
  const jobId = typeof item.jobId === "string" && JOB_ID.test(item.jobId) ? item.jobId : null;
  const reviewerVendors = Array.isArray(item.reviewerVendors)
    ? item.reviewerVendors.filter((vendor): vendor is string => typeof vendor === "string").slice(0, 4)
    : [];
  const summary = normalizeAmuxV52FindingsSummary(item.findingsSummary);
  if (summary) return { kind: "summary", lines: summary.split("\n"), jobId, reviewerVendors };
  if (jobId) return { kind: "job", jobId, reviewerVendors };
  return { kind: "none", reviewerVendors };
}
