import type { ResearchReportDocument, ResearchSectionDraft } from "./researchEngineContract";

/**
 * Pure report mechanics for Research engine v2: what a section may cite, how a
 * report renders, and how a private-derived report is redacted for sharing.
 * Rendering is deterministic: only server-owned bibliography entries create
 * links, and model text is escaped so it cannot introduce links or markup.
 */

export type ReportClaim = {
  claimKey: string; sectionKey: string; text: string; kind: "fact" | "inference" | "uncertain";
  verification: "supported" | "partial" | "conflicting" | "unverified" | "unsupported";
  privateDerived: boolean;
  evidence: Array<{ sourceKey: string; versionId?: string; chunkId?: string; level: "text" | "snippet" }>;
};

export type ReportSource = {
  sourceKey: string; versionId: string; title: string; url?: string; private: boolean;
  readStatus: "snippet_only" | "read" | "unavailable"; retrievedAt: string; publishedAt?: string; duplicateOf?: string;
};

/** Claims a writer may cite. Unsupported claims are never cited as support. */
export const citableClaim = (claim: Pick<ReportClaim, "verification">) => claim.verification !== "unsupported";

export type SectionDraftProblem = { code: "unknown_claim" | "uncitable_claim" | "uncited_block" | "empty_table_row"; blockIndex: number; claimKey?: string };

/** Structural check fed back to the writer for a bounded repair. Says nothing about meaning. */
export function validateSectionDraft(draft: ResearchSectionDraft, claims: ReadonlyMap<string, Pick<ReportClaim, "verification">>, hasClaims: boolean): SectionDraftProblem[] {
  const problems: SectionDraftProblem[] = [];
  draft.blocks.forEach((block, blockIndex) => {
    for (const claimKey of block.claimKeys) {
      const claim = claims.get(claimKey);
      if (!claim) problems.push({ code: "unknown_claim", blockIndex, claimKey });
      else if (!citableClaim(claim)) problems.push({ code: "uncitable_claim", blockIndex, claimKey });
    }
    if (hasClaims && !block.claimKeys.length) problems.push({ code: "uncited_block", blockIndex });
    if (block.type === "table" && block.rows.some((row) => row.length !== block.columns.length)) problems.push({ code: "empty_table_row", blockIndex });
  });
  return problems;
}

export const describeSectionProblems = (problems: readonly SectionDraftProblem[]) => problems.slice(0, 12).map((problem) =>
  problem.code === "unknown_claim" ? `Block ${problem.blockIndex + 1} cites ${problem.claimKey}, which is not in the claim list.`
  : problem.code === "uncitable_claim" ? `Block ${problem.blockIndex + 1} cites ${problem.claimKey}, which verification marked unsupported; remove it or state the lack of evidence.`
  : problem.code === "uncited_block" ? `Block ${problem.blockIndex + 1} has no claimKeys; every block must cite the claims it relies on.`
  : `Table in block ${problem.blockIndex + 1} has rows whose cell count differs from its columns.`).join("\n");

/** Numbered bibliography of the sources cited by the claims a document uses. */
export function buildBibliography(document: Pick<ResearchReportDocument, "sections" | "conflicts">, claims: ReadonlyMap<string, ReportClaim>,
  sources: ReadonlyMap<string, ReportSource>): ResearchReportDocument["bibliography"] {
  const used = new Set<string>();
  for (const section of document.sections) for (const block of section.blocks) for (const key of block.claimKeys) used.add(key);
  for (const conflict of document.conflicts) for (const key of conflict.claimKeys) used.add(key);
  const order: string[] = [];
  for (const key of used) for (const evidence of claims.get(key)?.evidence ?? []) if (!order.includes(evidence.sourceKey)) order.push(evidence.sourceKey);
  return order.flatMap((sourceKey) => {
    const source = sources.get(sourceKey);
    if (!source) return [];
    return [{ n: 0, sourceKey, versionId: source.versionId, title: source.title.slice(0, 300) || sourceKey,
      ...(source.url && !source.private ? { url: source.url } : {}), private: source.private, readStatus: source.readStatus,
      retrievedAt: source.retrievedAt, ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
      ...(source.duplicateOf ? { duplicateOf: source.duplicateOf } : {}) }];
  }).map((entry, index) => ({ ...entry, n: index + 1 }));
}

/** Escapes model text so it renders as text: no autolinks, no raw HTML, no injected markup. */
export const reportText = (value: string) => value.replace(/\p{Cc}/gu, " ").replace(/[ \t]+/gu, " ").trim()
  .replace(/[:.@]/gu, "​$&")
  .replace(/[\\`*_{}[\]()<>#+!|~]/gu, (character) => `&#${character.charCodeAt(0)};`);

export type ReportLabels = {
  summary: string; scope: string; conflicts: string; limitations: string; nextQuestions: string; sources: string;
  criteria: string; met: string; notMet: string; missingSection: string; privateSource: string; snippetOnly: string;
  republishes: string; quality: Record<"complete" | "partial" | "insufficient_evidence", string>;
  verification: Record<ReportClaim["verification"], string>;
};

export function renderReportMarkdown(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>,
  quality: "complete" | "partial" | "insufficient_evidence", labels: ReportLabels) {
  const numberOf = new Map(document.bibliography.map((entry) => [entry.sourceKey, entry.n]));
  const cite = (claimKeys: readonly string[]) => {
    const numbers = [...new Set(claimKeys.flatMap((key) => (claims.get(key)?.evidence ?? []).map((evidence) => numberOf.get(evidence.sourceKey))
      .filter((value): value is number => value !== undefined)))].sort((a, b) => a - b);
    const flags = [...new Set(claimKeys.map((key) => claims.get(key)?.verification).filter((value) => value && value !== "supported"))]
      .map((value) => labels.verification[value as ReportClaim["verification"]]);
    return `${numbers.length ? ` ${numbers.map((n) => `[${n}]`).join("")}` : ""}${flags.length ? ` _(${flags.join(", ")})_` : ""}`;
  };
  const lines = [`# ${reportText(document.title)}`, "", `**${labels.quality[quality]}**`, "", `## ${labels.summary}`, "", reportText(document.summary), "",
    `## ${labels.scope}`, "", reportText(document.scope.note || document.scope.question)];
  for (const assumption of document.scope.assumptions) lines.push(`- ${reportText(assumption)}`);
  for (const section of document.sections) {
    lines.push("", `## ${reportText(section.heading)}`, "");
    if (section.status === "missing") { lines.push(`_${labels.missingSection}_`); continue; }
    for (const block of section.blocks) {
      if (block.type === "paragraph") lines.push(`${reportText(block.text)}${cite(block.claimKeys)}`, "");
      else {
        lines.push(`**${reportText(block.caption)}**${cite(block.claimKeys)}`, "", `| ${block.columns.map(reportText).join(" | ")} |`,
          `| ${block.columns.map(() => "---").join(" | ")} |`, ...block.rows.map((row) => `| ${row.map(reportText).join(" | ")} |`), "");
      }
    }
  }
  if (document.conflicts.length) {
    lines.push("", `## ${labels.conflicts}`, "", ...document.conflicts.map((conflict) => `- ${reportText(conflict.text)}${cite(conflict.claimKeys)}`));
  }
  if (document.criteria.length) {
    lines.push("", `## ${labels.criteria}`, "", ...document.criteria.map((criterion) => `- ${criterion.met ? labels.met : labels.notMet}: ${reportText(criterion.criterion)}`));
  }
  lines.push("", `## ${labels.limitations}`, "", ...document.limitations.map((limitation) => `- ${reportText(limitation)}`));
  if (document.nextQuestions.length) lines.push("", `## ${labels.nextQuestions}`, "", ...document.nextQuestions.map((question) => `- ${reportText(question)}`));
  if (document.bibliography.length) {
    lines.push("", `## ${labels.sources}`, "");
    for (const entry of document.bibliography) {
      const notes = [entry.private ? labels.privateSource : "", entry.readStatus === "snippet_only" ? labels.snippetOnly : "",
        entry.duplicateOf ? `${labels.republishes} [${numberOf.get(entry.duplicateOf) ?? entry.duplicateOf}]` : "",
        entry.publishedAt ? entry.publishedAt.slice(0, 10) : "", `retrieved ${entry.retrievedAt.slice(0, 10)}`].filter(Boolean).join(" · ");
      const title = reportText(entry.title);
      lines.push(`${entry.n}. ${entry.url ? `[${title}](<${entry.url.replaceAll("&", "&amp;").replaceAll(">", "%3E")}>)` : title} — ${notes}`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * A shareable projection built without any model text that could have seen
 * private material. Writers and the synthesizer received private claims, so
 * none of their prose (title, summary, scope note, paragraphs, tables,
 * conflicts, limitations, next questions, criteria) is reused. The public
 * version is assembled from: the approved public brief as title and question,
 * neutral numbered headings, and the text of
 * claims that are not private-derived and cite no private source (researchers
 * only see public context, and public claims are verified in batches that
 * contain no private claim). Each such claim becomes one cited paragraph.
 */
export function redactReportForPublic(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, input: {
  title: string; summary: string; removedNote: string;
  /** The text the user approved for public search; the only question a public version may show. */
  publicQuestion: string;
}) {
  const publicClaims = [...claims.values()].filter((claim) => !claim.privateDerived &&
    claim.evidence.length > 0 && claim.evidence.every((evidence) => !evidence.sourceKey.startsWith("P")) && citableClaim(claim));
  // Headings are neutral numbers: plan headings and keys are user-editable and may hold private text.
  const sections = document.sections.map((section, index) => {
    const own = publicClaims.filter((claim) => claim.sectionKey === section.key);
    return { key: `s${index + 1}`, heading: `§ ${index + 1}`,
      blocks: own.slice(0, 60).map((claim) => ({ type: "paragraph" as const, text: claim.text.slice(0, 4_000), claimKeys: [claim.claimKey] })),
      status: own.length ? "written" as const : "missing" as const };
  });
  const used = new Set(publicClaims.flatMap((claim) => claim.evidence.map((evidence) => evidence.sourceKey)));
  const bibliography = document.bibliography.filter((entry) => !entry.private && used.has(entry.sourceKey)).map((entry, index) => ({ ...entry, n: index + 1 }));
  const removedBlocks = document.sections.reduce((sum, section) => sum + section.blocks.length, 0);
  return {
    document: { ...document, title: input.title.slice(0, 200) || "Research", summary: input.summary,
      // Scope is rebuilt from approved public input only: no assumptions (a user plan edit could hold private text).
      scope: { question: input.publicQuestion, assumptions: [], note: "", currentDate: document.scope.currentDate }, sections, conflicts: [], limitations: [input.removedNote], nextQuestions: [], criteria: [], bibliography },
    removedBlocks,
  };
}

/**
 * A private source whose grant is gone: what was derived from it is withheld in
 * place, without a model. A model's text cannot be trusted to cite every claim it
 * used, so whatever a model wrote after reading a withheld claim goes:
 * - a section whose writer saw one (its own claims, or a claim for every
 *   section) is rebuilt from its remaining claims, one claim text per paragraph,
 *   after the removal note; other sections keep their blocks, except a block
 *   citing a withheld claim;
 * - the synthesis fields (title, summary, conflicts, scope note, limitations,
 *   next questions, criteria) and every section heading become text that does
 *   not come from the source: the user's question, the approved plan's headings
 *   (or a neutral number) and the removal note.
 * All revoked sources are handled in one pass. Applying it again to its own
 * output changes nothing. Returns null when this revision never used any of them.
 */
export function withholdRevokedSource(document: ResearchReportDocument,
  claims: ReadonlyArray<Pick<ReportClaim, "claimKey" | "sectionKey" | "text" | "verification" | "evidence">>,
  sourceKeys: readonly string[], labels: { note: string; privateSource: string; title: string; headings?: ReadonlyMap<string, string> }) {
  // Every revoked source at once: a rebuilt section must not bring back a claim withheld for another source.
  const revoked = new Set(sourceKeys);
  const affected = new Set(claims.filter((claim) => claim.evidence.some((evidence) => revoked.has(evidence.sourceKey))).map((claim) => claim.claimKey));
  if (!affected.size && !document.bibliography.some((entry) => revoked.has(entry.sourceKey))) return null;
  const rests = (keys: string[]) => keys.some((key) => affected.has(key));
  const seenEverywhere = claims.some((claim) => affected.has(claim.claimKey) && claim.sectionKey === "all");
  const sawWithheld = (sectionKey: string) => seenEverywhere || claims.some((claim) => affected.has(claim.claimKey) && claim.sectionKey === sectionKey);
  const rebuilt = (sectionKey: string) => [{ type: "paragraph" as const, text: labels.note, claimKeys: [] },
    ...claims.filter((claim) => claim.sectionKey === sectionKey && !affected.has(claim.claimKey) && citableClaim(claim))
      .slice(0, 59).map((claim) => ({ type: "paragraph" as const, text: claim.text.slice(0, 4_000), claimKeys: [claim.claimKey] }))];
  const withheld: ResearchReportDocument = {
    ...document,
    title: labels.title.slice(0, 200) || "Research",
    summary: labels.note,
    scope: { ...document.scope, note: "" },
    sections: document.sections.map((section, index) => ({ ...section,
      // A writer chooses its own heading after reading the section's claims; the plan's heading came before them.
      heading: labels.headings?.get(section.key)?.slice(0, 160) || `§ ${index + 1}`,
      ...(sawWithheld(section.key)
        ? (() => { const blocks = rebuilt(section.key); return { blocks, status: blocks.length > 1 ? "written" as const : "missing" as const }; })()
        : { blocks: section.blocks.map((block) => rests(block.claimKeys) ? { type: "paragraph" as const, text: labels.note, claimKeys: [] } : block) }) })),
    // Conflicts are written by the synthesis model, which read every claim.
    conflicts: [],
    limitations: [labels.note],
    nextQuestions: [],
    criteria: [],
    bibliography: document.bibliography.map((entry) => revoked.has(entry.sourceKey) ? { ...entry, title: labels.privateSource } : entry),
  };
  return { affected, document: withheld };
}

/** Tables from a report as CSV text (RFC 4180 quoting). */
export function reportTablesCsv(document: ResearchReportDocument) {
  const quote = (value: string) => /[",\r\n]/u.test(value) || /^[=+\-@]/u.test(value) ? `"${(/^[=+\-@]/u.test(value) ? `'${value}` : value).replaceAll("\"", "\"\"")}"` : value;
  const tables: Array<{ name: string; csv: string }> = [];
  for (const section of document.sections) section.blocks.forEach((block) => {
    if (block.type !== "table") return;
    tables.push({ name: `${section.key}-${tables.length + 1}`, csv: [block.columns, ...block.rows].map((row) => row.map(quote).join(",")).join("\r\n") });
  });
  return tables;
}
