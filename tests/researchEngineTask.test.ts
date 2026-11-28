import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { ARTIFACT_LIMITS, requireArtifactFormat } from "@/lib/generatedArtifactCore";
import {
  RESEARCH_MODEL_TOOL_NAMES, RESEARCH_TASK_OUTPUTS, researchBriefSchema, researchInputManifestSchema, researchReportDocumentSchema,
} from "@/lib/researchEngineContract";
import { buildBibliography, type ReportClaim, type ReportSource } from "@/lib/researchEngineReport";
import { plannerPrompt, researcherPrompt, writerSectionPrompt, type PublicResearchContext } from "@/lib/researchEnginePrompts";
import {
  RESEARCH_TASK_FILE_FORMATS, ResearchTaskFileOverflowError, chatTaskAgentEnabled, renderResearchTaskFile, reportDocumentSpec, reportPresentationSpec,
  reportTaskWorkbookSpec,
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

const big = (sections: Array<Array<{ type: "paragraph"; text: string } | { type: "table"; caption: string; columns: string[]; rows: string[][] }>>, sourceCount = 1) => {
  const document = researchReportDocumentSchema.parse({ version: 1, title: "Large report", summary: "Summary line.",
    scope: { question: "Q", assumptions: [], note: "", currentDate: "2026-11-28" },
    sections: sections.map((blocks, index) => ({ key: `s${index + 1}`, heading: `Section ${index + 1}`, status: "written",
      blocks: blocks.map((block) => ({ ...block, claimKeys: ["C1"] })) })),
    conflicts: [], limitations: [], nextQuestions: [], criteria: [], bibliography: [] });
  document.bibliography = Array.from({ length: sourceCount }, (_, index) => ({ n: index + 1, sourceKey: index ? `W${index + 1}` : "W1", versionId: `v${index + 1}`,
    title: `Source ${index + 1}`, url: `https://example.com/${index + 1}`, private: false, readStatus: "read" as const, retrievedAt: "2026-11-23T00:00:00.000Z" }));
  return document;
};
const table = (id: number, rows = 2, columns = 2) => ({ type: "table" as const, caption: `Table ${id}`, columns: Array.from({ length: columns }, (_, c) => `T${id}C${c + 1}`),
  rows: Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => `t${id}r${r + 1}c${c + 1}`)) });
const paragraph = (id: string) => ({ type: "paragraph" as const, text: `Point ${id} with its full text kept.` });

test("a spreadsheet keeps every table: past the sheet limit the rest go one under another on the last table sheet", () => {
  for (const [count, sources] of [[9, 1], [10, 0], [25, 1]] as const) {
    const document = big([Array.from({ length: count }, (_, index) => table(index + 1))], sources);
    const workbook = reportTaskWorkbookSpec(document, claims, labels, "complete", "x.xlsx");
    assert.ok(workbook.worksheets.length <= ARTIFACT_LIMITS.maxWorksheets);
    const cells = new Set(workbook.worksheets.flatMap((sheet) => sheet.rows.flat().map(String)));
    for (let id = 1; id <= count; id += 1) for (const cell of [`t${id}r1c1`, `t${id}r2c2`]) assert.ok(cells.has(cell), `${count} tables: ${cell}`);
    const stacked = workbook.worksheets.find((sheet) => sheet.name === labels.taskSheetMoreTables);
    assert.ok(stacked, `${count} tables need the stacked sheet`);
    assert.ok(stacked.rows.some((row) => row[0] === `Section 1 · Table ${count}${sources ? " [1]" : ""}` && row[1] === `T${count}C1`), "each stacked table opens with its own header row");
  }
  // Within the limit every table keeps its own sheet, as before.
  const eight = reportTaskWorkbookSpec(big([Array.from({ length: 8 }, (_, index) => table(index + 1))]), claims, labels, "complete", "x.xlsx");
  assert.equal(eight.worksheets.filter((sheet) => /^s1-\d+$/u.test(sheet.name)).length, 8);
  assert.ok(!eight.worksheets.some((sheet) => sheet.name === labels.taskSheetMoreTables));
});

test("a deck past 100 slides is laid out denser and keeps every point in its notes; one that still cannot fit is refused", () => {
  const sections = Array.from({ length: 17 }, (_, s) => Array.from({ length: 30 }, (_, p) => paragraph(`${s + 1}.${p + 1}`)));
  const document = big(sections);
  const deck = reportPresentationSpec(document, claims, labels, "complete", "x.pptx");
  assert.ok(deck.slides.length <= ARTIFACT_LIMITS.maxSlides, String(deck.slides.length));
  const notes = deck.slides.map((slide) => slide.notes ?? "").join("\n");
  for (let s = 1; s <= 17; s += 1) for (let p = 1; p <= 30; p += 1) assert.ok(notes.includes(`Point ${s}.${p} with its full text kept. [1]`), `${s}.${p}`);
  assert.ok(deck.slides.every((slide) => (slide.bullets ?? []).length <= ARTIFACT_LIMITS.maxSlideBullets));
  // Far past what any layout holds: refused, never cut short.
  const huge = big(Array.from({ length: 30 }, (_, s) => Array.from({ length: 10 }, (_, t) => table(s * 10 + t + 1, 200))));
  assert.throws(() => reportPresentationSpec(huge, claims, labels, "complete", "x.pptx"), ResearchTaskFileOverflowError);
  assert.throws(() => renderResearchTaskFile({ output: "presentation", document: huge, claims, labels, quality: "complete" }), ResearchTaskFileOverflowError);
  assert.throws(() => reportTaskWorkbookSpec(huge, claims, labels, "complete", "x.xlsx"), ResearchTaskFileOverflowError);
});

test("a document task refuses a report with more blocks than a document holds; long source lists keep their numbers", () => {
  const huge = big(Array.from({ length: 30 }, (_, s) => Array.from({ length: 60 }, (_, t) => table(s * 60 + t + 1, 1, 1))));
  assert.throws(() => reportDocumentSpec(huge, claims, "docx", labels, "partial", "x.docx", { strict: true }), ResearchTaskFileOverflowError);
  assert.throws(() => renderResearchTaskFile({ output: "document", document: huge, claims, labels, quality: "partial" }), ResearchTaskFileOverflowError);
  // The export keeps its earlier behaviour.
  assert.equal(reportDocumentSpec(huge, claims, "docx", labels, "partial", "x.docx").blocks.length, ARTIFACT_LIMITS.maxDocumentBlocks);
  const sourced = big([[paragraph("a")]], 450);
  const spec = reportDocumentSpec(sourced, claims, "docx", labels, "partial", "x.docx", { strict: true });
  const lists = spec.blocks.filter((block) => block.type === "bullets");
  assert.deepEqual(lists.map((block) => block.type === "bullets" ? block.items.length : 0), [200, 200, 50]);
  const items = lists.flatMap((block) => block.type === "bullets" ? block.items : []);
  assert.ok(items[0]!.startsWith("[1] Source 1") && items[449]!.startsWith("[450] Source 450"));
  // A list that fits stays the numbered list the export always wrote.
  assert.ok(reportDocumentSpec(big([[paragraph("a")]], 3), claims, "docx", labels, "partial", "x.docx").blocks.some((block) => block.type === "numbers"));
});
