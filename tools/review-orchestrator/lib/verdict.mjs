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

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
// Unfenced objects are looked for around the last few mentions of "verdict" only,
// so a long answer full of braces cannot make the scan slow.
const MAX_UNFENCED_MENTIONS = 20;

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

const asObject = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

/** The balanced {...} around `at`, or null: starts at the nearest `{` before it. */
function objectAround(text, at) {
  const start = text.lastIndexOf("{", at);
  if (start < 0) return null;
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
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/**
 * The places the reviewer wrote a verdict, in order: fenced blocks that parse
 * as an object (or are marked json, or mention a verdict, and do not parse),
 * and unfenced objects around a "verdict" key. A candidate that does not parse
 * is kept as one with `parsed: null`: the LAST candidate decides, so a broken
 * final block is not replaced by an earlier accept.
 */
function candidates(text) {
  const found = [];
  const spans = [];
  for (const match of text.matchAll(FENCE)) {
    spans.push([match.index, match.index + match[0].length]);
    let parsed = null;
    try { parsed = asObject(JSON.parse(match[2])); } catch { /* not valid JSON */ }
    if (parsed || match[1].toLowerCase() === "json" || match[2].includes('"verdict"')) {
      found.push({ start: match.index, parsed });
    }
  }
  const inFence = (position) => spans.some(([from, to]) => position >= from && position < to);
  const mentions = [];
  for (let at = text.indexOf('"verdict"'); at >= 0; at = text.indexOf('"verdict"', at + 1)) {
    if (!inFence(at)) mentions.push(at);
  }
  let covered = -1;
  for (const at of mentions.slice(-MAX_UNFENCED_MENTIONS)) {
    if (at < covered) continue;
    const span = objectAround(text, at);
    if (!span || span.end <= at) continue;
    covered = span.end;
    let parsed = null;
    try { parsed = asObject(JSON.parse(text.slice(span.start, span.end))); } catch { /* not valid JSON */ }
    found.push({ start: span.start, parsed });
  }
  return found.sort((x, y) => x.start - y.start);
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
  const found = candidates(text);
  if (found.length === 0) return unknown("no_verdict_block");
  // The last place a verdict was written is the answer, even when it cannot be
  // read or says unknown: an earlier accept is not revived.
  const last = found.at(-1);
  if (last.parsed === null) return unknown("verdict_not_json");
  const parsed = last.parsed;
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
