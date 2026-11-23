import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProfileSystemPrompt } from "../../lib/assistantProfilePrompt";
import { buildChatTurnPrelude } from "../../lib/chatTurnSystemBlocks";
import { buildMemoryContextPrompt, MEMORY_CONTEXT_PROMPT_VERSION } from "../../lib/memoryContextPrompt";
import { MEMORY_FULL_QUERY_VERSION } from "../../lib/memoryQueryPlan";
import {
  MEMORY_RETRIEVAL_ALGORITHM_VERSION, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, memoryTier, type RetrievableMemory,
} from "../../lib/memoryRetrievalScoring";
import {
  FOLLOWUP_ANSWERS_FORMAT, FOLLOWUP_CONDITIONS, FOLLOWUP_PHENOMENA, FOLLOWUP_VERDICTS_FORMAT,
  followupAnswersSchema, followupRetrievalCases, followupVerdictsSchema, loadFollowupBundle, loadFollowupJson,
  type FollowupAnswers, type FollowupBundle, type FollowupCase, type FollowupCondition, type FollowupVerdicts,
} from "./followupSchema";
import { measureProductRetrievalDetailed, rerankDocuments, RECALL_K } from "./productRetrieval";
import { QualityStop } from "./runner";
import { digest } from "./schema";
import { compareMemoryDetailed, loadMemoryScores, type MemoryEvaluationQueryMode } from "./semanticMemory";

/**
 * Offline follow-up evaluation: product retrieval per condition, the exact
 * chat messages each selection would produce, answer import, a blind sheet and
 * verdict import. Nothing here calls a provider; scores and answers come only
 * from files whose identity matches what this run computes.
 */

export const FOLLOWUP_REPORT_FORMAT = "memory-followup-report-v1";
const SEMANTIC_MODES = ["full-query", "full-query+history"] as const;
/** Primary comparison first. */
export const FOLLOWUP_PAIRS: readonly [FollowupCondition, FollowupCondition][] = [
  ["full-query", "full-query+history"], ["lexical", "full-query+history"], ["no-memory", "lexical"],
];
/** Fixed across every condition, so only the selected memories differ between them. */
const OMITTED_FROM_MESSAGES = ["assistant_profile_instructions", "profile_knowledge", "capability_blocks",
  "current_date_and_location", "attachments"] as const;

type Evidence = "local_lexical" | "provider" | "mock" | "oracle" | "unverified";
type Injected = { rank: number; id: string; tier: "core" | "relevant" | "style"; kind: string };
export type RetrievalRow = {
  caseId: string; condition: FollowupCondition; measured: boolean; notMeasuredReason: string | null;
  historyCount: number; fallback: null | "history_displaced_current_query" | "missing_scores" | "incomplete_scores";
  rerankRequest: boolean; injected: Injected[]; top5: string[];
  goldTotal: number; goldRelevantTotal: number; goldInCandidates: number; goldTop5: number; goldFull: number;
  generalInjected: number; irrelevantGeneral: string[]; distractorInjected: string[]; alwaysOn: string[];
  correctEmpty: boolean | null;
};
type ConditionRun = {
  condition: FollowupCondition; status: "measured" | "unmeasured" | "not_run" | "refused";
  evidence: Evidence | null; reason: string | null; scoresFile: string | null;
  scoreModel: string | null; rows: RetrievalRow[];
};

const rate = (n: number, d: number) => ({ n, d, value: d ? Math.round((n / d) * 1e4) / 1e4 : null,
  display: d ? `${n}/${d}` : "N/A" });
const stop = (error: unknown) => error instanceof QualityStop ? error.code : null;

function retrievalRow(testCase: FollowupCase, condition: FollowupCondition,
  selected: { memory: { id: string; kind: string }; tier: Injected["tier"] }[],
  extra: Pick<RetrievalRow, "measured" | "notMeasuredReason" | "historyCount" | "fallback">): RetrievalRow {
  const retrieval = followupRetrievalCases({ cases: [testCase] } as FollowupBundle)[0].retrieval;
  const candidates = rerankDocuments(retrieval).map(doc => doc.id);
  const gold = testCase.key.goldMemoryIds;
  const kindOf = (id: string) => testCase.pool.find(entry => entry.id === id)!.kind;
  const injected = selected.map((row, index) => ({ rank: index + 1, id: row.memory.id, tier: row.tier, kind: row.memory.kind }));
  const ids = injected.map(row => row.id);
  const general = injected.filter(row => row.tier === "relevant");
  // Gold that the selector relevance-gates; core and style are always on and never reranked.
  const goldRelevant = gold.filter(id => !["core", "style"].includes(tierOfKind(kindOf(id))));
  return {
    caseId: testCase.caseId, condition, ...extra, rerankRequest: candidates.length > 0,
    injected, top5: ids.slice(0, RECALL_K),
    goldTotal: gold.length, goldRelevantTotal: goldRelevant.length,
    goldInCandidates: goldRelevant.filter(id => candidates.includes(id)).length,
    goldTop5: gold.filter(id => ids.slice(0, RECALL_K).includes(id)).length,
    goldFull: gold.filter(id => ids.includes(id)).length,
    generalInjected: general.length,
    irrelevantGeneral: general.filter(row => !gold.includes(row.id)).map(row => row.id),
    distractorInjected: ids.filter(id => testCase.key.distractorMemoryIds.includes(id)),
    alwaysOn: injected.filter(row => row.tier !== "relevant").map(row => row.id),
    correctEmpty: goldRelevant.length === 0 ? general.length === 0 : null,
  };
}
/** The selector's own tier rule; synthetic pools have no pinned rows. */
const tierOfKind = (kind: string) => memoryTier({ kind, pinned: false } as RetrievableMemory);

type Selections = Map<string, Map<FollowupCondition, Parameters<typeof buildMemoryContextPrompt>[0]>>;

async function runConditions(bundle: FollowupBundle, scoreFiles: Partial<Record<MemoryEvaluationQueryMode, string>>) {
  const cases = followupRetrievalCases(bundle);
  const selections: Selections = new Map(bundle.cases.map(row => [row.caseId, new Map()]));
  const lexical = measureProductRetrievalDetailed(cases);
  const runs: ConditionRun[] = [{
    condition: "lexical", status: "measured", evidence: "local_lexical", reason: null, scoresFile: null, scoreModel: null,
    rows: bundle.cases.map((testCase, index) => {
      selections.get(testCase.caseId)!.set("lexical", lexical.rows[index].selection);
      return retrievalRow(testCase, "lexical", lexical.rows[index].selection.selected,
        { measured: true, notMeasuredReason: null, historyCount: 0, fallback: null });
    }),
  }];
  for (const mode of SEMANTIC_MODES) {
    const file = scoreFiles[mode];
    const base = { condition: mode, scoresFile: file ? resolve(file) : null, scoreModel: null, rows: [] };
    if (!file) {
      runs.push({ ...base, status: "not_run", evidence: null, reason: "no_scores_file" });
      continue;
    }
    let detailed: ReturnType<typeof compareMemoryDetailed>;
    try {
      detailed = compareMemoryDetailed(bundle.bundleId, cases, await loadMemoryScores(file), mode);
    } catch (error) {
      if (!stop(error)) throw error;
      // A refused file is recorded, never partly used.
      runs.push({ ...base, status: "refused", evidence: null, reason: stop(error) });
      continue;
    }
    const evidence = detailed.report.scoreEvidence;
    const measured = evidence.semanticRetrievalMeasured;
    const scored = new Set(Object.keys(detailed.report.requests).filter(caseId => detailed.usable(caseId)));
    runs.push({
      ...base, status: measured ? "measured" : "unmeasured", evidence: evidence.kind as Evidence,
      reason: measured ? null : `score_evidence_${evidence.kind}`, scoreModel: evidence.model,
      rows: bundle.cases.map((testCase, index) => {
        const row = detailed.semanticRows[index];
        selections.get(testCase.caseId)!.set(mode, row.selection);
        const rerankRequest = rerankDocuments(cases[index].retrieval).length > 0;
        const fallback = !rerankRequest ? null : !scored.has(testCase.caseId)
          ? (detailed.report.coverage.casesWithIncompleteScores.includes(testCase.caseId) ? "incomplete_scores" : "missing_scores")
          : row.historyDisplacedCurrentQuery ? "history_displaced_current_query" : null;
        // The lexical fallback for absent or partial scores is product behaviour, not a semantic measurement.
        const caseMeasured = measured && fallback !== "missing_scores" && fallback !== "incomplete_scores";
        return retrievalRow(testCase, mode, row.selection.selected, {
          measured: caseMeasured,
          notMeasuredReason: caseMeasured ? null : measured ? fallback : `score_evidence_${evidence.kind}`,
          historyCount: detailed.historyCount(testCase.caseId), fallback,
        });
      }),
    });
  }
  runs.push({ condition: "no-memory", status: "measured", evidence: null, reason: null, scoresFile: null, scoreModel: null, rows: [] });
  return { runs, selections };
}

/** The chat route's order: app rules as system, memory data as user, then the whole conversation, then this turn. */
export function followupMessages(testCase: FollowupCase,
  selection: Parameters<typeof buildMemoryContextPrompt>[0] | null) {
  const prompt = buildMemoryContextPrompt(selection ?? { selected: [] });
  const prelude = buildChatTurnPrelude({
    contextSystemPrompt: buildProfileSystemPrompt({ instructions: null, memory: prompt.rules, knowledge: null }),
    memoryData: prompt.data, blocks: { systemMessages: [], untrustedDataMessages: [] },
  });
  return [...prelude, ...testCase.conversation.map(row => ({ role: row.role, content: row.content })),
    { role: "user" as const, content: testCase.currentQuery }];
}

type AnswerRequest = { caseId: string; condition: FollowupCondition; promptVersion: string;
  messagesDigest: string; messages: ReturnType<typeof followupMessages> };

function answerRequests(bundle: FollowupBundle, runs: ConditionRun[], selections: Selections): AnswerRequest[] {
  const available = runs.filter(run => run.status !== "not_run" && run.status !== "refused").map(run => run.condition);
  return bundle.cases.flatMap(testCase => FOLLOWUP_CONDITIONS.filter(condition => available.includes(condition))
    .map(condition => {
      const messages = followupMessages(testCase, condition === "no-memory" ? null : selections.get(testCase.caseId)!.get(condition)!);
      return { caseId: testCase.caseId, condition, promptVersion: MEMORY_CONTEXT_PROMPT_VERSION,
        messagesDigest: digest(messages), messages };
    }));
}

type AcceptedAnswer = { caseId: string; condition: FollowupCondition; text: string; bindingDigest: string };
function importAnswers(bundle: FollowupBundle, requests: AnswerRequest[], answers: FollowupAnswers | null) {
  if (!answers) return { file: null, accepted: [] as AcceptedAnswer[], rejected: [] as { caseId: string; condition: string; reason: string }[] };
  if (answers.bundleId !== bundle.bundleId || answers.evalDigest !== bundle.evalDigest) {
    return { file: { refused: "answers_eval_digest_mismatch", generator: answers.generator }, accepted: [],
      rejected: answers.answers.map(row => ({ caseId: row.caseId, condition: row.condition, reason: "answers_eval_digest_mismatch" })) };
  }
  const accepted: AcceptedAnswer[] = [], rejected: { caseId: string; condition: string; reason: string }[] = [];
  for (const row of answers.answers) {
    const request = requests.find(item => item.caseId === row.caseId && item.condition === row.condition);
    const reason = !request ? "unknown_request"
      : row.promptVersion !== request.promptVersion ? "prompt_version_mismatch"
        : row.messagesDigest !== request.messagesDigest ? "messages_digest_mismatch"
          : accepted.some(item => item.caseId === row.caseId && item.condition === row.condition) ? "duplicate_answer"
            : !row.text.trim() ? "empty_answer" : null;
    if (reason) {
      rejected.push({ caseId: row.caseId, condition: row.condition, reason });
      continue;
    }
    accepted.push({ caseId: row.caseId, condition: row.condition, text: row.text,
      bindingDigest: digest({ evalDigest: bundle.evalDigest, caseId: row.caseId, condition: row.condition,
        messagesDigest: row.messagesDigest, promptVersion: row.promptVersion, generator: answers.generator }) });
  }
  return { file: { refused: null, generator: answers.generator }, accepted, rejected };
}

/** Condition and model names never appear on the sheet; equal answers share one label. */
export function blindSheet(bundle: FollowupBundle, accepted: AcceptedAnswer[]) {
  const map: Record<string, Record<string, { conditions: FollowupCondition[]; bindingDigests: string[] }>> = {};
  const items = bundle.cases.map(testCase => {
    const texts = [...new Set(accepted.filter(row => row.caseId === testCase.caseId).map(row => row.text.trim()))]
      .sort((left, right) => digest([bundle.evalDigest, testCase.caseId, left])
        .localeCompare(digest([bundle.evalDigest, testCase.caseId, right])));
    const labels = texts.map((answer, index) => ({ label: String.fromCharCode(65 + index), text: answer }));
    map[testCase.caseId] = Object.fromEntries(labels.map(({ label, text }) => {
      const rows = accepted.filter(row => row.caseId === testCase.caseId && row.text.trim() === text);
      return [label, { conditions: rows.map(row => row.condition), bindingDigests: rows.map(row => row.bindingDigest) }];
    }));
    const { key } = testCase;
    return {
      caseId: testCase.caseId, scenarioId: testCase.scenarioId, variantId: testCase.variantId, language: testCase.language,
      conversation: testCase.conversation, currentQuery: testCase.currentQuery,
      accountMemories: testCase.pool.map(entry => `(${entry.kind}) ${entry.statement}`),
      key: { expectedBehavior: key.expectedBehavior, activeProject: key.activeProject, latestCorrection: key.latestCorrection,
        requiredFacts: key.requiredFacts, acceptableVariants: key.acceptableVariants, forbiddenFacts: key.forbiddenFacts,
        notes: key.notes },
      answers: labels,
    };
  });
  const sheetDigest = digest({ bundleId: bundle.bundleId, evalDigest: bundle.evalDigest, items });
  return { sheet: { format: "memory-followup-blind-sheet-v1", bundleId: bundle.bundleId, sheetDigest, items },
    map: { sheetDigest, map } };
}

type Verdict = FollowupVerdicts["verdicts"][number];
function importVerdicts(bundle: FollowupBundle, sheet: ReturnType<typeof blindSheet>["sheet"], verdicts: FollowupVerdicts | null) {
  if (!verdicts) return { file: null, accepted: new Map<string, Verdict>(), rejected: [] as { caseId: string; label: string; reason: string }[] };
  if (verdicts.bundleId !== bundle.bundleId || verdicts.sheetDigest !== sheet.sheetDigest) {
    return { file: { refused: "verdicts_sheet_digest_mismatch", judge: verdicts.judge, frozenAt: verdicts.frozenAt },
      accepted: new Map<string, Verdict>(),
      rejected: verdicts.verdicts.map(row => ({ caseId: row.caseId, label: row.label, reason: "verdicts_sheet_digest_mismatch" })) };
  }
  const accepted = new Map<string, Verdict>(), rejected: { caseId: string; label: string; reason: string }[] = [];
  for (const row of verdicts.verdicts) {
    const item = sheet.items.find(entry => entry.caseId === row.caseId);
    const testCase = bundle.cases.find(entry => entry.caseId === row.caseId);
    const reason = !item || !item.answers.some(entry => entry.label === row.label) ? "unknown_answer_label"
      : accepted.has(`${row.caseId}/${row.label}`) ? "duplicate_verdict"
        : (row.followedLatestCorrection === null) === testCase!.key.latestCorrection ? "latest_correction_field_mismatch"
          : !row.evidence.trim() ? "evidence_required" : null;
    if (reason) rejected.push({ caseId: row.caseId, label: row.label, reason });
    else accepted.set(`${row.caseId}/${row.label}`, row);
  }
  return { file: { refused: null, judge: verdicts.judge, frozenAt: verdicts.frozenAt, verdictsDigest: digest(verdicts) },
    accepted, rejected };
}

type AnswerOutcome = { caseId: string; condition: FollowupCondition;
  status: "not_run" | "rejected" | "unjudged" | "judged"; measured: boolean; notMeasuredReason: string | null;
  label: string | null; verdict: Verdict | null };

function answerOutcomes(bundle: FollowupBundle, runs: ConditionRun[], imported: ReturnType<typeof importAnswers>,
  map: ReturnType<typeof blindSheet>["map"], verdicts: ReturnType<typeof importVerdicts>): AnswerOutcome[] {
  const generatorKind = imported.file?.generator.kind ?? null;
  return bundle.cases.flatMap(testCase => FOLLOWUP_CONDITIONS.map(condition => {
    const run = runs.find(row => row.condition === condition)!;
    const retrievalMeasured = condition === "no-memory" ? true
      : run.status === "measured" && run.rows.find(row => row.caseId === testCase.caseId)!.measured;
    const answer = imported.accepted.find(row => row.caseId === testCase.caseId && row.condition === condition);
    const rejected = imported.rejected.some(row => row.caseId === testCase.caseId && row.condition === condition);
    const label = answer ? Object.entries(map.map[testCase.caseId])
      .find(([, entry]) => entry.bindingDigests.includes(answer.bindingDigest))?.[0] ?? null : null;
    const verdict = label ? verdicts.accepted.get(`${testCase.caseId}/${label}`) ?? null : null;
    const notMeasuredReason = !answer ? null : generatorKind !== "provider" ? `answer_source_${generatorKind}`
      : !retrievalMeasured ? "retrieval_not_measured" : null;
    return { caseId: testCase.caseId, condition, label, verdict,
      status: answer ? (verdict ? "judged" : "unjudged") : rejected ? "rejected" : "not_run",
      measured: Boolean(answer) && notMeasuredReason === null, notMeasuredReason } as AnswerOutcome;
  }));
}

type Group = { name: string; cases: FollowupCase[] };
const groups = (bundle: FollowupBundle): Group[] => [
  { name: "all", cases: bundle.cases },
  ...(["ko", "en"] as const).map(language => ({ name: `language:${language}`, cases: bundle.cases.filter(row => row.language === language) })),
  ...FOLLOWUP_PHENOMENA.map(tag => ({ name: `phenomenon:${tag}`, cases: bundle.cases.filter(row => row.key.phenomena.includes(tag)) }))
    .filter(group => group.cases.length > 0),
];
const scenarioCount = (cases: FollowupCase[]) => new Set(cases.filter(row => row.independent).map(row => row.scenarioId)).size;

function retrievalMetrics(bundle: FollowupBundle, run: ConditionRun) {
  if (run.condition === "no-memory") return null;
  return Object.fromEntries(groups(bundle).map(group => {
    const ids = new Set(group.cases.map(row => row.caseId));
    const rows = run.rows.filter(row => ids.has(row.caseId) && row.measured);
    const sum = (pick: (row: RetrievalRow) => number) => rows.reduce((n, row) => n + pick(row), 0);
    const withDistractors = rows.filter(row => bundle.cases.find(item => item.caseId === row.caseId)!.key.distractorMemoryIds.length > 0);
    const emptyGold = rows.filter(row => row.correctEmpty !== null);
    return [group.name, {
      cases: group.cases.length, measuredCases: rows.length, independentScenarios: scenarioCount(group.cases),
      goldInCandidates: rate(sum(row => row.goldInCandidates), sum(row => row.goldRelevantTotal)),
      goldRecallTop5: rate(sum(row => row.goldTop5), sum(row => row.goldTotal)),
      goldRecallFull: rate(sum(row => row.goldFull), sum(row => row.goldTotal)),
      irrelevantGeneral: rate(sum(row => row.irrelevantGeneral.length), sum(row => row.generalInjected)),
      distractorInjectedCases: rate(withDistractors.filter(row => row.distractorInjected.length > 0).length, withDistractors.length),
      correctEmptySelection: rate(emptyGold.filter(row => row.correctEmpty).length, emptyGold.length),
      alwaysOnInjected: sum(row => row.alwaysOn.length),
      historyFallbacks: rows.filter(row => row.fallback === "history_displaced_current_query").length,
      notMeasured: run.rows.filter(row => ids.has(row.caseId) && !row.measured).length,
    }];
  }));
}

function answerMetrics(bundle: FollowupBundle, outcomes: AnswerOutcome[], condition: FollowupCondition) {
  return Object.fromEntries(groups(bundle).map(group => {
    const ids = new Set(group.cases.map(row => row.caseId));
    const rows = outcomes.filter(row => row.condition === condition && ids.has(row.caseId));
    const judged = rows.filter(row => row.measured && row.status === "judged");
    const keyOf = (row: AnswerOutcome) => bundle.cases.find(item => item.caseId === row.caseId)!.key;
    const count = (source: AnswerOutcome[], pick: (verdict: Verdict) => boolean) => source.filter(row => pick(row.verdict!)).length;
    const corrections = judged.filter(row => keyOf(row).latestCorrection);
    const mixing = judged.filter(row => keyOf(row).distractorMemoryIds.length > 0);
    const needClarify = judged.filter(row => keyOf(row).expectedBehavior === "clarify");
    const answerable = judged.filter(row => keyOf(row).expectedBehavior !== "clarify");
    const unavailable = judged.filter(row => keyOf(row).evidenceSource === "unavailable");
    const scenarios = [...new Set(group.cases.filter(row => row.independent).map(row => row.scenarioId))];
    const fullyJudged = scenarios.filter(id => group.cases.filter(row => row.scenarioId === id)
      .every(row => judged.some(item => item.caseId === row.caseId)));
    return [group.name, {
      correct: rate(count(judged, verdict => verdict.correct), judged.length),
      latestCorrectionFollowed: rate(count(corrections, verdict => verdict.followedLatestCorrection === true), corrections.length),
      crossProjectAssertion: rate(count(mixing, verdict => verdict.crossProjectAssertion), mixing.length),
      clarificationWhenNeeded: rate(count(needClarify, verdict => verdict.askedClarification), needClarify.length),
      unnecessaryClarification: rate(count(answerable, verdict => verdict.askedClarification), answerable.length),
      unsupportedAssertion: rate(count(judged, verdict => verdict.unsupportedAssertion), judged.length),
      unsupportedWhenUnavailable: rate(count(unavailable, verdict => verdict.unsupportedAssertion), unavailable.length),
      scenariosAllVariantsCorrect: rate(fullyJudged.filter(id => group.cases.filter(row => row.scenarioId === id)
        .every(row => judged.find(item => item.caseId === row.caseId)!.verdict!.correct)).length, fullyJudged.length),
      missing: {
        notRun: rows.filter(row => row.status === "not_run").length,
        rejected: rows.filter(row => row.status === "rejected").length,
        unjudged: rows.filter(row => row.measured && row.status === "unjudged").length,
        excludedUnmeasured: rows.filter(row => row.status !== "not_run" && row.status !== "rejected" && !row.measured).length,
      },
    }];
  }));
}

function answerQuality(imported: ReturnType<typeof importAnswers>, outcomes: AnswerOutcome[]) {
  if (!imported.file) return { status: "not_run" as const, reason: "no_answers_file" };
  if (imported.file.refused) return { status: "not_run" as const, reason: imported.file.refused };
  const measured = outcomes.filter(row => row.measured);
  if (measured.length === 0) {
    return { status: "not_run" as const, reason: imported.file.generator.kind === "provider"
      ? "no_measured_answers" : `answer_source_${imported.file.generator.kind}`,
    plumbingAnswers: imported.accepted.length };
  }
  const judged = measured.filter(row => row.status === "judged").length;
  return { status: judged === 0 ? "unjudged" as const : "judged" as const, measuredAnswers: measured.length, judged,
    unjudged: measured.length - judged };
}

function pairs(bundle: FollowupBundle, runs: ConditionRun[], outcomes: AnswerOutcome[]) {
  return FOLLOWUP_PAIRS.map(([left, right]) => {
    const tally = (judge: (caseId: string, side: FollowupCondition) => boolean | null, cases: FollowupCase[]) => {
      const counts = { bothCorrect: 0, onlyLeft: 0, onlyRight: 0, bothWrong: 0, excluded: 0, independentScenarios: 0 };
      const included = new Set<string>();
      for (const testCase of cases) {
        const a = judge(testCase.caseId, left), b = judge(testCase.caseId, right);
        if (a === null || b === null) { counts.excluded += 1; continue; }
        if (testCase.independent) included.add(testCase.scenarioId);
        if (a && b) counts.bothCorrect += 1; else if (a) counts.onlyLeft += 1; else if (b) counts.onlyRight += 1;
        else counts.bothWrong += 1;
      }
      return { ...counts, independentScenarios: included.size,
        pairedCases: counts.bothCorrect + counts.onlyLeft + counts.onlyRight + counts.bothWrong };
    };
    const retrievalRow = (caseId: string, side: FollowupCondition) =>
      runs.find(run => run.condition === side)!.rows.find(row => row.caseId === caseId);
    const goldComplete = (caseId: string, side: FollowupCondition) => {
      const row = retrievalRow(caseId, side);
      return !row || !row.measured || runs.find(run => run.condition === side)!.status !== "measured" ? null
        : row.goldFull === row.goldTotal;
    };
    const answerCorrect = (caseId: string, side: FollowupCondition) => {
      const row = outcomes.find(item => item.caseId === caseId && item.condition === side)!;
      return row.measured && row.verdict ? row.verdict.correct : null;
    };
    return { left, right,
      retrievalGoldComplete: left === "no-memory" ? null : tally(goldComplete, bundle.cases.filter(row => row.key.goldMemoryIds.length > 0)),
      answerCorrect: tally(answerCorrect, bundle.cases) };
  });
}

const git = (args: string[]) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const headCommit = () => {
  const sha = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--", "tools/memory-quality", "lib"]);
  return sha ? { sha, uncommittedToolOrLibChanges: status === null ? null : status !== "" } : null;
};

export async function runFollowupEval(options: {
  inputs: string; key: string; out: string; scoresFullQuery?: string; scoresFullQueryHistory?: string;
  answers?: string; verdicts?: string;
}) {
  const bundle = await loadFollowupBundle(options.inputs, options.key);
  const { runs, selections } = await runConditions(bundle, {
    ...(options.scoresFullQuery ? { "full-query": options.scoresFullQuery } : {}),
    ...(options.scoresFullQueryHistory ? { "full-query+history": options.scoresFullQueryHistory } : {}),
  });
  const requests = answerRequests(bundle, runs, selections);
  const answersFile = options.answers
    ? await loadFollowupJson(options.answers, followupAnswersSchema, "followup_answers_invalid") : null;
  const imported = importAnswers(bundle, requests, answersFile);
  const { sheet, map } = blindSheet(bundle, imported.accepted);
  const verdictsFile = options.verdicts
    ? await loadFollowupJson(options.verdicts, followupVerdictsSchema, "followup_verdicts_invalid") : null;
  const verdicts = importVerdicts(bundle, sheet, verdictsFile);
  const outcomes = answerOutcomes(bundle, runs, imported, map, verdicts);
  const revealed = Boolean(verdicts.file && !verdicts.file.refused);
  const report = {
    format: FOLLOWUP_REPORT_FORMAT, generatedAt: new Date().toISOString(), commit: headCommit(),
    bundle: { bundleId: bundle.bundleId, status: bundle.status, provenance: bundle.provenance,
      annotationVersion: bundle.annotationVersion, evalDigest: bundle.evalDigest,
      inputsDigest: bundle.inputsDigest, keyDigest: bundle.keyDigest,
      variants: bundle.cases.length, independentScenarios: scenarioCount(bundle.cases),
      scenariosByLanguage: { ko: bundle.scenarios.filter(row => row.language === "ko" && row.independent).length,
        en: bundle.scenarios.filter(row => row.language === "en" && row.independent).length },
      decisionGrade: bundle.status === "frozen" && bundle.provenance.independentAuthor &&
        bundle.provenance.goldReviewedBy !== null && bundle.provenance.frozenBeforeResults },
    versions: { memoryQueryPolicy: MEMORY_FULL_QUERY_VERSION, contextPrompt: MEMORY_CONTEXT_PROMPT_VERSION,
      lexicalRetrieval: MEMORY_RETRIEVAL_ALGORITHM_VERSION, semanticRetrieval: MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION },
    messages: { order: ["system: app rules (buildProfileSystemPrompt)", "user: account memory data", "conversation as authored",
      "user: current query"], omittedForEveryCondition: OMITTED_FROM_MESSAGES, searchHistoryLimit: 2 },
    conditions: runs.map(run => ({ condition: run.condition, status: run.status, evidence: run.evidence, reason: run.reason,
      scoresFile: run.scoresFile, scoreModel: run.scoreModel })),
    retrieval: Object.fromEntries(runs.filter(run => run.condition !== "no-memory")
      .map(run => [run.condition, run.status === "not_run" || run.status === "refused" ? null : retrievalMetrics(bundle, run)])),
    answers: {
      file: imported.file, accepted: imported.accepted.length, rejected: imported.rejected,
      verdicts: { file: verdicts.file, accepted: verdicts.accepted.size, rejected: verdicts.rejected },
      answerQuality: answerQuality(imported, outcomes),
      conditionsRevealed: revealed,
      // Condition-level verdicts are published only once a verdict file bound to this sheet is frozen.
      byCondition: revealed ? Object.fromEntries(FOLLOWUP_CONDITIONS.map(condition => [condition,
        answerMetrics(bundle, outcomes, condition)])) : null,
    },
    pairs: pairs(bundle, runs, revealed ? outcomes : outcomes.map(row => ({ ...row, verdict: null }))),
    cases: bundle.cases.map(testCase => ({
      caseId: testCase.caseId, scenarioId: testCase.scenarioId, language: testCase.language,
      phenomena: testCase.key.phenomena, expectedBehavior: testCase.key.expectedBehavior,
      evidenceSource: testCase.key.evidenceSource, searchHistory: testCase.searchHistory.length,
      retrieval: Object.fromEntries(runs.filter(run => run.rows.length > 0)
        .map(run => [run.condition, run.rows.find(row => row.caseId === testCase.caseId)!])),
      answers: Object.fromEntries(outcomes.filter(row => row.caseId === testCase.caseId).map(row => [row.condition, {
        status: row.status, measured: row.measured, notMeasuredReason: row.notMeasuredReason,
        ...(revealed ? { label: row.label, verdict: row.verdict } : {}),
      }])),
    })),
    paidCalls: 0 as const,
  };
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const write = (name: string, value: unknown) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
  await write("report.json", report);
  await write("answer-requests.json", { format: "memory-followup-answer-requests-v1", bundleId: bundle.bundleId,
    evalDigest: bundle.evalDigest, answersFormat: FOLLOWUP_ANSWERS_FORMAT,
    note: "Generate every answer with one model and one setting; record them in an answers file.", requests });
  await write("blind-sheet.json", sheet);
  await write("blind-map.json", map);
  await write("verdicts.template.json", { format: FOLLOWUP_VERDICTS_FORMAT, bundleId: bundle.bundleId,
    sheetDigest: sheet.sheetDigest, judge: null, frozenAt: null,
    verdicts: sheet.items.flatMap(item => item.answers.map(answer => ({ caseId: item.caseId, label: answer.label,
      correct: null, followedLatestCorrection: null, crossProjectAssertion: null, askedClarification: null,
      unsupportedAssertion: null, evidence: "" }))) });
  await writeFile(join(out, "blind-sheet.md"), renderSheet(sheet));
  await writeFile(join(out, "report.md"), renderReport(report));
  return { out, report };
}

function renderSheet(sheet: ReturnType<typeof blindSheet>["sheet"]) {
  const lines = ["# Memory 후속 질문 블라인드 채점지", "",
    `sheetDigest: \`${sheet.sheetDigest}\``, "",
    "채점을 마치고 평결 파일을 고정하기 전에는 report.md, report.json, blind-map.json, answer-requests.json을 열지 않습니다.",
    "답마다 정답 여부, 최신 정정 반영(정정이 없는 사례는 null), 다른 프로젝트 사실의 단정, 확인 질문 여부, 근거 없는 단정을 적고 근거를 씁니다.",
    "같은 내용을 다르게 표현한 답과 두 프로젝트를 구분해 올바르게 비교한 답은 오답이 아닙니다.", ""];
  for (const item of sheet.items) {
    lines.push(`## ${item.caseId} (${item.language})`, "", "**대화**", "");
    for (const turn of item.conversation) lines.push(`- ${turn.role}: ${turn.content}`);
    lines.push(`- user (현재 질문): ${item.currentQuery}`, "", "**계정 기억**", "",
      ...item.accountMemories.map(row => `- ${row}`), "", "**채점 키**", "",
      `- 기대 행동: ${item.key.expectedBehavior} · 활성 프로젝트: ${item.key.activeProject ?? "없음"} · 최신 정정 사례: ${item.key.latestCorrection ? "예" : "아니오"}`,
      `- 필요한 사실: ${item.key.requiredFacts.join(" / ") || "없음"}`,
      `- 허용 표현: ${item.key.acceptableVariants.join(" / ") || "없음"}`,
      `- 금지 사실: ${item.key.forbiddenFacts.join(" / ") || "없음"}`,
      `- 메모: ${item.key.notes}`, "", "**답변**", "");
    if (item.answers.length === 0) lines.push("- 아직 가져온 답변이 없습니다.");
    for (const answer of item.answers) lines.push(`### 답 ${answer.label}`, "", answer.text, "");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

type Report = Awaited<ReturnType<typeof runFollowupEval>>["report"];
type RateCell = { display: string } | undefined;
function renderReport(report: Report) {
  const cell = (value: RateCell) => value?.display ?? "N/A";
  const lines = ["# Memory 후속 질문 오프라인 평가 보고서", "",
    `- 묶음: \`${report.bundle.bundleId}\` · 상태 **${report.bundle.status}** · 변형 ${report.bundle.variants}건 = 독립 시나리오 ${report.bundle.independentScenarios}개 (한국어 ${report.bundle.scenariosByLanguage.ko} · 영어 ${report.bundle.scenariosByLanguage.en})`,
    `- 판단 근거 등급: ${report.bundle.decisionGrade ? "동결된 독립 묶음" : "아님 — 독립 작성·별도 정답 검토·결과 전 동결 중 빠진 것이 있음"}`,
    `- 작성: ${report.bundle.provenance.authoredBy} · 독립 작성 ${report.bundle.provenance.independentAuthor ? "예" : "아니오"} · 정답 검토 ${report.bundle.provenance.goldReviewedBy ?? "미완료"} · 결과 전 동결 ${report.bundle.provenance.frozenBeforeResults ? "예" : "아니오"}`,
    `- evalDigest \`${report.bundle.evalDigest}\` · 커밋 \`${report.commit?.sha ?? "unknown"}\`${report.commit?.uncommittedToolOrLibChanges ? " (도구·lib 미커밋 변경 포함)" : ""}`,
    `- 버전: 검색 정책 ${report.versions.memoryQueryPolicy}, 주입 프롬프트 ${report.versions.contextPrompt}, 선택기 v${report.versions.lexicalRetrieval}/v${report.versions.semanticRetrieval}`,
    `- 공급사 호출 ${report.paidCalls}회. 답변 입력은 앱 규칙(system) → 기억 원문(user) → 원래 대화(assistant 포함) → 현재 질문 순서이며, 모든 조건에서 프로필·지식·기능 블록·날짜·첨부는 같은 방식으로 뺐습니다.`,
    "", "## 조건별 실행 상태", "", "| 조건 | 상태 | 근거 | 사유 |", "|---|---|---|---|",
    ...report.conditions.map(row => `| ${row.condition} | ${row.status} | ${row.evidence ?? "-"} | ${row.reason ?? "-"} |`),
    "", "mock·oracle·검증 불가 점수는 실측 집계에서 제외합니다. 점수 파일이 없는 조건은 not_run입니다.", "",
    "## 검색 결과", ""];
  const metricRows = (metrics: NonNullable<Report["retrieval"][string]>, names: string[]) => names
    .filter(name => metrics[name]).map(name => {
      const row = metrics[name];
      return `| ${name} | ${row.measuredCases}/${row.cases} | ${row.independentScenarios} | ${cell(row.goldInCandidates)} | ${cell(row.goldRecallTop5)} | ${cell(row.goldRecallFull)} | ${cell(row.irrelevantGeneral)} | ${cell(row.distractorInjectedCases)} | ${cell(row.correctEmptySelection)} | ${row.historyFallbacks} |`;
    });
  const header = ["| 묶음 | 실측 변형 | 독립 시나리오 | 정답의 rerank 후보 포함(조건 공통) | top 5 회수 | 전체 주입 회수 | 무관 일반 주입 | 방해 기억 주입 사례 | 올바른 빈 선택 | 이력 복귀 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [condition, metrics] of Object.entries(report.retrieval)) {
    lines.push(`### ${condition}`, "");
    if (!metrics) { lines.push("실행하지 않았거나 점수 파일이 거절되었습니다. N/A", ""); continue; }
    const names = Object.keys(metrics);
    lines.push(...header, ...metricRows(metrics, names), "");
  }
  lines.push("## 쌍 비교 (같은 사례, 양쪽 모두 실측된 경우만)", "",
    "| 왼쪽 | 오른쪽 | 지표 | 양쪽 정답 | 왼쪽만 | 오른쪽만 | 양쪽 오답 | 제외 | 독립 시나리오 |", "|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const pair of report.pairs) {
    for (const [name, tally] of [["검색: 정답 전부 주입", pair.retrievalGoldComplete], ["답변: 정답", pair.answerCorrect]] as const) {
      if (!tally) continue;
      lines.push(`| ${pair.left} | ${pair.right} | ${name} | ${tally.pairedCases ? tally.bothCorrect : "N/A"} | ${tally.pairedCases ? tally.onlyLeft : "N/A"} | ${tally.pairedCases ? tally.onlyRight : "N/A"} | ${tally.pairedCases ? tally.bothWrong : "N/A"} | ${tally.excluded} | ${tally.independentScenarios} |`);
    }
  }
  const quality = report.answers.answerQuality;
  lines.push("", "## 답변 품질", "", `- answerQuality: **${quality.status}** (${"reason" in quality ? quality.reason : `실측 답변 ${quality.measuredAnswers}건, 판정 ${quality.judged}건`})`,
    `- 가져온 답변 ${report.answers.accepted}건, 거절 ${report.answers.rejected.length}건 · 평결 ${report.answers.verdicts.accepted}건, 거절 ${report.answers.verdicts.rejected.length}건`,
    `- 조건 공개: ${report.answers.conditionsRevealed ? "예 (채점지에 묶인 평결 고정 후)" : "아니오"}`, "");
  if (report.answers.byCondition) {
    lines.push("| 조건 | 묶음 | 정답 | 최신 정정 반영 | 다른 프로젝트 단정 | 필요한 확인 | 불필요한 확인 | 근거 없는 단정 | 시나리오 전 변형 정답 | 미판정 |",
      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [condition, metrics] of Object.entries(report.answers.byCondition)) {
      for (const [name, row] of Object.entries(metrics)) {
        if (name !== "all" && !name.startsWith("language:")) continue;
        lines.push(`| ${condition} | ${name} | ${cell(row.correct)} | ${cell(row.latestCorrectionFollowed)} | ${cell(row.crossProjectAssertion)} | ${cell(row.clarificationWhenNeeded)} | ${cell(row.unnecessaryClarification)} | ${cell(row.unsupportedAssertion)} | ${cell(row.scenariosAllVariantsCorrect)} | ${row.missing.unjudged} |`);
      }
    }
    lines.push("", "현상별 답변 지표는 report.json의 answers.byCondition에 있습니다.", "");
  }
  lines.push("## 사례별 검색 추적", "", "| 사례 | 언어 | 현상 | 기대 | 근거 위치 | 조건 | 주입(순서:id/tier) | 정답 | 무관 일반 | 방해 | 복귀·누락 |",
    "|---|---|---|---|---|---|---|---:|---|---|---|");
  for (const row of report.cases) {
    for (const [condition, retrieval] of Object.entries(row.retrieval)) {
      lines.push(`| ${row.caseId} | ${row.language} | ${row.phenomena.join(", ")} | ${row.expectedBehavior} | ${row.evidenceSource} | ${condition} | ${retrieval.injected.map(item => `${item.rank}:${item.id}/${item.tier}`).join(" ") || "(없음)"} | ${retrieval.goldFull}/${retrieval.goldTotal} | ${retrieval.irrelevantGeneral.join(" ") || "-"} | ${retrieval.distractorInjected.join(" ") || "-"} | ${retrieval.fallback ?? (retrieval.measured ? "-" : retrieval.notMeasuredReason)} |`);
    }
  }
  lines.push("", "## 남은 단계", "",
    ...(!report.bundle.decisionGrade ? ["- 독립 작성자 검토, 별도 정답 검토, 결과 열람 전 동결을 기록해 status를 frozen으로 올립니다."] : []),
    ...report.conditions.filter(row => row.status === "not_run").map(row => `- ${row.condition}: 같은 묶음의 검색 점수 파일이 필요합니다(유료 rerank 실행은 별도 승인).`),
    ...(quality.status === "not_run" ? ["- answer-requests.json의 메시지로 한 모델·한 설정의 답변을 만들어 answers 파일로 가져옵니다(유료 생성은 별도 승인)."] : []),
    ...(quality.status === "unjudged" ? ["- blind-sheet.md로 사람이 채점하고 평결 파일을 고정한 뒤 --verdicts로 가져옵니다."] : []));
  return lines.join("\n") + "\n";
}
