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
  RESEARCH_REPORT_FILE_PLACEMENT, RESEARCH_TASK_FILE_FORMATS, ResearchTaskFileOverflowError, chatTaskAgentEnabled, renderResearchTaskFile, reportDocumentSpec, reportPresentationSpec,
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
  assert.deepEqual(workbook.worksheets[2]!.rows, [["1", "Public page", "https://example.com/a", "", "2026-11-23", ""]]);
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

/** Every field path of a zod schema, objects and arrays flattened, union members merged. */
const schemaPaths = (schema: unknown, prefix = ""): string[] => {
  const node = schema as { def?: { type?: string; innerType?: unknown; element?: unknown; options?: unknown[]; shape?: Record<string, unknown> }; shape?: Record<string, unknown> };
  const type = node.def?.type;
  if (type === "optional" || type === "default" || type === "nullable") return schemaPaths(node.def!.innerType, prefix);
  if (type === "array") return schemaPaths(node.def!.element, prefix);
  if (type === "union") return [...new Set((node.def!.options ?? []).flatMap((option) => schemaPaths(option, prefix)))];
  if (type === "object") return Object.entries(node.shape ?? node.def!.shape ?? {}).flatMap(([key, value]) => {
    const nested = schemaPaths(value, `${prefix}${key}.`);
    return nested.length ? nested : [`${prefix}${key}`];
  });
  return [];
};

test("the placement table names every field of the report, so a new report field fails here until it is laid out", () => {
  const paths = schemaPaths(researchReportDocumentSchema).sort();
  assert.ok(paths.includes("conflicts.text") && paths.includes("scope.note") && paths.includes("bibliography.duplicateOf"), paths.join(","));
  assert.deepEqual(Object.keys(RESEARCH_REPORT_FILE_PLACEMENT).sort(), paths);
});

test("every field of the report reaches the document, the spreadsheet and the slide deck", () => {
  const claimMap = new Map<string, ReportClaim>([
    ["C1", { claimKey: "C1", sectionKey: "s1", text: "a", kind: "fact", verification: "supported", privateDerived: false, evidence: [{ sourceKey: "W1", level: "text" }] }],
    ["C2", { claimKey: "C2", sectionKey: "s1", text: "b", kind: "fact", verification: "conflicting", privateDerived: false, evidence: [{ sourceKey: "W2", level: "text" }] }],
  ]);
  const document = researchReportDocumentSchema.parse({ version: 1, title: "TITLE-SENTINEL", summary: "SUMMARY-SENTINEL",
    scope: { question: "QUESTION-SENTINEL", assumptions: ["ASSUMPTION-SENTINEL"], note: "NOTE-SENTINEL", currentDate: "2031-02-03" },
    sections: [
      { key: "s1", heading: "HEADING-SENTINEL", status: "written", blocks: [
        { type: "paragraph", text: "PARAGRAPH-SENTINEL", claimKeys: ["C2"] },
        // Rows shorter than the header (every row has one cell of two) and a row longer than its header.
        { type: "table", caption: "CAPTION-SENTINEL", columns: ["COLUMN-SENTINEL", "SECOND-COLUMN-SENTINEL"], rows: [["CELL-SENTINEL"], ["CELL-TWO-SENTINEL"]], claimKeys: ["C1"] },
        { type: "table", caption: "WIDE-CAPTION-SENTINEL", columns: ["WIDE-COLUMN-SENTINEL"], rows: [["WIDE-CELL-SENTINEL", "EXTRA-CELL-SENTINEL"]], claimKeys: ["C1"] }] },
      { key: "s2", heading: "MISSING-HEADING-SENTINEL", status: "missing", blocks: [] },
    ],
    conflicts: [{ text: "CONFLICT-SENTINEL", claimKeys: ["C2"] }], limitations: ["LIMITATION-SENTINEL"], nextQuestions: ["NEXT-SENTINEL"],
    criteria: [{ criterion: "MET-CRITERION-SENTINEL", met: true }, { criterion: "UNMET-CRITERION-SENTINEL", met: false }],
    bibliography: [
      { n: 1, sourceKey: "W1", versionId: "v1", title: "SOURCE-ONE-SENTINEL", url: "https://example.com/one-sentinel", private: false, readStatus: "read",
        retrievedAt: "2031-01-05T00:00:00.000Z", publishedAt: "2030-12-24T00:00:00.000Z" },
      { n: 2, sourceKey: "W2", versionId: "v2", title: "SOURCE-TWO-SENTINEL", private: true, readStatus: "snippet_only",
        retrievedAt: "2031-01-06T00:00:00.000Z", duplicateOf: "W1" },
    ] });
  const r = labels.report;
  // One expected text per placed field; `satisfies` keeps the list in step with the placement table.
  const expected = {
    "title": ["TITLE-SENTINEL"], "summary": ["SUMMARY-SENTINEL"], "scope.question": ["QUESTION-SENTINEL"], "scope.note": ["NOTE-SENTINEL"],
    "scope.assumptions": ["ASSUMPTION-SENTINEL"], "scope.currentDate": ["2031-02-03"], "sections.heading": ["HEADING-SENTINEL", "MISSING-HEADING-SENTINEL"],
    "sections.status": [r.missingSection], "sections.blocks.text": ["PARAGRAPH-SENTINEL"], "sections.blocks.claimKeys": ["PARAGRAPH-SENTINEL [2] (conflicting)"],
    "sections.blocks.caption": ["CAPTION-SENTINEL", "WIDE-CAPTION-SENTINEL"],
    "sections.blocks.columns": ["COLUMN-SENTINEL", "SECOND-COLUMN-SENTINEL", "WIDE-COLUMN-SENTINEL"],
    "sections.blocks.rows": ["CELL-SENTINEL", "CELL-TWO-SENTINEL", "WIDE-CELL-SENTINEL", "EXTRA-CELL-SENTINEL"],
    "conflicts.text": ["CONFLICT-SENTINEL"], "conflicts.claimKeys": ["CONFLICT-SENTINEL [2] (conflicting)"], "limitations": ["LIMITATION-SENTINEL"],
    "nextQuestions": ["NEXT-SENTINEL"], "criteria.criterion": ["MET-CRITERION-SENTINEL", "UNMET-CRITERION-SENTINEL"],
    "criteria.met": [`${r.met}: MET-CRITERION-SENTINEL`, `${r.notMet}: UNMET-CRITERION-SENTINEL`],
    "bibliography.n": ["SOURCE-TWO-SENTINEL"], "bibliography.title": ["SOURCE-ONE-SENTINEL", "SOURCE-TWO-SENTINEL"],
    "bibliography.url": ["https://example.com/one-sentinel"], "bibliography.private": [r.privateSource], "bibliography.readStatus": [r.snippetOnly],
    "bibliography.retrievedAt": ["2031-01-05", "2031-01-06"], "bibliography.publishedAt": ["2030-12-24"], "bibliography.duplicateOf": [`${r.republishes} [1]`],
  } satisfies Partial<Record<keyof typeof RESEARCH_REPORT_FILE_PLACEMENT, string[]>>;
  const placed = Object.entries(RESEARCH_REPORT_FILE_PLACEMENT).filter(([, place]) => place !== "internal").map(([path]) => path).sort();
  assert.deepEqual(Object.keys(expected).sort(), placed, "every placed field has an expected text");
  const xmlText = (bytes: Uint8Array) => Object.entries(unzip(bytes)).filter(([name]) => name.endsWith(".xml")).map(([, part]) => strFromU8(part)).join("\n")
    .replace(/<[^>]+>/gu, "\n").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'");
  for (const output of RESEARCH_TASK_OUTPUTS) {
    const text = xmlText(renderResearchTaskFile({ output, document, claims: claimMap, labels, quality: "partial" }).bytes);
    assert.ok(text.includes(r.quality.partial), `${output}: quality`);
    for (const [path, needles] of Object.entries(expected)) for (const needle of needles) assert.ok(text.includes(needle), `${output} is missing ${path}: ${needle}`);
  }
  // Every column title is on the slide and in its notes even when no row reaches that column; empty cells stay empty.
  const deck = reportPresentationSpec(document, claimMap, labels, "partial", "x.pptx");
  const tableSlide = deck.slides.find((slide) => slide.title.startsWith("CAPTION-SENTINEL"))!;
  assert.equal(tableSlide.bullets![0], "COLUMN-SENTINEL · SECOND-COLUMN-SENTINEL");
  assert.ok(tableSlide.notes!.includes("COLUMN-SENTINEL: CELL-SENTINEL · SECOND-COLUMN-SENTINEL: "));
  // The document and the sheet get the table at its full width.
  const docTables = reportDocumentSpec(document, claimMap, "docx", labels, "partial", "x.docx", { strict: true }).blocks.flatMap((block) => block.type === "table" ? [block] : []);
  assert.deepEqual(docTables.map((block) => [block.columns, block.rows]), [
    [["COLUMN-SENTINEL", "SECOND-COLUMN-SENTINEL"], [["CELL-SENTINEL", ""], ["CELL-TWO-SENTINEL", ""]]],
    [["WIDE-COLUMN-SENTINEL", ""], [["WIDE-CELL-SENTINEL", "EXTRA-CELL-SENTINEL"]]],
  ]);
  const wideSheet = reportTaskWorkbookSpec(document, claimMap, labels, "partial", "x.xlsx").worksheets.find((entry) => entry.title === "WIDE-CAPTION-SENTINEL")!;
  assert.deepEqual([wideSheet.columns.map((column) => column.header), wideSheet.rows], [["WIDE-COLUMN-SENTINEL", "2"], [["WIDE-CELL-SENTINEL", "EXTRA-CELL-SENTINEL"]]]);
  // Source numbers: the [n] of each source, in the form each file kind shows it.
  const sheet = reportTaskWorkbookSpec(document, claimMap, labels, "partial", "x.xlsx").worksheets.find((entry) => entry.name === r.sources)!;
  assert.deepEqual(sheet.rows.map((row) => [row[0], row[1]]), [["1", "SOURCE-ONE-SENTINEL"], ["2", "SOURCE-TWO-SENTINEL"]]);
  assert.ok(reportPresentationSpec(document, claimMap, labels, "partial", "x.pptx").slides.some((slide) => (slide.bullets ?? []).some((bullet) => bullet.startsWith("[2] SOURCE-TWO-SENTINEL"))));
  const numbered = reportDocumentSpec(document, claimMap, "docx", labels, "partial", "x.docx", { strict: true }).blocks.find((block) => block.type === "numbers");
  assert.ok(numbered?.type === "numbers" && numbered.items[1]!.startsWith("SOURCE-TWO-SENTINEL"), "the docx list is numbered in [n] order");
});

test("text longer than one value holds is split across paragraphs, rows or bullets, never cut, and anything still over a limit is content_too_large", () => {
  const document = report();
  const long = `${"A long summary sentence that keeps going. ".repeat(1_200)}END-OF-SUMMARY`;
  document.summary = long;
  for (const output of RESEARCH_TASK_OUTPUTS) {
    const file = renderResearchTaskFile({ output, document, claims, labels, quality: "partial" });
    const text = Object.entries(unzip(file.bytes)).filter(([name]) => name.endsWith(".xml")).map(([, part]) => strFromU8(part)).join("");
    assert.ok(text.includes("END-OF-SUMMARY"), `${output} keeps the end of a ${long.length}-character summary`);
  }
  const spec = reportDocumentSpec(document, claims, "docx", labels, "partial", "x.docx", { strict: true });
  const start = spec.blocks.findIndex((block) => block.type === "heading" && block.text === labels.report.summary);
  const end = spec.blocks.findIndex((block, index) => index > start && block.type === "heading");
  const summaryBlocks = spec.blocks.slice(start + 1, end);
  assert.ok(summaryBlocks.length >= 3, "split into several paragraphs");
  assert.equal(summaryBlocks.map((block) => block.type === "paragraph" ? block.text : "").join(""), long, "the pieces are the whole text");
  // A table wider than a document table holds is refused, not narrowed.
  const wide = report();
  const table = wide.sections[0]!.blocks[1]!;
  if (table.type !== "table") throw new Error("fixture");
  table.columns = Array.from({ length: ARTIFACT_LIMITS.maxDocumentTableColumns + 1 }, (_, index) => `C${index}`);
  table.rows = [table.columns.map((column) => `${column}-value`)];
  assert.throws(() => renderResearchTaskFile({ output: "document", document: wide, claims, labels, quality: "partial" }), ResearchTaskFileOverflowError);
});
