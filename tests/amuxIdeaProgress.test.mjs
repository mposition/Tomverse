import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import { amuxIdeaProgress, amuxIdeaProgressFailureLog, amuxIdeaProgressStep } from "../lib/amux/ideaProgressCore.ts";
import { AMUX_IDEA_PROGRESS_LIMIT, readAmuxIdeaProgressInTx } from "../lib/amux/ideaProgressRead.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const facts = (overrides = {}) => ({ state: "submitted", cancelled: false, chunks: [], proposedUnits: 0, cards: [],
  ...overrides });
const chunk = (overrides = {}) => ({ chunkIndex: 0, state: "draft_ready", coverageStatus: "complete",
  previewState: "completed", holdStatus: "succeeded", ...overrides });
const task = (overrides = {}) => ({ cardType: "task", status: "todo", reviewPrNumber: null, merged: false, ...overrides });

test("each idea is at exactly one of the six stages, and a human step still open always comes first", () => {
  const stage = (value) => { const result = amuxIdeaProgress(facts(value)); return [result.stage, result.waitingFor]; };
  assert.deepEqual(stage({}), ["execution_approval", "execution_approval"], "saved, nothing approved yet");
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "prepared", holdStatus: null })] }),
    ["execution_approval", "execution_approval"]);
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "expired", holdStatus: "released" })] }),
    ["execution_approval", "execution_approval"], "an expired preview needs a new approval");
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "confirmed", holdStatus: "reserved" })] }),
    ["analysis", null]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ state: "in_flight", coverageStatus: null, previewState: "in_flight", holdStatus: "in_flight" })] }),
    ["analysis", null]);
  // analyzing, but waiting on a person: the next page, or the owner's answer.
  assert.deepEqual(stage({ state: "analyzing", proposedUnits: 2, chunks: [chunk({ coverageStatus: "more" })] }),
    ["execution_approval", "continuation"]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk(), chunk({ chunkIndex: 1, state: "awaiting_preview", coverageStatus: null,
    previewState: "prepared", holdStatus: null })] }), ["execution_approval", "continuation"]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ coverageStatus: "needs_owner_input" })] }),
    ["execution_approval", "owner_input"]);
  assert.deepEqual(stage({ state: "awaiting_owner", proposedUnits: 3, chunks: [chunk()] }), ["plan_approval", "plan_approval"]);
  // Some cards registered one by one, proposals still undecided: the plan is still waiting.
  assert.deepEqual(stage({ proposedUnits: 1, chunks: [chunk()], cards: [task({ merged: true })] }), ["plan_approval", "plan_approval"]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task(), task({ cardType: "story" })] }), ["execution", null]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "review", reviewPrNumber: 12 }), task()] }), ["review", null]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "done", merged: true }), task({ cardType: "story" })] }),
    ["done", null], "stories do not hold an idea open");
  assert.deepEqual(stage({ cancelled: true, cards: [task()] }), ["cancelled", null]);
  assert.deepEqual(stage({ state: "awaiting_owner", chunks: [chunk({ state: "decided" })] }), ["plan_approval", null],
    "a finished analysis with nothing left to decide waits for nobody");
  // An unknown outcome on an earlier page does not hide the latest page's human step.
  const mixed = amuxIdeaProgress(facts({ state: "analyzing", chunks: [chunk({ previewState: "outcome_unknown" }),
    chunk({ chunkIndex: 1, coverageStatus: "more" })] }));
  assert.deepEqual([mixed.waitingFor, mixed.attention], ["continuation", false]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "cancelled" })] }), ["cancelled", null],
    "tasks all cancelled are not done");
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ merged: true }), task({ status: "cancelled" })] }), ["done", null]);
  // A stale hold on an earlier page never hides the human step on the latest one.
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ holdStatus: "reserved" }), chunk({ chunkIndex: 1, coverageStatus: "needs_owner_input" })] }),
    ["execution_approval", "owner_input"]);
  const counts = amuxIdeaProgress(facts({ cards: [task({ merged: true }), task({ status: "review", reviewPrNumber: 3 }), task()] })).tasks;
  assert.deepEqual(counts, { total: 3, done: 1, inReview: 1 });
});

test("an unknown outcome is flagged, never a decision to retry", () => {
  for (const value of [chunk({ previewState: "outcome_unknown" }), chunk({ holdStatus: "outcome_unknown" }),
    chunk({ state: "outcome_unknown" })]) {
    const result = amuxIdeaProgress(facts({ proposedUnits: 1, chunks: [value] }));
    assert.equal(result.attention, true);
    assert.equal(result.waitingFor, null, "a stopped idea is not offered as a decision");
  }
  assert.deepEqual(["execution_approval", "done", "cancelled"].map(amuxIdeaProgressStep), [1, 6, null]);
});

test("the list is one statement in one bounded snapshot that never reads idea text", async () => {
  // Seven reads made eight gaps under the boundary's 100 ms idle-in-transaction
  // timeout and the production read failed; one statement has the two gaps of
  // every other read boundary: setup + the statement + fence.
  assert.deepEqual(AMUX_DB_BOUNDARIES.ideaProgressListRead,
    { operation: "idea_progress_list_read", prismaCallCeiling: 3, isolation: "read" });
  const calls = [];
  const rows = [{
    id: "idea-1", requestId: "11111111-1111-4111-8111-111111111111", state: "awaiting_owner",
    submittedAtMs: Date.parse("2026-10-15T00:00:00.123Z"), cancelled: false, proposedUnits: 0,
    chunks: [{ chunkIndex: 0, state: "decided", coverageStatus: "complete", previewState: "completed", holdStatus: "succeeded" }],
    cards: [
      { id: "c1", cardType: "story", status: "backlog", reviewPrNumber: null, terminal: false, displayKey: "AMUX-ADM-001" },
      { id: "c2", cardType: "task", status: "review", reviewPrNumber: 2540, terminal: false, displayKey: "AMUX-ADM-002" }],
    checkoutEvidence: [{ referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 2,
      secretPath: 1, secretContent: 1, nonRegular: 0, unscannableContent: 0,
      readFileCount: 2, readDigest: "b".repeat(64), readBodyPurged: false }],
  }, {
    // An idea with no chunk and no card comes back with SQL NULL aggregates.
    id: "idea-2", requestId: "22222222-2222-4222-8222-222222222222", state: "submitted",
    submittedAtMs: Date.parse("2026-10-14T00:00:00Z"), cancelled: false, proposedUnits: 0, chunks: null, cards: null,
    checkoutEvidence: null,
  }];
  const tx = { $queryRaw: async (strings, ...values) => { calls.push({ sql: strings.join("?"), values }); return rows; } };
  const now = new Date("2026-10-15T03:00:00Z");
  const [row, empty] = await readAmuxIdeaProgressInTx(tx, "owner-1", now);
  assert.equal(calls.length, 1, "one statement, however many ideas");
  const { sql, values } = calls[0];
  assert.equal(/Ciphertext|"title"|"body"|bodyDigest|rawDigest/i.test(sql), false, "no idea text or digest is read");
  assert.ok(values.includes("owner-1") && values.includes(AMUX_IDEA_PROGRESS_LIMIT), "owner scoped and bounded");
  assert.ok(values.includes(now.toISOString()), "the proposal expiry is compared with the database clock");
  assert.ok(sql.includes(`u."expiresAt" > (?::timestamptz AT TIME ZONE 'UTC')`), "an expired proposal waits for nobody");
  assert.ok(sql.includes(`d."action" = 'register_card' AND d."state" = 'consumed'`));
  assert.ok(sql.includes(`ORDER BY c."chunkIndex"`));
  assert.ok(sql.includes(`ORDER BY w."createdAt" ASC, w."id" ASC`));
  assert.ok(sql.includes(`FROM "AmuxIdeaTrackedCheckoutEvidence" e`));
  assert.ok(sql.includes(`LEFT JOIN "AmuxIdeaTrackedCheckoutReadManifest" m`));
  assert.ok(sql.includes(`ORDER BY e."referenceOrdinal"`));
  assert.deepEqual([row.stage, row.displayKey, row.reviewPullRequests, row.submittedAt],
    ["review", "AMUX-ADM-001", [{ number: 2540, displayKey: "AMUX-ADM-002" }], "2026-10-15T00:00:00.123Z"]);
  assert.deepEqual(row.taskRows, [{ displayKey: "AMUX-ADM-002", status: "review", reviewPrNumber: 2540, merged: false }],
    "the detail lists Tasks only, never stories");
  assert.deepEqual(row.checkoutEvidence, [{ referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
    excludedCount: 2, excludedReasons: { secretPath: 1, secretContent: 1,
      nonRegular: 0, unscannableContent: 0 },
    readManifest: { fileCount: 2, digest: "b".repeat(64), bodyPurged: false } }]);
  assert.deepEqual([empty.stage, empty.displayKey, empty.taskRows], ["execution_approval", null, []]);
  assert.deepEqual(empty.checkoutEvidence, []);
});

test("a failed read is tried once more, outside a route too, except for the boundary's own deterministic refusals", () => {
  const source = read("lib/amux/ideaProgressRead.ts");
  const body = source.slice(source.indexOf("export async function readAmuxIdeaProgressForOwner"), source.indexOf("type SqlChunk"));
  assert.ok(body.includes("return attempt();"), "one more attempt");
  assert.ok(body.includes('"AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"') && body.includes('"AMUX_DB_COMMIT_CHECK_MISSING"'));
  assert.equal((body.match(/\battempt\(\)/g) ?? []).length, 2, "called twice at most");
  assert.equal(/\b(?:while|for)\s*\(/.test(body), false, "never a loop");
  assert.equal(body.includes("isAmuxDbBusyError"), false,
    "the page runs outside a route budget, where a dropped session is a plain Error and never classified busy");
});

test("a failed read logs a reason made of codes and class names only", () => {
  const log = amuxIdeaProgressFailureLog(Object.assign(new Error("SELECT secret FROM t"), {
    name: "AmuxDbBoundaryError", code: "AMUX_DB_READ_BUSY",
    cause: Object.assign(new Error("password=hunter2"), { code: "P2010", meta: { code: "25P03" } }),
  }));
  assert.deepEqual(log, { subsystem: "amux", event: "idea_progress_read_failed", name: "AmuxDbBoundaryError",
    boundaryCode: "AMUX_DB_READ_BUSY", prismaCode: "P2010", sqlState: "25P03", signal: null });
  assert.equal(JSON.stringify(log).includes("secret") || JSON.stringify(log).includes("hunter2"), false);
  assert.deepEqual(amuxIdeaProgressFailureLog("boom"), { subsystem: "amux", event: "idea_progress_read_failed",
    name: null, boundaryCode: null, prismaCode: null, sqlState: null, signal: null });
  // A session ended for idling reaches the pg client as a plain Error with no code; only its class is logged.
  const closed = amuxIdeaProgressFailureLog(new Error("Client has encountered a connection error and is not queryable: SELECT x"));
  assert.deepEqual([closed.name, closed.signal, closed.sqlState], ["Error", "connection_closed", null]);
  assert.equal(JSON.stringify(closed).includes("SELECT"), false);
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.ok(page.includes("amuxIdeaProgressFailureLog(error)"), "the page logs the reason, not the bare event");
});

test("the Ideas main follows the approved mockup: inbox on top, input beside the list, and opens a row's idea by its request id", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.match(page, /tab\.id === "ideas" && ideaReadBackAvailable && !hasRecentAdminAuthentication\(session\)\) \{\n    ideaProgress = "reauthenticate";/,
    "a stale sign-in reads nothing");
  assert.match(page, /\} else if \(tab\.id === "ideas" && ideaReadBackAvailable\) \{/, "read only for the open Ideas tab, behind its switch");
  assert.match(page, /readAmuxIdeaProgressForOwner\(session\.user\.id\)\.catch/);
  assert.equal(page.split("readAmuxIdeaProgressForOwner(").length - 1, 1, "a single server read feeds the inbox and the list");
  // Not opened: the inbox leads at full width, then the input with the list beside it.
  assert.ok(page.indexOf("<AmuxIdeaInbox") < page.indexOf("<AmuxIdeaInputPanel"));
  assert.ok(page.includes("progressRows={openedIdea ? undefined : ideaProgress}"), "the list sits beside the input only on the main view");
  // Opened: its detail and flow lead; the inbox and list follow in one panel.
  assert.ok(page.indexOf("<AmuxIdeaInputPanel") < page.indexOf("<AmuxIdeaProgressPanel"));
  assert.ok(page.includes('<AmuxIdeaInputPanel key={openRequestId ?? "new"} openRequestId={openRequestId}'));
  const panel = read("components/admin/AmuxIdeaProgressPanel.tsx");
  assert.ok(panel.includes("if (rows === null)"), "a failed read is shown, not an empty list");
  assert.match(panel, /data-testid="amux-idea-list-unavailable"/, "the list keeps its card when the read failed");
  assert.equal(/adminFetch|method:/.test(panel), false, "the list only links; it never writes");
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes("lg:grid-cols-[minmax(0,1fr)_23.75rem]"), "two columns from the desktop width, one on a phone");
  assert.equal(input.includes("{messages.step}") || input.includes("{messages.description}"), false,
    "the old panel header (eyebrow, large title, long description) is gone; the console page has its own h1");
  assert.ok(input.indexOf("<AmuxIdeaList") < input.indexOf("<AmuxInitialPlanPanel"), "the flow panels follow below the two columns");
  assert.ok(input.includes("data-testid=\"amux-idea-settings-footnote\""), "the footnote points to Analysis settings");
  const recover = input.slice(input.indexOf("const recoverFromReceipts"), input.indexOf("useEffect(() => {", input.indexOf("const recoverFromReceipts")));
  assert.ok(recover.indexOf('recovered.kind === "pending"') < recover.indexOf("openRequestId &&"),
    "an unresolved request always comes before the idea a row opened");
});

test("the Ideas components are dark-only: the console is always dark, so no light surface or dark: pair", () => {
  // AdminConsoleShell draws bg-zinc-950 text-zinc-100 whatever the product theme is. A `dark:` variant
  // follows the product theme instead, so a light theme gave white cards under near-white text.
  const files = ["AmuxIdeaInputPanel", "AmuxIdeaRequestStatusCard", "AmuxIdeaProgressPanel", "AmuxIdeaDetailSummary",
    "AmuxFrontierModelsPanel", "AmuxInitialPlanPanel", "AmuxIdeaPlanApprovalPanel", "AmuxIdeaAnalysisResultPanel",
    "AmuxFrontierModelRegistrationPanel", "AmuxIdeaCardLinkPanel", "AmuxIdeaDerivationPanel", "AmuxIdeaNodeRegistrationPanel",
    "AmuxIdeaNodeSelectionPanel", "AmuxIdeaResolutionPanel", "AmuxIdeaStoryRegistrationPanel", "AmuxIdeaUnitRejectionPanel"];
  const hue = "(?:zinc|slate|gray|neutral|stone|red|amber|yellow|orange|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
  for (const name of files) {
    const source = read(`components/admin/${name}.tsx`);
    assert.equal(/\bdark:/.test(source), false, `${name} has a dark: variant`);
    assert.equal(new RegExp(`\\b(?:bg-white|bg-zinc-(?:50|100|200)|bg-${hue}-(?:50|100))(?![\\w/-])`).test(source), false,
      `${name} draws a light surface`);
    assert.equal(new RegExp(`\\btext-${hue}-(?:600|700|800|900|950)\\b`).test(source), false,
      `${name} sets a dark text colour on the dark console`);
  }
});

test("the exact transfer payload is readable: an explicit text colour on a dark surface", () => {
  const source = read("components/admin/AmuxFrontierModelsPanel.tsx");
  const pre = /<pre className="([^"]+)">/.exec(source);
  assert.ok(pre, "the payload block is a <pre>");
  const classes = pre[1].split(/\s+/);
  assert.ok(classes.includes("text-zinc-100"), "an explicit light text colour");
  assert.ok(classes.includes("bg-zinc-900"), "a dark surface");
  assert.ok(classes.includes("border-zinc-800"));
  assert.equal(classes.some((name) => /^(?:dark:)?bg-zinc-(?:50|100)$/.test(name)), false, "the empty light box is gone");
  assert.ok(source.includes("{preview.value.prompt}"));
  // Every other code block of the Ideas flow sets its own colour too.
  for (const file of ["AmuxIdeaInputPanel", "AmuxIdeaAnalysisResultPanel"]) {
    const text = read(`components/admin/${file}.tsx`);
    for (const block of text.matchAll(/<(?:pre|code) className="([^"]*bg-zinc-900[^"]*)"/g)) {
      assert.ok(block[1].split(/\s+/).includes("text-zinc-100"), `${file}: ${block[1]}`);
    }
  }
});

test("the list asks before it leaves an unsaved draft", () => {
  const panel = read("components/admin/AmuxIdeaProgressPanel.tsx");
  assert.equal(panel.split("onClick={keepDraft}").length - 1, 2, "both links to an idea ask first");
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes('const draftAtRisk = hasUnsavedInput && (submission.kind === "idle" || submission.kind === "refused");'));
  assert.ok(input.includes("setAmuxIdeaUnsavedDraft(draftAtRisk)"));
});

test("an opened idea leads with its read-only detail, and the list follows its flow", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.ok(page.indexOf("<AmuxIdeaDetailSummary") < page.indexOf("<AmuxIdeaInputPanel"));
  assert.ok(page.includes("ideaProgress.find((row) => row.requestId === openRequestId)"));
  const detail = read("components/admin/AmuxIdeaDetailSummary.tsx");
  assert.equal(/adminFetch|method:|<button/.test(detail), false, "the detail only reads and links");
  assert.ok(detail.includes("AMUX_IDEA_PROGRESS_STAGES.map"), "all six steps are drawn");
  assert.ok(detail.includes("amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)"), "leaving a draft asks first");
});
