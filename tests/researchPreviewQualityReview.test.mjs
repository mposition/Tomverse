import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildResearchEvaluationManifest } from "../lib/researchPreviewEvaluation.ts";
import { createResearchEvidenceRegistry, validateAndRenderResearchReport } from "../lib/researchPreviewReport.ts";
import { buildResearchQualityReview, researchReviewContentDigest, researchReviewCriteriaDigest, researchReviewVerdictTemplate,
  renderResearchQualityReviewMarkdown } from "../lib/researchPreviewQualityReview.ts";
import { loadResearchReviewBundle, runResearchReviewCli } from "../scripts/research-preview-review.mjs";

const fixtures = resolve("tests/fixtures/research-preview-review");
const capture = JSON.parse(readFileSync(join(fixtures, "report-capture.json"), "utf8"));
const fixtureJournal = readFileSync(join(fixtures, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const generatedAt = "2026-11-23T00:00:00.000Z";
const clone = value => structuredClone(value);
const render = (report, sources = capture.allowedSources) => validateAndRenderResearchReport({ report, registry: createResearchEvidenceRegistry(sources),
  allowedSourceIds: sources.map(source => source.sourceId), locale: "en", allowedEvidenceSources: sources });
const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
const manifestFor = (caseIds, modelIds, currentDate = "2026-11-15") => buildResearchEvaluationManifest({ sourceDigest: "b".repeat(64), currentDate,
  expiresAt: "2026-11-16T00:00:00Z", maxTotalMicroUsd: 10_000_000, caseIds, modelIds });
/** Builds a v2-style journal: reserved, then per-run events in order. */
function journal(manifest, events) {
  let second = 0;
  const at = () => new Date(Date.parse("2026-11-15T03:00:00Z") + 1000 * second++).toISOString();
  return [{ kind: "reserved", at: at(), manifest }, ...events.map(event => {
    const entry = event.runKey ? manifest.cases.find(item => item.runKey === event.runKey) : null;
    return { at: at(), ...(entry ? { modelId: entry.modelId, ...(event.kind !== "checkpoint" ? { caseId: entry.id } : {}) } : {}), ...event };
  })];
}
const submit = (runKey, report, extra = {}) => {
  const rendered = render(report);
  assert.equal(rendered.ok, true);
  return [
    { kind: "dispatch_intent", runKey, generation: 1 },
    { kind: "checkpoint", runKey, completedSteps: 1, usage: usage(800, 40), searchCount: 2, pageReadCount: 0, pageReads: [] },
    { kind: "dispatch_intent", runKey, generation: 2 },
    { kind: "terminal", runKey, stopReason: "report_submitted", reportRejection: null, outcome: rendered.outcome,
      citedSources: rendered.citedSources.map(source => ({ sourceId: source.sourceId, url: source.url, ...(source.pageRead ? { pageRead: source.pageRead } : {}) })),
      content: rendered.content, latencyMs: 5000, usage: usage(2000, 300), measuredCostMicroUsd: 14000, qualityVerdict: "manual_review_pending", ...extra },
  ];
};
const run = (review, prefix) => review.runs.find(entry => entry.identity.includes(prefix));
const group = (review, origin, caseId, modelId) => review.groups.find(entry => entry.origin === origin && entry.caseId === caseId && entry.modelId === modelId);
/** Fills a template entry: every claim/requirement gets the same rating unless overridden. */
function verdictFor(review, identity, { provenance = "human", claim = "supported", claims = {}, requirement = "met", expectedOutcome = "complete" } = {}) {
  const entry = researchReviewVerdictTemplate(review).entries.find(item => item.runIdentity === identity);
  assert.ok(entry, `no template entry for ${identity}`);
  return { version: 1, provenance, reviewer: "Offline fixture reviewer", reviewedAt: "2026-11-23", entries: [{ ...entry, expectedOutcome,
    requirements: entry.requirements.map(item => ({ ...item, verdict: requirement, reason: "fixture" })),
    claims: entry.claims.map(item => ({ ...item, verdict: claims[item.claimId]?.verdict ?? claim, reason: claims[item.claimId]?.reason ?? "fixture",
      ...(claims[item.claimId]?.contradicted ? { contradicted: true } : {}),
      evidence: claims[item.claimId]?.evidence ?? [{ url: "https://www.rfc-editor.org/rfc/rfc1149.html", location: "header", checkedAt: "2026-11-23", basis: "current_official_page" }] })) }] };
}

test("CLI runs offline end to end on the small synthetic fixture and imports a filled template", t => {
  const out = mkdtempSync(join(tmpdir(), "research-review-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const first = runResearchReviewCli([`--bundle=${join(fixtures, "bundle.json")}`, `--out-dir=${out}`, `--now=${generatedAt}`]);
  const template = JSON.parse(readFileSync(first.files.template, "utf8"));
  assert.match(readFileSync(first.files.markdown, "utf8"), /Operating completion rate: \*\*not_measured\*\*/);
  const argon = run(first.review, "gemini-4-argon:official-compact-original");
  assert.equal(argon.execution.status, "report_submitted");
  assert.equal(argon.replay.matchesArchive, true);
  assert.equal(argon.requirements.find(item => item.id === "original_read_before_report").verdict, "met");
  assert.equal(argon.substantive, "pending");
  assert.ok(argon.claims.every(claim => claim.review.verdict === "not checked" && claim.reviewSource === "manual_review_pending"));
  assert.equal(run(first.review, "gpt-6-luna:official-compact-original").execution.status, "attention");
  const preview = first.review.runs.find(entry => entry.origin === "preview_only");
  assert.equal(preview.execution.status, "not_run"); assert.equal(preview.claims.length, 0);
  // Approval lines never reach the projection, and no local path enters the outputs.
  assert.doesNotMatch(readFileSync(first.files.json, "utf8"), /approvedBy|[A-Z]:\\\\|fixtures\/research-preview-review/);

  const entry = template.entries.find(item => item.runIdentity === argon.identity);
  const filled = { ...template, provenance: "synthetic", reviewer: "Offline fixture reviewer", entries: [{ ...entry, expectedOutcome: "complete",
    requirements: entry.requirements.map(item => ({ ...item, verdict: "met" })),
    claims: entry.claims.map(item => ({ ...item, verdict: "supported",
      evidence: [{ url: "https://www.rfc-editor.org/rfc/rfc1149.html", location: "header", checkedAt: "2026-11-23", basis: "model_seen_page" }] })) }] };
  const verdictPath = join(out, "verdicts.json");
  writeFileSync(verdictPath, JSON.stringify(filled));
  const second = runResearchReviewCli([`--bundle=${join(fixtures, "bundle.json")}`, `--out-dir=${out}`, `--now=${generatedAt}`, `--verdicts=${verdictPath}`]);
  const reviewed = run(second.review, "gemini-4-argon:official-compact-original");
  assert.deepEqual(second.review.rejectedVerdicts, []);
  assert.equal(reviewed.substantive, "complete"); assert.equal(reviewed.honesty, "accurate_complete");
  // Synthetic rows never become measurements.
  assert.equal(second.review.measuredTotals.started, 0); assert.equal(second.review.measuredTotals.substantiveComplete, 0);
});

test("a wrong RFC date on the read R1 page passes product validation but an unsupported verdict excludes substantive completion", () => {
  const base = { reportInput: capture.reportInput, allowedSources: capture.allowedSources, replay: true, caseId: "official-compact-original", modelId: "gemini-4-argon" };
  const wrong = "RFC 1149 was published on 1 April 2005.";
  const runs = [
    { ...base, origin: "synthetic", runId: "rfc-correct" },
    { ...base, origin: "synthetic", runId: "rfc-wrong-date", derivedFrom: "synthetic:rfc-correct", statementPatches: [{ claimId: "F1S2", text: wrong }] },
  ];
  const sheet = buildResearchQualityReview({ runs, generatedAt });
  const wrongRun = run(sheet, "rfc-wrong-date");
  assert.equal(wrongRun.replay.ok, true); assert.equal(wrongRun.replay.outcome, "complete");
  assert.equal(wrongRun.claims.find(claim => claim.claimId === "F1S2").text, wrong);
  assert.equal(wrongRun.claims.find(claim => claim.claimId === "F1S2").sources[0].modelSaw, "page_text");
  const verdicts = [
    verdictFor(sheet, "synthetic:rfc-correct", { provenance: "synthetic" }),
    verdictFor(sheet, "synthetic:rfc-wrong-date", { provenance: "synthetic", claims: { F1S2: { verdict: "unsupported", contradicted: true,
      reason: "Original header reads 1 April 1990", evidence: [{ sourceId: "R1", url: "https://www.rfc-editor.org/rfc/rfc1149.html", location: "header",
        quote: "1 April 1990", checkedAt: "2026-11-23", basis: "model_seen_page" }] } } }),
  ];
  const review = buildResearchQualityReview({ runs, verdictFiles: verdicts, generatedAt });
  assert.deepEqual(review.rejectedVerdicts, []);
  // Without a journal the read timing is unknown, so even the correct copy stays pending rather than complete.
  const correct = run(review, "rfc-correct");
  assert.equal(correct.substantive, "pending");
  assert.equal(correct.requirements.find(item => item.id === "original_read_before_report").verdict, "not_checked");
  const reviewed = run(review, "rfc-wrong-date");
  assert.ok(reviewed.requirements.filter(item => item.source !== "machine_from_run_record").every(item => item.verdict === "met"));
  assert.equal(reviewed.substantive, "not_complete"); assert.equal(reviewed.honesty, "overclaim");
  const synthetic = group(review, "synthetic", "official-compact-original", "gemini-4-argon");
  assert.equal(synthetic.substantiveComplete, 0); assert.equal(synthetic.substantiveNotComplete, 1); assert.equal(synthetic.substantivePending, 1);
  assert.equal(synthetic.overclaim, 1); assert.equal(synthetic.contradicted, 1);
  assert.equal(review.measuredTotals.substantiveComplete, 0);
  assert.match(renderResearchQualityReviewMarkdown(review), /unsupported \(contradicted\)/);
});

test("funnel keeps unstarted, attention, refused, partial and honest insufficient runs in separate rows", () => {
  const mixed = manifestFor(["official-runtime-support"], ["gemini-4-argon", "gpt-6-luna"]);
  const [argon] = mixed.cases;
  const refusedManifest = manifestFor(["official-compact-original"], ["gpt-6-luna"]);
  const partialManifest = manifestFor(["official-runtime-support"], ["gemini-3-1-pro"]);
  const insufficientManifest = manifestFor(["official-web-accessibility"], ["gemini-4-argon"]);
  const partial = { ...clone(capture.reportInput), status: "partial" };
  const insufficient = { ...clone(capture.reportInput), status: "insufficient_evidence" };
  const runs = [
    { origin: "historical_cli", journalLines: journal(mixed, [
      { kind: "dispatch_intent", runKey: argon.runKey, generation: 1 },
      { kind: "checkpoint", runKey: argon.runKey, completedSteps: 1, usage: usage(820, 45), searchCount: 2, pageReadCount: 0 },
      { kind: "dispatch_intent", runKey: argon.runKey, generation: 2 },
      { kind: "attention", reason: "dispatch_or_usage_outcome_may_be_unknown_no_automatic_retry" }]) },
    { origin: "historical_cli", journalLines: journal(refusedManifest, [
      { kind: "dispatch_intent", runKey: refusedManifest.cases[0].runKey, generation: 1 },
      { kind: "checkpoint", runKey: refusedManifest.cases[0].runKey, completedSteps: 1, usage: usage(864, 66), searchCount: 2, pageReadCount: 0, pageReads: [] },
      { kind: "dispatch_intent", runKey: refusedManifest.cases[0].runKey, generation: 2 },
      { kind: "terminal", runKey: refusedManifest.cases[0].runKey, stopReason: "invalid_report", outcome: null, citedSources: [], latencyMs: 30000,
        usage: usage(7582, 1550), measuredCostMicroUsd: 71328, qualityVerdict: "manual_review_pending" },
      { kind: "evaluation_completed", modelCalls: 2, rerankCalls: 0, measuredTotalMicroUsd: 71328 }]) },
    { origin: "historical_cli", runKey: partialManifest.cases[0].runKey, reportInput: partial, allowedSources: capture.allowedSources, replay: true,
      journalLines: journal(partialManifest, submit(partialManifest.cases[0].runKey, partial)) },
    { origin: "historical_cli", runKey: insufficientManifest.cases[0].runKey, reportInput: insufficient, allowedSources: capture.allowedSources, replay: true,
      journalLines: journal(insufficientManifest, submit(insufficientManifest.cases[0].runKey, insufficient)) },
  ];
  const sheet = buildResearchQualityReview({ runs, generatedAt });
  const insufficientId = `manifest:${insufficientManifest.manifestDigest}:${insufficientManifest.cases[0].runKey}`;
  const partialId = `manifest:${partialManifest.manifestDigest}:${partialManifest.cases[0].runKey}`;
  const review = buildResearchQualityReview({ runs, generatedAt, verdictFiles: [
    verdictFor(sheet, insufficientId, { expectedOutcome: "insufficient_evidence", requirement: "not_checked", claim: "not checked" }),
    verdictFor(sheet, partialId, { expectedOutcome: "complete", requirement: "not_checked", claim: "not checked" }),
  ] });
  assert.deepEqual(review.rejectedVerdicts, []);
  const attention = group(review, "historical_cli", "official-runtime-support", "gemini-4-argon");
  assert.equal(attention.attention, 1); assert.equal(attention.submitted, 0); assert.equal(attention.unknownCostRuns, 1);
  assert.equal(attention.knownCostRuns, 1, "the confirmed first checkpoint is priced at frozen rates");
  assert.equal(attention.modelAttempts, 2); assert.equal(attention.modelCompleted, 1);
  const unstarted = group(review, "historical_cli", "official-runtime-support", "gpt-6-luna");
  assert.equal(unstarted.planned, 1); assert.equal(unstarted.notStarted, 1); assert.equal(unstarted.started, 0);
  const refused = group(review, "historical_cli", "official-compact-original", "gpt-6-luna");
  assert.equal(refused.submitFailed, 1); assert.equal(refused.submitted, 0);
  assert.equal(run(review, refusedManifest.manifestDigest).honesty, "not_applicable");
  const honest = group(review, "historical_cli", "official-web-accessibility", "gemini-4-argon");
  assert.equal(honest.submitted, 1); assert.equal(honest.honestShortfall, 1); assert.equal(honest.substantiveComplete, 0); assert.equal(honest.accurateComplete, 0);
  const under = group(review, "historical_cli", "official-runtime-support", "gemini-3-1-pro");
  assert.equal(under.submitted, 1); assert.equal(under.underclaim, 1);
  assert.equal(review.measuredTotals.started, 4); assert.equal(review.measuredTotals.submitted, 2);
  assert.equal(review.operatingCompletionRate.status, "not_measured");
});

test("truncated reads and display numbers stay distinct from original R IDs; a display-number verdict is refused", () => {
  const sources = clone(capture.allowedSources);
  sources[0].pageRead = { ...sources[0].pageRead, truncated: true };
  const review0 = buildResearchQualityReview({ runs: [{ origin: "synthetic", runId: "truncated", caseId: "official-compact-original", modelId: "gemini-4-argon",
    reportInput: capture.reportInput, allowedSources: sources, replay: true }], generatedAt });
  const truncated = review0.runs[0];
  assert.equal(truncated.replay.ok, true);
  const f1s2 = truncated.claims.find(claim => claim.claimId === "F1S2");
  assert.deepEqual(f1s2.sourceIds, ["R1"]); assert.deepEqual(f1s2.displayNumbers, [2]);
  assert.equal(f1s2.sources[0].modelSaw, "page_text_truncated");
  assert.equal(truncated.sources[0].sourceId, "R3"); assert.equal(truncated.sources[0].displayNumber, 1);
  assert.equal(truncated.claims.find(claim => claim.claimId === "F2S2").sources[0].modelSaw, "page_read_failed:unsupported_content");
  const confused = verdictFor(review0, "synthetic:truncated", { provenance: "synthetic", claims: { F1S2: { verdict: "supported",
    evidence: [{ sourceId: "R2", url: "https://www.rfc-editor.org/rfc/rfc1149.html", location: "header", checkedAt: "2026-11-23", basis: "model_seen_page" }] } } });
  const review = buildResearchQualityReview({ runs: [{ origin: "synthetic", runId: "truncated", caseId: "official-compact-original", modelId: "gemini-4-argon",
    reportInput: capture.reportInput, allowedSources: sources, replay: true }], verdictFiles: [confused], generatedAt });
  assert.deepEqual(review.rejectedVerdicts.map(entry => [entry.claimId, entry.reason]), [["F1S2", "evidence_source_not_cited_by_claim"]]);
  assert.equal(review.runs[0].claims.find(claim => claim.claimId === "F1S2").review.verdict, "not checked");
  assert.equal(review.runs[0].substantive, "pending");
});

test("an old journal without outcome, cited sources or page reads loads with unknown fields and attributed manual mapping", () => {
  const manifest = manifestFor(["official-runtime-support"], ["gpt-6-luna"]);
  const runKey = manifest.cases[0].runKey;
  const content = "## Research Preview\n\n**Limited report**\n\nSynthetic old-format summary.\n\n### Dated release evidence\n\n- **Fact:** Synthetic line 26 entered LTS on 27 October. [1](<https://nodejs.org/en/blog/release/v26.13.0>) [2](<https://nodejs.org/en/about/previous-releases>)";
  const lines = journal(manifest, [
    { kind: "dispatch_intent", runKey, generation: 1 },
    { kind: "checkpoint", runKey, completedSteps: 1, usage: usage(710, 71), searchCount: 2, pageReadCount: 0 },
    { kind: "dispatch_intent", runKey, generation: 2 },
    { kind: "checkpoint", runKey, completedSteps: 2, usage: usage(3023, 97), searchCount: 2, pageReadCount: 2 },
    { kind: "terminal", runKey, stopReason: "report_submitted", latencyMs: 12823, usage: usage(3023, 97), measuredCostMicroUsd: 11769, qualityVerdict: "manual_review_pending", content },
  ]);
  const base = { origin: "historical_cli", runKey, journalLines: lines };
  const bare = buildResearchQualityReview({ runs: [base], generatedAt }).runs[0];
  assert.equal(bare.execution.status, "report_submitted");
  assert.equal(bare.declaredOutcome.value, "unknown"); assert.equal(bare.reportHeaderOutcome, "partial");
  assert.equal(bare.execution.pageReads.succeeded, null); assert.equal(bare.citedSourcesSource, "unknown");
  const digest = researchReviewContentDigest(content);
  const mapped = buildResearchQualityReview({ runs: [{ ...base,
    fieldOverrides: [
      { field: "outcome", value: "partial", source: "archived_report_header", note: "Limited report label" },
      { field: "citedSources", source: "archived_sources_list+rerank_terminal", value: [
        { displayNumber: 1, sourceId: "R3", url: "https://nodejs.org/en/blog/release/v26.13.0" },
        { displayNumber: 2, sourceId: "R1", url: "https://nodejs.org/en/about/previous-releases", pageRead: { status: "unavailable", readAt: "2026-11-15T01:26:51.000Z", truncated: false, reason: "response_too_large" } }] }],
    manualClaims: { version: 1, reportDigest: digest, claims: [
      { claimId: "F1S1", section: "finding", kind: "fact", text: "Synthetic line 26 entered LTS on 27 October.", displayNumbers: [1, 2] },
      { claimId: "F1S2", section: "finding", kind: "fact", text: "This sentence is not in the report.", displayNumbers: [1] }] } }], generatedAt }).runs[0];
  assert.deepEqual(mapped.declaredOutcome, { value: "partial", source: "override:archived_report_header", note: "Limited report label" });
  assert.equal(mapped.citedSourcesSource, "override:archived_sources_list+rerank_terminal");
  assert.deepEqual(mapped.claims.map(claim => claim.claimId), ["F1S1"]);
  assert.ok(mapped.anomalies.includes("manual_claim_text_not_in_report:F1S2"));
  assert.deepEqual(mapped.claims[0].sourceIds, ["R3", "R1"]);
  assert.deepEqual(mapped.claims[0].sources.map(source => source.modelSaw), ["unknown", "page_read_failed:response_too_large"]);
});

test("re-entered journals, duplicate lines and duplicate or unknown dispatches never add runs, calls or cost", () => {
  const lines = clone(fixtureJournal);
  const baseline = buildResearchQualityReview({ runs: [{ origin: "historical_cli", journalLines: lines }], generatedAt });
  const argonKey = "gemini-4-argon:official-compact-original";
  const noisy = [...lines, lines[1], clone(lines[3]), { ...lines[1], at: "2026-11-15T02:00:01.500Z" },
    { at: "2026-11-15T02:00:12.000Z", kind: "dispatch_intent", runKey: "gemini-4-argon:not-a-case", modelId: "gemini-4-argon", caseId: "not-a-case", generation: 1 }];
  const review = buildResearchQualityReview({ runs: [{ origin: "historical_cli", journalLines: noisy }, { origin: "historical_cli", journalLines: lines }], generatedAt });
  const before = group(baseline, "historical_cli", "official-compact-original", "gemini-4-argon");
  const after = group(review, "historical_cli", "official-compact-original", "gemini-4-argon");
  for (const field of ["planned", "started", "submitted", "modelAttempts", "modelCompleted", "searchAttempts", "pageReadAttempts", "knownCostMicroUsd", "reservedMicroUsd"]) {
    assert.equal(after[field], before[field], field);
  }
  assert.equal(after.modelAttempts, 3); assert.equal(after.searchAttempts, 2, "cumulative checkpoint counters are not summed");
  assert.equal(after.knownCostMicroUsd, 68400);
  const argon = run(review, argonKey);
  assert.ok(argon.anomalies.some(entry => entry.startsWith("duplicate_journal_lines")));
  assert.ok(argon.anomalies.includes(`duplicate_dispatch_intent:${argonKey}:1`));
  assert.ok(argon.anomalies.includes("unknown_dispatch:dispatch_intent:gemini-4-argon:not-a-case"));
  assert.equal(review.runs.length, 2);
  assert.deepEqual(review.anomalies.filter(entry => entry.startsWith("duplicate_input_ignored")).length, 2);
  assert.equal(run(review, "gpt-6-luna:official-compact-original").execution.status, "attention", "attention follows timestamps, not file order");
});

test("verdicts bound to another run, a changed report, claim, evidence or criteria are refused rather than carried over", () => {
  const runs = [{ origin: "historical_cli", journalLines: fixtureJournal, runKey: "gemini-4-argon:official-compact-original",
    reportInput: capture.reportInput, allowedSources: capture.allowedSources, replay: true }];
  const sheet = buildResearchQualityReview({ runs, generatedAt });
  const identity = run(sheet, "gemini-4-argon:official-compact-original").identity;
  const good = verdictFor(sheet, identity);
  const otherRun = clone(good); otherRun.entries[0].runIdentity = "devui:another-run";
  const changedReport = clone(good); changedReport.entries[0].reportDigest = "c".repeat(64);
  const changedClaim = clone(good); changedClaim.entries[0].claims[1].claimDigest = "d".repeat(64);
  const changedEvidence = clone(good); changedEvidence.entries[0].claims[2].evidenceDigest = "e".repeat(64);
  const changedCriteria = clone(good); changedCriteria.entries[0].criteriaDigest = "0".repeat(64);
  const synthetic = clone(good); synthetic.provenance = "synthetic";
  const machine = clone(good); machine.entries[0].requirements.push({ id: "original_read_before_report", verdict: "met" });
  const refusals = file => buildResearchQualityReview({ runs, generatedAt, verdictFiles: [file] });
  for (const [file, expected] of [[otherRun, "unknown_run"], [changedReport, "report_digest_mismatch"], [changedClaim, "claim_digest_mismatch"],
    [changedEvidence, "evidence_digest_mismatch"], [changedCriteria, "criteria_digest_mismatch"], [synthetic, "synthetic_verdict_on_measured_run"],
    [machine, "machine_requirement_not_overridable"]]) assert.deepEqual(refusals(file).rejectedVerdicts.map(entry => entry.reason), [expected]);
  // A file with one stale claim still applies its correctly bound claims; the refused claim stays unchecked.
  const partly = run(refusals(changedClaim), identity);
  assert.equal(partly.claims[1].review.verdict, "not checked");
  assert.equal(partly.claims[2].review.verdict, "supported");
  // The same claim rated twice is refused the second time.
  assert.ok(buildResearchQualityReview({ runs, generatedAt, verdictFiles: [good, good] }).rejectedVerdicts.every(entry => entry.reason === "duplicate_verdict"));
  // A report edited after review gets a new digest, so the old verdict is refused.
  const editedJournal = clone(fixtureJournal);
  editedJournal.find(line => line.kind === "terminal").content += "\n";
  const edited = buildResearchQualityReview({ runs: [{ ...runs[0], journalLines: editedJournal }], generatedAt, verdictFiles: [good] });
  assert.deepEqual(edited.rejectedVerdicts.map(entry => entry.reason), ["report_digest_mismatch"]);
  assert.ok(run(edited, identity).anomalies.includes("replay_differs_from_archived_report"));
  assert.notEqual(researchReviewCriteriaDigest("official-compact-original"), researchReviewCriteriaDigest("official-runtime-support"));
});

test("a dev UI run counts one run across reloads and resumes and keeps its report separate from the CLI report", () => {
  const generation = (id, index, status = "completed") => ({ id, index, status, inputTokens: 800, outputTokens: 50, reasoningTokens: 0 });
  const content = render(capture.reportInput).content.replace("Synthetic fixture", "Synthetic UI fixture");
  const report = { content, searchMetadata: { costMetadata: { searchBackendCostMicroUsd: 10000 }, research: { version: 2, mode: "preview", outcome: "complete",
    evidenceLevel: "search_snippets_and_pages", startedAt: "2026-11-15T03:56:54.886Z", completedAt: "2026-11-15T04:02:55.119Z", stopReason: "report_submitted",
    sources: [{ sourceId: "R2", referenceNumber: 1, url: "https://www.rfc-editor.org/rfc/rfc1149.html", retrievedAt: "2026-11-15T03:56:59.765Z",
      pageRead: { status: "read", readAt: "2026-11-15T04:02:11.269Z", truncated: false, contentType: "text/html" } }] } } };
  const reservation = (status, cost) => ({ status, reservedCostMicroUsd: 4415548, settledCostMicroUsd: cost, settledInputTokens: status === "settled" ? 7886 : 0, settledOutputTokens: status === "settled" ? 1500 : 0 });
  const base = { runId: "ui-run", modelId: "gemini-4-argon", reservationCount: 1 };
  const snapshots = [
    { ...base, at: "2026-11-15T04:00:00Z", phase: "first-state", status: "checkpointed", stepCount: 1, searchCount: 2, readCount: 0, generations: [generation("g1", 1)], pageReads: [], reservation: reservation("reserved", 0), report: null },
    { ...base, at: "2026-11-15T04:01:00Z", phase: "checkpoint1-after-reload", status: "checkpointed", stepCount: 1, searchCount: 2, readCount: 0, generations: [generation("g1", 1)], pageReads: [], reservation: reservation("reserved", 0), report: null },
    { ...base, at: "2026-11-15T04:02:25Z", phase: "checkpoint2", status: "checkpointed", stepCount: 2, searchCount: 2, readCount: 2, generations: [generation("g1", 1), generation("g2", 2)],
      pageReads: [{ sourceId: "R2", url: "https://www.rfc-editor.org/rfc/rfc1149.html", status: "read", truncated: false, contentType: "text/html", characters: 3407, digest: "a".repeat(64) }], reservation: reservation("reserved", 0), report: null },
    { ...base, at: "2026-11-15T04:03:00Z", phase: "completed", status: "completed", stopReason: "report_submitted", stepCount: 3, searchCount: 2, readCount: 2,
      generations: [generation("g1", 1), generation("g2", 2), generation("g3", 3)], pageReads: [], reservation: reservation("settled", 61544), report },
    { ...base, at: "2026-11-15T04:03:38Z", phase: "completed-after-reload", status: "completed", stopReason: "report_submitted", stepCount: 3, searchCount: 2, readCount: 2,
      generations: [generation("g1", 1), generation("g2", 2), generation("g3", 3)], pageReads: [], reservation: reservation("settled", 61544), report },
  ];
  const runs = [{ origin: "historical_dev_ui", caseId: "official-compact-original", snapshots },
    { origin: "historical_cli", journalLines: fixtureJournal, runKey: "gemini-4-argon:official-compact-original", reportInput: capture.reportInput, allowedSources: capture.allowedSources, replay: true }];
  const sheet = buildResearchQualityReview({ runs, generatedAt });
  const ui = run(sheet, "devui:ui-run");
  assert.equal(ui.execution.dispatched, 3); assert.equal(ui.execution.resume.reservations, 1);
  assert.equal(ui.execution.resume.completedAfterResume, true); assert.equal(ui.execution.resume.reloadObservations, 2);
  assert.equal(ui.execution.cost.knownMicroUsd, 71544);
  assert.equal(ui.declaredOutcome.source, "stored_research_metadata");
  assert.equal(ui.sources[0].sourceId, "R2"); assert.equal(ui.sources[0].readBeforeReport, true); assert.equal(ui.sources[0].pageRead.readAt, "2026-11-15T04:02:11.269Z");
  assert.equal(ui.requirements.find(item => item.id === "original_read_before_report").verdict, "not_checked", "no structured page_text claims without a mapping");
  const uiGroup = group(sheet, "historical_dev_ui", "official-compact-original", "gemini-4-argon");
  assert.equal(uiGroup.planned, 1); assert.equal(uiGroup.started, 1); assert.equal(uiGroup.modelAttempts, 3); assert.equal(uiGroup.submitted, 1);
  // A CLI-report verdict cannot be reused for the UI report.
  const cliVerdict = verdictFor(sheet, run(sheet, "gemini-4-argon:official-compact-original").identity);
  const misapplied = clone(cliVerdict); misapplied.entries[0].runIdentity = ui.identity;
  const review = buildResearchQualityReview({ runs, generatedAt, verdictFiles: [misapplied] });
  assert.deepEqual(review.rejectedVerdicts.map(entry => entry.reason), ["report_digest_mismatch"]);
  assert.notEqual(ui.report.digest, run(sheet, "gemini-4-argon:official-compact-original").report.digest);
});

test("bundle loader marks missing files not_available, keeps the rest and drops journal approvals", () => {
  const loaded = loadResearchReviewBundle(join(fixtures, "bundle.json"));
  assert.ok(loaded.runs.every(entry => !(entry.journalLines ?? []).some(line => "approval" in line)));
  const missing = loaded.runs.find(entry => entry.label === "missing-input fixture");
  assert.equal(missing.inputStatus.renderedReport, "not_available");
  assert.equal(missing.inputStatus.journal, "available");
});
