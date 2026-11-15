/**
 * Reviewer output is a signal; the verdict is decided here. A reviewer should
 * end with one fenced json block, but an internal development flow has no
 * reason to throw away a review over a slip of format (owner decision
 * 2026-11-15): this reads as much as it can. There is no cap on findings or on
 * the length of a finding, a finding with a slightly different shape is kept
 * in the nearest valid one, and a block that is not fenced is still found.
 *
 * What is never guessed is the verdict itself. An output with no readable
 * verdict and no blocking finding is `unknown` -- never a guessed accept -- and
 * the service then asks another reviewer instead of ending there.
 */

export const SEVERITIES = ["blocker", "major", "minor", "nit"];
const BLOCKING = new Set(["blocker", "major"]);

// Names reviewers use for the same four levels.
const SEVERITY_SYNONYMS = new Map([
  ["critical", "blocker"], ["blocking", "blocker"], ["high", "major"], ["error", "major"],
  ["medium", "minor"], ["moderate", "minor"], ["warning", "minor"], ["low", "nit"],
  ["info", "nit"], ["suggestion", "nit"], ["style", "nit"],
]);

const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;

const unknown = (reason) => ({ verdict: "unknown", reason, findings: [] });

function severityOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (SEVERITIES.includes(name)) return name;
  return SEVERITY_SYNONYMS.get(name) ?? null;
}

function normaliseFinding(raw) {
  if (typeof raw === "string") {
    // A bare string is a finding with no stated severity: kept, as a minor one.
    return raw.trim() === "" ? null : { severity: "minor", summary: raw };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = raw.summary ?? raw.message ?? raw.description ?? raw.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  // An unnamed or unfamiliar severity is not a reason to lose the finding.
  const finding = { severity: severityOf(raw.severity) ?? "minor", summary: text };
  if (typeof raw.file === "string" && raw.file !== "") finding.file = raw.file;
  const line = typeof raw.line === "string" && /^\d+$/.test(raw.line.trim()) ? Number(raw.line) : raw.line;
  if (Number.isInteger(line) && line >= 0) finding.line = line;
  return finding;
}

/** Every JSON object in the text that mentions a verdict, last first: a block, fenced or not. */
function candidateObjects(text) {
  const found = [];
  for (const match of text.matchAll(FENCE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) found.push(parsed);
    } catch { /* not a block of ours */ }
  }
  if (found.length > 0) return found.reverse();
  // No usable fenced block: look for a balanced {...} that has a verdict.
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
                "verdict" in parsed) return [parsed];
          } catch { /* keep looking further back */ }
          break;
        }
      }
    }
  }
  return [];
}

function verdictOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (["accept", "accepted", "approve", "approved", "pass", "lgtm"].includes(name)) return "accept";
  if (["reject", "rejected", "request_changes", "request-changes", "changes_requested", "fail"].includes(name)) return "reject";
  return null;
}

export function parseReviewerOutput(text) {
  if (typeof text !== "string" || text.length === 0) return unknown("empty_output");
  const objects = candidateObjects(text);
  if (objects.length === 0) return unknown("no_verdict_block");
  // The last object that states a verdict or lists findings is the answer.
  const parsed = objects.find((item) => verdictOf(item.verdict) !== null || Array.isArray(item.findings)) ?? objects[0];
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
    .flatMap((raw) => { const finding = normaliseFinding(raw); return finding ? [finding] : []; });
  // A blocker or major finding rejects whatever the reviewer concluded.
  const blocking = findings.some((finding) => BLOCKING.has(finding.severity));
  const stated = verdictOf(parsed.verdict);
  if (blocking) {
    return stated === "reject" ? { verdict: "reject", findings }
      : { verdict: "reject", reason: stated === "accept" ? "blocking_finding_overrides_accept" : "blocking_finding_without_verdict", findings };
  }
  if (stated === null) return { verdict: "unknown", reason: "verdict_value_invalid", findings };
  return { verdict: stated, findings };
}

/** One job's status from its slots: pending, then reject, then unknown, then accept. */
export function aggregate(slots) {
  if (slots.length === 0) return "unknown";
  if (slots.some((slot) => slot.status !== "done")) return "pending";
  if (slots.some((slot) => slot.verdict === "reject")) return "reject";
  if (slots.some((slot) => slot.verdict !== "accept")) return "unknown";
  return "accept";
}
