// What the merge gate blocks on, and why it is narrower than the report.
//
// The report (`report-unconsumed-response-bodies*.mjs`) prints every place the
// question can be asked. This decides which of those may stop a merge, and the
// scope is deliberately smaller than "everything the report found" in four
// specific ways.
//
// **Browser-capable, not `browser`.** The runtime split calls `lib/` modules
// with neither a `server-only` import nor a `"use client"` directive `either`,
// because that directory holds both halves. Gating on `browser` alone would
// exempt exactly the shared modules a client imports — `lib/useBuildInfo.ts`,
// `lib/feedbackClient.ts`, `lib/productAnalyticsClient.ts` — so `either` is in.
//
// **Only the target the measurement covers.** A same-origin `/api/*` route
// taking the proxy default is the one combination that was measured on
// Chromium. The five routes that choose their own caching were measured and
// completed; anything cross-origin was never measured at all. Blocking those
// too would make the gate broader than its evidence, which is how a gate stops
// being defensible the first time somebody argues with it.
//
// **`unparsed` fails.** A file this cannot parse produces no findings, and a
// gate that reads no findings as "clean" is not fail-closed. Only in
// browser-capable code, for the same reason as above.
//
// **Server findings do not block.** They are calls to provider APIs, where the
// concern is undici's connection pool — real, separate, and not measured here.
// Blocking on them would borrow this gate's authority for a claim it cannot
// make. How many there are is a moving number and is deliberately not written
// down here: `npm run report:unconsumed-response-bodies` prints today's, and a
// count baked into a comment is wrong by the next merge. What is fixed is the
// baseline this gate defends — the browser side reached zero at `def2b46`
// (#522), and the gate exists to keep it there.
//
// Exceptions are waivers with a path, a reason and an approver — never a
// silently narrowed filter. A waiver that stops matching anything is itself a
// failure: a gate whose exception list has drifted off its targets is quietly
// checking less than it says.

/** Runtimes whose code can run in a browser, so the measurement can apply. */
export const BROWSER_CAPABLE_RUNTIMES = Object.freeze(["browser", "either"]);

/** The one request target the Chromium measurement covers. */
export const BLOCKING_TARGET = "api_default_no_store";

/**
 * Findings allowed to stay, with who allowed them.
 *
 * Empty, and that is the state to keep it in: the browser side was swept to
 * zero before this gate existed, so an entry here is a decision that some
 * response body may go unread, not a formality. Each needs `file`, `request`
 * (the first argument exactly as the report prints it), `reason`, `approvedBy`
 * and `approvedAt`.
 */
export const WAIVERS = Object.freeze([]);

const isBrowserCapable = (finding) =>
  BROWSER_CAPABLE_RUNTIMES.includes(finding.runtime);

/** Whether this finding is the kind that stops a merge, before waivers. */
export function isBlockable(finding) {
  if (!isBrowserCapable(finding)) return false;
  if (finding.kind === "unparsed") return true;
  return finding.kind === "leaks" && finding.target === BLOCKING_TARGET;
}

const waiverMatches = (waiver, finding) =>
  waiver.file === finding.file && waiver.request === finding.request;

/**
 * Splits a scan into what blocks, what a waiver excused, and which waivers
 * matched nothing.
 */
export function selectBlocking(findings, waivers = WAIVERS) {
  const blockable = findings.filter(isBlockable);
  const blocking = [];
  const waived = [];
  const used = new Set();
  for (const finding of blockable) {
    const waiver = waivers.find((candidate) => waiverMatches(candidate, finding));
    if (waiver) {
      used.add(waiver);
      waived.push({ finding, waiver });
    } else {
      blocking.push(finding);
    }
  }
  const staleWaivers = waivers.filter((waiver) => !used.has(waiver));
  return { blocking, waived, staleWaivers };
}

/** What a waiver must carry before it is allowed to excuse anything. */
export function waiverProblems(waivers = WAIVERS) {
  const problems = [];
  waivers.forEach((waiver, index) => {
    for (const field of ["file", "request", "reason", "approvedBy", "approvedAt"]) {
      if (typeof waiver[field] !== "string" || waiver[field].trim() === "") {
        problems.push(`waiver ${index} is missing ${field}`);
      }
    }
  });
  return problems;
}
