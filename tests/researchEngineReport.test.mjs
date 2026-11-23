import assert from "node:assert/strict";
import test from "node:test";
import { buildBibliography, redactReportForPublic, renderReportMarkdown, reportTablesCsv, validateSectionDraft, withholdRevokedSource } from "../lib/researchEngineReport.ts";
import { researchReportDocumentSchema, researchInputManifestSchema, researchPlanSchema } from "../lib/researchEngineContract.ts";
import { researchEngineCopy } from "../locales/researchEngine.ts";

const claims = new Map([
  ["C1", { claimKey: "C1", sectionKey: "s1", text: "Public fact", kind: "fact", verification: "supported", privateDerived: false,
    evidence: [{ sourceKey: "W1", versionId: "v1", chunkId: "c1", level: "text" }] }],
  ["C2", { claimKey: "C2", sectionKey: "s1", text: "Private fact", kind: "fact", verification: "supported", privateDerived: true,
    evidence: [{ sourceKey: "P1", versionId: "v2", chunkId: "c2", level: "text" }] }],
  ["C3", { claimKey: "C3", sectionKey: "s1", text: "Unsupported", kind: "fact", verification: "unsupported", privateDerived: false, evidence: [] }],
]);
const sources = new Map([
  ["W1", { sourceKey: "W1", versionId: "v1", title: "Public page", url: "https://example.com/a", private: false, readStatus: "read", retrievedAt: "2026-11-23T00:00:00.000Z" }],
  ["P1", { sourceKey: "P1", versionId: "v2", title: "my-private-file.pdf", private: true, readStatus: "read", retrievedAt: "2026-11-23T00:00:00.000Z" }],
]);
const doc = () => researchReportDocumentSchema.parse({ version: 1, title: "Report", summary: "Summary", scope: { question: "Q", assumptions: [], note: "", currentDate: "2026-11-23" },
  sections: [{ key: "s1", heading: "Section", status: "written", blocks: [
    { type: "paragraph", text: "Public paragraph [click](javascript:alert(1)) <b>x</b>", claimKeys: ["C1"] },
    { type: "paragraph", text: "Private paragraph", claimKeys: ["C2"] },
    { type: "table", caption: "Table", columns: ["A", "B"], rows: [["=cmd()", "2"]], claimKeys: ["C1"] }] }],
  conflicts: [], limitations: ["L"], nextQuestions: [], criteria: [], bibliography: [] });

test("a section that cites an unsupported or unknown claim, or cites nothing, is sent back for repair", () => {
  const draft = { heading: "H", blocks: [{ type: "paragraph", text: "x", claimKeys: ["C3"] }, { type: "paragraph", text: "y", claimKeys: ["C9"] }, { type: "paragraph", text: "z", claimKeys: [] }] };
  const codes = validateSectionDraft(draft, claims, true).map((problem) => problem.code);
  assert.deepEqual(codes, ["uncitable_claim", "unknown_claim", "uncited_block"]);
});

test("rendering escapes model text, numbers citations against the bibliography and never links a private source", () => {
  const document = doc();
  document.bibliography = buildBibliography(document, claims, sources);
  const markdown = renderReportMarkdown(document, claims, "complete", researchEngineCopy.en.report);
  assert.ok(!markdown.includes("](javascript"), "model text cannot create a link");
  assert.ok(!markdown.includes("<b>"));
  assert.ok(markdown.includes("[1]"));
  assert.ok(markdown.includes("(<https://example.com/a>)"));
  assert.ok(!markdown.includes("my-private-file.pdf]("), "private sources are never linked");
});

test("the public redaction reuses no writer or synthesizer prose and no private claim or source", () => {
  const document = doc();
  document.sections[0].heading = "Heading edited with private salary";
  document.title = "Title written after reading private notes";
  document.summary = "Summary that mentions the private salary";
  document.limitations = ["Limitation derived from the private file"];
  document.nextQuestions = ["Ask about the private salary"];
  document.bibliography = buildBibliography(document, claims, sources);
  const { document: shared } = redactReportForPublic(document, claims, { title: "User question",
    summary: "public summary note", removedNote: "removed", publicQuestion: "Public question only" });
  const json = JSON.stringify(shared);
  for (const leaked of ["Private paragraph", "Private fact", "my-private-file", "private salary", "private notes", "Public paragraph", "Limitation derived"]) {
    assert.ok(!json.includes(leaked), leaked);
  }
  assert.equal(shared.title, "User question");
  assert.equal(shared.scope.question, "Public question only");
  assert.deepEqual(shared.scope.assumptions, []);
  assert.equal(shared.sections[0].heading, "§ 1");
  assert.deepEqual(shared.sections[0].blocks.map((block) => block.claimKeys), [["C1"]], "only the public, citable claim, as its own text");
  assert.ok(shared.bibliography.every((entry) => !entry.private));
});

test("CSV export neutralises spreadsheet formulas", () => {
  const [table] = reportTablesCsv(doc());
  assert.ok(table.csv.includes("\"'=cmd()\""));
});

test("long briefs are accepted and the manifest defaults keep scope changes and revisions empty", () => {
  const question = "x".repeat(40_000);
  const manifest = researchInputManifestSchema.parse({ version: 1, brief: { question }, publicBrief: question, entries: [], profile: "standard",
    locale: "ko", currentDate: "2026-11-23" });
  assert.equal(manifest.brief.question.length, 40_000);
  assert.deepEqual(manifest.amendments, []);
  assert.equal(manifest.autoStart, false);
});

test("a plan without sub-questions or outline is rejected", () => {
  assert.equal(researchPlanSchema.safeParse({ objective: "o", assumptions: [], clarifications: [], subquestions: [], completionCriteria: ["c"], outline: [] }).success, false);
});

test("every language has the full v2 copy", () => {
  const keys = Object.keys(researchEngineCopy.en).sort();
  for (const [language, copy] of Object.entries(researchEngineCopy)) {
    assert.deepEqual(Object.keys(copy).sort(), keys, language);
    assert.deepEqual(Object.keys(copy.report.verification).sort(), Object.keys(researchEngineCopy.en.report.verification).sort());
  }
  assert.notEqual(researchEngineCopy.ko.title, researchEngineCopy.en.title);
});

test("a revoked private source withholds everything a model wrote after reading its claims, and keeps the rest", () => {
  const base = doc();
  const document = researchReportDocumentSchema.parse({ ...base, title: "Title naming the private fact", summary: "Summary mentioning the private fact",
    scope: { ...base.scope, note: "Scope note on the private fact" },
    sections: [...base.sections.map((section) => ({ ...section, heading: "Heading about the private fact" })),
      // The writer of s2 never saw C2, so its own text stays.
      { key: "s2", heading: "Second", status: "written", blocks: [{ type: "paragraph", text: "Second section prose", claimKeys: ["C1"] }] }],
    limitations: ["Limitation from the private fact"], nextQuestions: ["Next question on the private fact"],
    criteria: [{ criterion: "Criterion naming the private fact", met: true }],
    conflicts: [{ text: "Private fact disagrees with public fact", claimKeys: ["C1", "C2"] }, { text: "Public only", claimKeys: ["C1"] }] });
  document.bibliography = buildBibliography(document, claims, sources);
  const withheld = withholdRevokedSource(document, [...claims.values()], ["P1"],
    { note: "removed", privateSource: "private source", title: "User question", headings: new Map([["s1", "Plan heading"]]) });
  assert.deepEqual([...withheld.affected], ["C2"]);
  const json = JSON.stringify(withheld.document);
  // "Public paragraph" cites only the public claim, but its writer read the private one too.
  for (const leaked of ["Private paragraph", "Public paragraph", "private fact", "Private fact", "my-private-file"]) assert.ok(!json.includes(leaked), leaked);
  assert.equal(withheld.document.summary, "removed");
  assert.deepEqual(withheld.document.sections[0].blocks, [{ type: "paragraph", text: "removed", claimKeys: [] },
    { type: "paragraph", text: "Public fact", claimKeys: ["C1"] }], "the section is rebuilt from its remaining citable claims");
  assert.deepEqual(withheld.document.sections[1].blocks, [{ type: "paragraph", text: "Second section prose", claimKeys: ["C1"] }]);
  assert.deepEqual(withheld.document.conflicts, [], "conflicts are synthesis text over every claim");
  const again = withholdRevokedSource(withheld.document, [...claims.values()], ["P1"],
    { note: "removed", privateSource: "private source", title: "User question", headings: new Map([["s1", "Plan heading"]]) });
  assert.deepEqual(again.document, withheld.document, "applying it again changes nothing");
  assert.equal(withheld.document.title, "User question");
  assert.equal(withheld.document.sections[0].heading, "Plan heading", "the plan heading, written before any private claim");
  assert.equal(withheld.document.scope.note, "");
  assert.deepEqual(withheld.document.limitations, ["removed"]);
  assert.deepEqual(withheld.document.nextQuestions, []);
  assert.deepEqual(withheld.document.criteria, []);
  const noPlan = withholdRevokedSource(document, [...claims.values()], ["P1"], { note: "removed", privateSource: "private source", title: "User question" });
  assert.equal(noPlan.document.sections[0].heading, "§ 1");
  assert.equal(researchReportDocumentSchema.safeParse(withheld.document).success, true);
  assert.equal(withholdRevokedSource(document, [...claims.values()], ["P9"], { note: "removed", privateSource: "private source", title: "User question" }), null);
});

test("two revoked sources are withheld in one pass, so rebuilding for one never brings back the other's claim", () => {
  const both = new Map([...claims, ["C4", { claimKey: "C4", sectionKey: "s1", text: "Second private fact", kind: "fact", verification: "supported",
    privateDerived: true, evidence: [{ sourceKey: "P2", versionId: "v3", chunkId: "c3", level: "text" }] }]]);
  const document = doc();
  const withheld = withholdRevokedSource(document, [...both.values()], ["P1", "P2"], { note: "removed", privateSource: "private source", title: "Q" });
  assert.deepEqual([...withheld.affected].sort(), ["C2", "C4"]);
  assert.deepEqual(withheld.document.sections[0].blocks, [{ type: "paragraph", text: "removed", claimKeys: [] },
    { type: "paragraph", text: "Public fact", claimKeys: ["C1"] }]);
  const json = JSON.stringify(withheld.document);
  for (const leaked of ["Private fact", "Second private fact"]) assert.ok(!json.includes(leaked), leaked);
});

test("a rebuilt section is written when it keeps a claim paragraph and missing when only the removal note is left", () => {
  const only = new Map([["C2", claims.get("C2")]]);
  const document = researchReportDocumentSchema.parse({ ...doc(), sections: [{ key: "s1", heading: "S", status: "missing", blocks: [] }] });
  const kept = withholdRevokedSource(document, [...claims.values()], ["P1"], { note: "removed", privateSource: "private source", title: "Q" });
  assert.equal(kept.document.sections[0].status, "written", "the public claim is still there");
  const empty = withholdRevokedSource(document, [...only.values()], ["P1"], { note: "removed", privateSource: "private source", title: "Q" });
  assert.equal(empty.document.sections[0].status, "missing");
  assert.deepEqual(empty.document.sections[0].blocks, [{ type: "paragraph", text: "removed", claimKeys: [] }]);
});
