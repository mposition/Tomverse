// Offline, read-only. Reads only the files a review bundle names; no provider, search, page reader, DB or network.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCollectionText } from "../lib/routerDevelopmentCollectorJournal.ts";
import { researchEvaluationDigest } from "../lib/researchPreviewEvaluation.ts";
import { RESEARCH_REVIEW_ORIGINS, buildResearchQualityReview, renderResearchQualityReviewMarkdown,
  researchReviewVerdictTemplate } from "../lib/researchPreviewQualityReview.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const help = "npm run research:preview:review -- --bundle=PATH --out-dir=DIR [--verdicts=PATH[,PATH]] [--now=ISO]\n" +
  "Writes review.json, review.md and verdict-template.json. Bundle paths resolve relative to the bundle file.";
const RUN_FIELDS = new Set(["origin", "label", "runId", "caseId", "modelId", "runKey", "journal", "manifest", "snapshots", "reportInput",
  "allowedSources", "renderedReport", "storedMessage", "manualClaims", "fieldOverrides", "verification", "replay", "statementPatches", "derivedFrom"]);

function jsonPointer(value, pointer) {
  if (!pointer) return value;
  return pointer.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((node, key) => node === undefined || node === null ? undefined : node[key], value);
}

/** Missing files become `not_available`; every other input still loads. */
function loader(base) {
  const read = (ref, kind, status, name) => {
    if (ref === undefined) return undefined;
    const file = typeof ref === "string" ? ref : ref?.file;
    if (typeof file !== "string") throw new Error(`Invalid ${name} reference`);
    const path = resolve(base, file);
    if (!existsSync(path)) { status[name] = "not_available"; return undefined; }
    const text = readCollectionText(path, MAX_BYTES);
    status[name] = "available";
    if (kind === "text") {
      const body = typeof ref === "object" && ref.pointer ? jsonPointer(JSON.parse(text), ref.pointer) : text.replace(/\r?\n$/, "");
      if (typeof body !== "string") { status[name] = "not_available"; return undefined; }
      return body;
    }
    if (kind === "jsonl") {
      const issues = [], lines = [];
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        try {
          // Approval records are never projected: an old approval is not evidence and must not be reused.
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") delete parsed.approval;
          lines.push(parsed);
        } catch { issues.push(`journal_line_unparseable:${index + 1}`); }
      });
      return { lines, issues };
    }
    const value = jsonPointer(JSON.parse(text), typeof ref === "object" ? ref.pointer : undefined);
    if (value === undefined) status[name] = "not_available";
    return value;
  };
  return read;
}

export function loadResearchReviewBundle(bundlePath) {
  const path = resolve(bundlePath);
  const bundle = JSON.parse(readCollectionText(path, MAX_BYTES));
  if (bundle?.version !== 1 || !Array.isArray(bundle.runs) || !bundle.runs.length) throw new Error("Invalid review bundle");
  const read = loader(dirname(path));
  const runs = bundle.runs.map((entry, index) => {
    if (!entry || !RESEARCH_REVIEW_ORIGINS.includes(entry.origin) || Object.keys(entry).some(key => !RUN_FIELDS.has(key))) throw new Error(`Invalid review bundle run ${index + 1}`);
    const inputStatus = {};
    const journal = read(entry.journal, "jsonl", inputStatus, "journal");
    const snapshots = entry.snapshots === undefined ? undefined : entry.snapshots.map((ref, n) => read(ref, "json", inputStatus, `snapshot${n + 1}`)).filter(Boolean);
    const verification = entry.verification === undefined ? undefined : entry.verification.map((item, n) => {
      const { file, pointer, ...fields } = item;
      const loaded = file ? read({ file, pointer }, "json", inputStatus, `verification${n + 1}`) : {};
      return loaded === undefined ? null : { ...loaded, ...fields };
    }).filter(Boolean);
    return { origin: entry.origin, label: entry.label, runId: entry.runId, caseId: entry.caseId, modelId: entry.modelId, runKey: entry.runKey,
      derivedFrom: entry.derivedFrom, replay: entry.replay === true, statementPatches: entry.statementPatches,
      journalLines: journal?.lines, journalIssues: journal?.issues, manifest: read(entry.manifest, "json", inputStatus, "manifest"), snapshots,
      reportInput: read(entry.reportInput, "json", inputStatus, "reportInput"), allowedSources: read(entry.allowedSources, "json", inputStatus, "allowedSources"),
      renderedReport: read(entry.renderedReport, "text", inputStatus, "renderedReport"), storedMessage: read(entry.storedMessage, "json", inputStatus, "storedMessage"),
      manualClaims: read(entry.manualClaims, "json", inputStatus, "manualClaims"),
      fieldOverrides: Array.isArray(entry.fieldOverrides) ? entry.fieldOverrides : read(entry.fieldOverrides, "json", inputStatus, "fieldOverrides"),
      verification, inputStatus };
  });
  return { runs, observedUntil: bundle.observedUntil, bundleDigest: researchEvaluationDigest(runs) };
}

export function runResearchReviewCli(args) {
  const options = new Map();
  for (const argument of args) {
    const match = /^--(bundle|out-dir|verdicts|now|help)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (match[1] === "help" ? match[2] !== undefined : !match[2])) throw new Error("Invalid review arguments");
    options.set(match[1], match[2] ?? true);
  }
  if (options.has("help")) return { help };
  if (!options.has("bundle") || !options.has("out-dir")) throw new Error("--bundle and --out-dir are required");
  const now = options.get("now") ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid --now");
  const { runs, observedUntil, bundleDigest } = loadResearchReviewBundle(options.get("bundle"));
  const verdictFiles = options.has("verdicts") ? options.get("verdicts").split(",").map(path => JSON.parse(readCollectionText(resolve(path), MAX_BYTES))) : [];
  const review = buildResearchQualityReview({ runs, verdictFiles, generatedAt: new Date(now).toISOString(), observedUntil, bundleDigest });
  const out = resolve(options.get("out-dir"));
  mkdirSync(out, { recursive: true });
  const files = { json: resolve(out, "review.json"), markdown: resolve(out, "review.md"), template: resolve(out, "verdict-template.json") };
  writeFileSync(files.json, JSON.stringify(review, null, 2) + "\n");
  writeFileSync(files.markdown, renderResearchQualityReviewMarkdown(review));
  writeFileSync(files.template, JSON.stringify(researchReviewVerdictTemplate(review), null, 2) + "\n");
  return { review, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runResearchReviewCli(process.argv.slice(2));
    if (result.help) console.log(result.help);
    else console.log(JSON.stringify({ files: result.files, runs: result.review.runs.length, refusedVerdicts: result.review.rejectedVerdicts.length,
      measuredTotals: result.review.measuredTotals }, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "Review failed"); process.exitCode = 1; }
}
