import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { requireArtifactFormat } from "@/lib/generatedArtifactCore";
import {
  RESEARCH_MODEL_TOOL_NAMES, RESEARCH_TASK_OUTPUTS, researchBriefSchema, researchInputManifestSchema, researchReportDocumentSchema,
} from "@/lib/researchEngineContract";
import { buildBibliography, type ReportClaim, type ReportSource } from "@/lib/researchEngineReport";
import { plannerPrompt, researcherPrompt, writerSectionPrompt, type PublicResearchContext } from "@/lib/researchEnginePrompts";
import {
  RESEARCH_TASK_FILE_FORMATS, chatTaskAgentEnabled, renderResearchTaskFile, reportPresentationSpec, reportTaskWorkbookSpec,
} from "@/lib/researchEngineTaskOutput";
import { researchEngineCopy } from "@/locales/researchEngine";

const labels = researchEngineCopy.en;
const claims = new Map<string, ReportClaim>([
  ["C1", { claimKey: "C1", sectionKey: "s1", text: "Fact one", kind: "fact", verification: "supported", privateDerived: false,
    evidence: [{ sourceKey: "W1", versionId: "v1", chunkId: "c1", level: "text" }] }],
]);
const sources = new Map<string, ReportSource>([
  ["W1", { sourceKey: "W1", versionId: "v1", title: "Public page", url: "https://example.com/a", private: false, readStatus: "read", retrievedAt: "2026-11-23T00:00:00.000Z" }],
]);
const report = () => {
  const document = researchReportDocumentSchema.parse({ version: 1, title: "Cafés near the station: 2026 comparison", summary: "First finding.\nSecond finding.",
    scope: { question: "Compare cafés", assumptions: [], note: "Public sources only.", currentDate: "2026-11-28" },
    sections: [
      { key: "s1", heading: "Opening hours", status: "written", blocks: [
        { type: "paragraph", text: "Most open at seven.", claimKeys: ["C1"] },
        { type: "table", caption: "Hours", columns: ["Café", "Opens"], rows: [["A", "07:00"], ["B", "08:00"]], claimKeys: ["C1"] }] },
      { key: "s2", heading: "Prices", status: "missing", blocks: [] },
    ],
    conflicts: [], limitations: ["Weekend hours were not checked."], nextQuestions: [], criteria: [], bibliography: [] });
  document.bibliography = buildBibliography(document, claims, sources);
  return document;
};
const context = (taskOutput?: (typeof RESEARCH_TASK_OUTPUTS)[number]): PublicResearchContext => ({ kind: "public", publicBrief: "Compare cafés near the station",
  brief: { deliverable: "report", searchLanguages: [], regions: [], includeDomains: [], excludeDomains: [], ...(taskOutput ? { taskOutput } : {}) },
  privateSourceCount: 0, currentDate: "2026-11-28", locale: "en", addedQuestions: [] });

test("a task brief names one of three file deliverables; anything else is refused and plain research is unchanged", () => {
  const base = { question: "Compare cafés", searchLanguages: [], regions: [], includeDomains: [], excludeDomains: [], constraints: [] };
  for (const output of RESEARCH_TASK_OUTPUTS) assert.equal(researchBriefSchema.parse({ ...base, taskOutput: output }).taskOutput, output);
  for (const output of ["email", "report", "browser", "", "DOCUMENT"]) assert.equal(researchBriefSchema.safeParse({ ...base, taskOutput: output }).success, false, output);
  assert.equal(researchBriefSchema.parse(base).taskOutput, undefined);
  const manifest = researchInputManifestSchema.parse({ version: 1, brief: { ...base, taskOutput: "spreadsheet" }, publicBrief: "Compare cafés", entries: [],
    profile: "standard", locale: "en", currentDate: "2026-11-28" });
  assert.equal(manifest.brief.taskOutput, "spreadsheet");
  assert.deepEqual(RESEARCH_TASK_FILE_FORMATS, { document: "docx", spreadsheet: "xlsx", presentation: "pptx" });
});

test("delegated tasks are off unless both switches are exactly true", () => {
  assert.equal(chatTaskAgentEnabled({}), false);
  assert.equal(chatTaskAgentEnabled({ CHAT_TASK_AGENT_ENABLED: "true" }), false);
  assert.equal(chatTaskAgentEnabled({ RESEARCH_ENGINE_ENABLED: "true" }), false);
  for (const value of ["TRUE", "1", "yes", " true", ""]) {
    assert.equal(chatTaskAgentEnabled({ RESEARCH_ENGINE_ENABLED: "true", CHAT_TASK_AGENT_ENABLED: value }), false, value);
  }
  assert.equal(chatTaskAgentEnabled({ RESEARCH_ENGINE_ENABLED: "true", CHAT_TASK_AGENT_ENABLED: "true" }), true);
});

test("the model tool list is the seven structured submissions and nothing that reaches outside", () => {
  assert.deepEqual([...RESEARCH_MODEL_TOOL_NAMES], [
    "submit_research_plan", "submit_research_turn", "submit_research_private_analysis", "submit_research_coverage",
    "submit_research_verification", "submit_research_section", "submit_research_synthesis",
  ]);
  for (const name of RESEARCH_MODEL_TOOL_NAMES) {
    assert.match(name, /^submit_research_[a-z_]+$/u);
    assert.doesNotMatch(name, /send|mail|post|publish|mcp|pay|purchase|buy|book|browser|computer|click|create_|upload|share/u, name);
  }
});

test("a task plan is steps toward the chosen file, says nothing can be sent or bought, and stays public-only", () => {
  for (const output of RESEARCH_TASK_OUTPUTS) {
    const prompt = plannerPrompt(context(output));
    assert.match(prompt.system, /task the user delegated/u);
    assert.match(prompt.system, /Nothing can be sent, posted, bought, booked, signed in to or changed anywhere/u);
    assert.match(prompt.prompt, /<task>\nCompare cafés near the station\n<\/task>/u);
    assert.match(prompt.prompt, /work steps/u);
  }
  assert.match(plannerPrompt(context("spreadsheet")).system, /every outline section becomes one table/u);
  assert.match(plannerPrompt(context("presentation")).prompt, /slide deck/u);
  const research = plannerPrompt(context());
  assert.doesNotMatch(research.system, /delegated/u);
  assert.match(research.prompt, /Research question \(public\):/u);
  // The researcher of a task sees the same public brief and nothing else typed.
  const turn = researcherPrompt(context("document"), { question: "Which cafés open early?", turn: 1, maxTurns: 4, sources: [], evidence: [],
    findings: [], openQuestions: [], remainingSearches: 5, maxReads: 6 });
  assert.match(turn.prompt, /Deliverable: a written document/u);
  const section = (taskOutput?: (typeof RESEARCH_TASK_OUTPUTS)[number]) => writerSectionPrompt({ heading: "Hours", purpose: "p", question: "q", locale: "en",
    table: false, claims: [], ...(taskOutput ? { taskOutput } : {}) }).system;
  assert.match(section("spreadsheet"), /table in a spreadsheet/u);
  assert.match(section("presentation"), /becomes slides/u);
  assert.doesNotMatch(section(), /spreadsheet|slides/u);
});

const unzip = (bytes: Uint8Array) => unzipSync(bytes);

test("each deliverable is laid out from the finished report without a model call: docx, xlsx and pptx", () => {
  const document = report();
  for (const output of RESEARCH_TASK_OUTPUTS) {
    const file = renderResearchTaskFile({ output, document, claims, labels, quality: "partial" });
    assert.equal(file.format, RESEARCH_TASK_FILE_FORMATS[output]);
    assert.equal(file.mediaType, requireArtifactFormat(file.format).mediaType);
    assert.equal(file.filename, `Cafés near the station 2026 comparison.${file.format}`);
    assert.equal(strFromU8(file.bytes.slice(0, 2)), "PK", `${output} is an OOXML package`);
  }
  const docx = unzip(renderResearchTaskFile({ output: "document", document, claims, labels, quality: "partial" }).bytes);
  const body = strFromU8(docx["word/document.xml"]!);
  assert.ok(body.includes("Opening hours") && body.includes("Most open at seven. [1]"), "sections and citations reach the document");
  assert.ok(body.includes(labels.report.missingSection), "a section the budget did not cover says so");

  const workbook = reportTaskWorkbookSpec(document, claims, labels, "partial", "x.xlsx");
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Summary", "s1-1", "Sources"]);
  assert.deepEqual(workbook.worksheets[1]!.rows, [["A", "07:00"], ["B", "08:00"]]);
  assert.deepEqual(workbook.worksheets[2]!.rows, [["1", "Public page", "https://example.com/a", "2026-11-23"]]);
  assert.ok(workbook.worksheets[0]!.rows.some((row) => row[0] === "Opening hours" && row[1] === "Most open at seven. [1]"));

  const deck = reportPresentationSpec(document, claims, labels, "partial", "x.pptx");
  assert.equal(deck.slides[0]!.layout, "title");
  assert.equal(deck.slides[0]!.title, document.title);
  const titles = deck.slides.map((slide) => slide.title);
  for (const expected of ["Summary", "Opening hours", "Hours [1]", "Prices", "Limitations", "Sources"]) assert.ok(titles.includes(expected), expected);
  assert.deepEqual(deck.slides.find((slide) => slide.title === "Summary")!.bullets, ["First finding.", "Second finding."]);
  assert.ok(deck.slides.every((slide) => (slide.bullets ?? []).length <= 6));
  const pptx = unzip(renderResearchTaskFile({ output: "presentation", document, claims, labels, quality: "partial" }).bytes);
  assert.equal(Object.keys(pptx).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length, deck.slides.length);
});

test("a long section becomes several slides and the full text stays in the speaker notes", () => {
  const document = report();
  const long = "A long point that a slide cannot show in full. ".repeat(20).trim();
  document.sections[0]!.blocks = Array.from({ length: 8 }, () => ({ type: "paragraph" as const, text: long, claimKeys: ["C1"] }));
  const deck = reportPresentationSpec(document, claims, labels, "complete", "x.pptx");
  const opening = deck.slides.filter((slide) => slide.title.startsWith("Opening hours") && slide.layout === "titleAndContent");
  assert.deepEqual(opening.map((slide) => slide.title), ["Opening hours", "Opening hours (2)"]);
  assert.ok(opening[0]!.bullets!.every((bullet) => bullet.length <= 300));
  assert.ok(opening[0]!.notes!.includes(`${long} [1]`));
});
