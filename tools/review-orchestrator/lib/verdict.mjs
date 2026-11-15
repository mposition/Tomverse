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
// Looking outward from the final "verdict" key for the objects that hold it costs
// at most this many characters scanned in all, so a long answer full of braces
// cannot make the scan slow (the answer itself is bounded at 8 MiB).
const ENCLOSING_SCAN_BUDGET = 24_000_000;

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
  if (raw.repeats_earlier === true || raw.repeatsEarlier === true) finding.repeats_earlier = true;
  return finding;
}

const asObject = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);

/** The end of the balanced {...} that starts at `start`, or null when it never closes. `budget.left` counts the characters scanned. */
function balancedFrom(text, start, budget) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    if (budget.left-- <= 0) return null;
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** Every ``` fence, closed or not (an unclosed last one runs to the end of the text). */
function fences(text) {
  const found = [];
  let end = 0;
  for (const match of text.matchAll(FENCE)) {
    found.push({ start: match.index, end: match.index + match[0].length, tag: match[1].toLowerCase(),
      body: match[2], closed: true });
    end = match.index + match[0].length;
  }
  const open = text.indexOf("```", end);
  if (open >= 0) {
    const lineEnd = text.indexOf("\n", open);
    found.push({ start: open, end: text.length, tag: text.slice(open + 3, lineEnd < 0 ? text.length : lineEnd).trim().toLowerCase(),
      body: lineEnd < 0 ? "" : text.slice(lineEnd + 1), closed: false });
  }
  return found;
}

/**
 * The place the reviewer wrote its FINAL verdict, and what it parses to:
 * `{ parsed }` where parsed is the object or null when that place cannot be
 * read. The last written verdict decides -- the last fenced json block or the
 * last unfenced object holding a "verdict" key, whichever comes later -- so a
 * broken, unclosed or oddly ordered final block is never replaced by an
 * earlier accept. Null when no verdict was written at all.
 */
function finalVerdict(text) {
  const keyAt = text.lastIndexOf('"verdict"');
  const all = fences(text);
  const marked = all.filter((fence) => fence.tag === "json" || fence.body.includes('"verdict"'));
  const lastMarked = marked.at(-1) ?? null;
  const holding = keyAt >= 0 ? all.find((fence) => keyAt >= fence.start && keyAt < fence.end) ?? null : null;
  // A json fence that comes after the key (with no key of its own) is the later answer.
  const fence = holding ? (lastMarked && lastMarked.start > holding.start ? lastMarked : holding)
    : lastMarked && (keyAt < 0 || lastMarked.end > keyAt) ? lastMarked : null;
  if (fence) {
    if (!fence.closed) return { parsed: null };
    try { return { parsed: asObject(JSON.parse(fence.body)) }; } catch { return { parsed: null }; }
  }
  if (keyAt < 0) return null;
  // Unfenced: the OUTERMOST object that holds the key, found outward from it. An
  // object that closes before the key (a nested finding) does not hold it, and
  // one that holds it but sits inside the answer (`"expected": {"verdict": ...}`
  // in a finding) is not the answer: the answer is the widest object around the
  // key that is JSON and has a verdict of its own. Keys may come in any order.
  // A `{` inside a JSON string is no object start: it lies inside the answer's own
  // text, so only starts BEFORE the widest valid object can make it unreadable.
  const budget = { left: ENCLOSING_SCAN_BUDGET };
  let answer = null;
  let answerStart = -1;
  const bad = [];
  for (let from = keyAt; from >= 0;) {
    const start = text.lastIndexOf("{", from);
    if (start < 0) break;
    from = start - 1;
    const end = balancedFrom(text, start, budget);
    if (end === null) { bad.push(start); if (budget.left <= 0) break; continue; }
    if (end <= keyAt) continue;
    try {
      const parsed = asObject(JSON.parse(text.slice(start, end)));
      if (parsed && "verdict" in parsed) { answer = parsed; answerStart = start; }
      else bad.push(start);
    } catch { bad.push(start); }
  }
  // An unfinished or non-JSON block around the key that begins before the answer
  // means the final block is unreadable, not that an inner object is the answer.
  if (answer === null || bad.some((start) => start < answerStart)) return { parsed: null };
  return { parsed: answer };
}

function verdictOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (["accept", "accepted", "approve", "approved", "pass", "lgtm"].includes(name)) return "accept";
  if (["reject", "rejected", "request_changes", "request-changes", "changes_requested", "fail"].includes(name)) return "reject";
  return null;
}

/**
 * The findings the reviewer wrote, in whatever container it used: an array, one
 * finding object, an object keyed by finding, or one string. Nothing listed
 * (absent, null, empty) is an empty list.
 */
function findingList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (typeof value !== "object") return [value];
  if ("summary" in value || "message" in value || "description" in value || "text" in value) return [value];
  return Object.values(value);
}

export function parseReviewerOutput(text) {
  if (typeof text !== "string" || text.length === 0) return unknown("empty_output");
  const last = finalVerdict(text);
  if (last === null) return unknown("no_verdict_block");
  // The last place a verdict was written is the answer, even when it cannot be
  // read or says unknown: an earlier accept is not revived.
  if (last.parsed === null) return unknown("verdict_not_json");
  const parsed = last.parsed;
  const listed = findingList(parsed.findings);
  const findings = listed.flatMap((raw) => { const finding = normaliseFinding(raw); return finding ? [finding] : []; });
  // A blocker or major finding rejects whatever the reviewer concluded.
  const blocking = findings.some((finding) => BLOCKING.has(finding.severity));
  const stated = verdictOf(parsed.verdict);
  if (blocking) {
    return stated === "reject" ? { verdict: "reject", findings }
      : { verdict: "reject", reason: stated === "accept" ? "blocking_finding_overrides_accept" : "blocking_finding_without_verdict", findings };
  }
  if (stated === null) return { verdict: "unknown", reason: "verdict_value_invalid", findings };
  // Findings were listed but none could be read: an accept next to them is not trusted.
  if (stated === "accept" && listed.length > 0 && findings.length === 0) {
    return { verdict: "unknown", reason: "findings_unreadable", findings };
  }
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
