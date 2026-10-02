/**
 * Reviewer output is a signal; the verdict is decided here. A reviewer must
 * end with one fenced json block. Anything that does not parse into the exact
 * shape is `unknown` -- never a guessed accept, and never a reason to send the
 * job to another provider behind the operator's back.
 */

export const SEVERITIES = ["blocker", "major", "minor", "nit"];
const BLOCKING = new Set(["blocker", "major"]);
const MAX_FINDINGS = 200;
const MAX_TEXT = 4000;

const FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

const unknown = (reason) => ({ verdict: "unknown", reason, findings: [] });

function normaliseFinding(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { severity, summary, file, line } = raw;
  if (!SEVERITIES.includes(severity)) return null;
  if (typeof summary !== "string" || summary.trim() === "") return null;
  const finding = { severity, summary: summary.slice(0, MAX_TEXT) };
  if (file !== undefined && file !== null) {
    if (typeof file !== "string") return null;
    finding.file = file.slice(0, 500);
  }
  if (line !== undefined && line !== null) {
    if (!Number.isInteger(line) || line < 0) return null;
    finding.line = line;
  }
  return finding;
}

export function parseReviewerOutput(text) {
  if (typeof text !== "string" || text.length === 0) return unknown("empty_output");
  const blocks = [...text.matchAll(FENCE)];
  if (blocks.length === 0) return unknown("no_verdict_block");
  let parsed;
  try {
    parsed = JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return unknown("verdict_not_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return unknown("verdict_not_object");
  }
  if (parsed.verdict !== "accept" && parsed.verdict !== "reject") {
    return unknown("verdict_value_invalid");
  }
  if (!Array.isArray(parsed.findings) || parsed.findings.length > MAX_FINDINGS) {
    return unknown("findings_invalid");
  }
  const findings = [];
  for (const raw of parsed.findings) {
    const finding = normaliseFinding(raw);
    if (finding === null) return unknown("finding_invalid");
    findings.push(finding);
  }
  // A blocker or major finding rejects whatever the reviewer concluded.
  const blocking = findings.some((finding) => BLOCKING.has(finding.severity));
  if (blocking && parsed.verdict === "accept") {
    return { verdict: "reject", reason: "blocking_finding_overrides_accept", findings };
  }
  return { verdict: parsed.verdict, findings };
}

/** One job's status from its slots: pending, then reject, then unknown, then accept. */
export function aggregate(slots) {
  if (slots.length === 0) return "unknown";
  if (slots.some((slot) => slot.status !== "done")) return "pending";
  if (slots.some((slot) => slot.verdict === "reject")) return "reject";
  if (slots.some((slot) => slot.verdict !== "accept")) return "unknown";
  return "accept";
}
