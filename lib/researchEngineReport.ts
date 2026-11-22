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
 * A shareable projection: every block, conflict and table citing a
 * private-derived claim is removed, and private sources leave the
 * bibliography. The result carries no private-derived content by construction.
 */
export function redactReportForPublic(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, removedNote: string) {
  const isPrivate = (keys: readonly string[]) => keys.some((key) => {
    const claim = claims.get(key);
    return !claim || claim.privateDerived || claim.evidence.some((evidence) => evidence.sourceKey.startsWith("P"));
  });
  let removed = 0;
  const sections = document.sections.map((section) => {
    const blocks = section.blocks.filter((block) => { const keep = !isPrivate(block.claimKeys); if (!keep) removed += 1; return keep; });
    return { ...section, blocks, status: blocks.length ? section.status : "missing" as const };
  });
  const conflicts = document.conflicts.filter((conflict) => !isPrivate(conflict.claimKeys));
  const publicClaims = new Map([...claims].filter(([, claim]) => !claim.privateDerived));
  const draft = { ...document, sections, conflicts, limitations: removed ? [...document.limitations, removedNote] : document.limitations };
  const bibliography = document.bibliography.filter((entry) => !entry.private)
    .filter((entry) => [...publicClaims.values()].some((claim) => claim.evidence.some((evidence) => evidence.sourceKey === entry.sourceKey)))
    .map((entry, index) => ({ ...entry, n: index + 1 }));
  return { document: { ...draft, bibliography }, removedBlocks: removed };
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
