/**
 * The shape of a Router evaluation set, and the rules that decide whether a
 * given file may be used to produce `ROUTE-01` evidence.
 *
 * `docs/ops/tomverse-chat-router-evaluation-set.md` is the procedure. This is
 * the part of it a machine can hold: the strata (§2), the development /
 * decision split (§7), the sourcing and adoption rules (§8), and the fact
 * that freezing a set and pre-registering a baseline are human records that an
 * agent may draft around but not enter (§10).
 *
 * Kept separate from `lib/routerQualityEvalCore.ts` on purpose. That file is
 * about what a finished run means; this one is about whether the run should
 * have happened at all, and the two questions fail independently -- a perfect
 * interval computed over a set that was still being edited is the outcome
 * neither check catches alone.
 */

/** §2. Cells are managed independently; a short cell is not averaged away. */
export const EVAL_STRATA = [
  "general_question_answering",
  "writing_and_rewriting",
  "coding",
  "analysis_and_reasoning",
  "translation_cross_language",
  "current_information",
  "document_and_attachment",
  "long_context_conversation",
] as const;

export type EvalStratum = (typeof EVAL_STRATA)[number];

/**
 * §2, in code. Korean is a first-class cell in every stratum rather than a
 * translation of the English one, and the cross-language stratum is mixed by
 * construction, so it has one cell instead of two.
 */
export const EVAL_CELLS: Readonly<Record<EvalStratum, readonly string[]>> = {
  general_question_answering: ["ko", "en"],
  writing_and_rewriting: ["ko", "en"],
  coding: ["ko", "en"],
  analysis_and_reasoning: ["ko", "en"],
  translation_cross_language: ["ko-en"],
  current_information: ["ko", "en"],
  document_and_attachment: ["ko", "en"],
  long_context_conversation: ["ko", "en"],
};

/** §8: where an item came from. A drafted item is a candidate, never adopted. */
export type EvalItemSource = "real" | "drafted" | "adapted";

export type EvalSetItem = {
  id: string;
  stratum: EvalStratum;
  cell: string;
  source: EvalItemSource;
  /** §8/§10: adoption is a human act, so the record is a person and a date. */
  status: "candidate" | "adopted";
  adoptedBy: string | null;
  adoptedAt: string | null;
  prompt: string;
  /** Media types only. The set never carries a file, only the shape of one. */
  attachments?: readonly { mediaType: string }[];
  webSearchRequested?: boolean;
  notes?: string;
};

export type EvalSetBaseline = {
  modelId: string;
  catalogueVersion: string;
  preRegisteredAt: string;
  preRegisteredBy: string;
  rationale: string;
};

export type EvalSet = {
  version: string;
  /** §7: two disjoint sets. Looking at the decision set costs a use. */
  purpose: "development" | "decision";
  frozenAt: string | null;
  frozenBy: string | null;
  baseline: EvalSetBaseline | null;
  cellTargets: readonly { stratum: string; cell: string; target: number }[];
  items: readonly EvalSetItem[];
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Everything wrong with a set, for the purpose it is about to be used for.
 *
 * A development set is allowed to be messy: it exists to be looked at while
 * the Router is tuned, and candidate items are the point. A decision set is
 * the opposite -- it produces the number a launch turns on, so every item has
 * an adopter, the set has a freeze record, and the baseline was named by a
 * person on a date. The `expectedPurpose` argument is what makes running a
 * decision run against a development set an error rather than a shortcut.
 */
export const evalSetProblems = (
  set: unknown,
  options: { expectedPurpose?: EvalSet["purpose"] } = {}
): readonly string[] => {
  if (!set || typeof set !== "object") return ["the evaluation set is not an object"];
  const candidate = set as Partial<EvalSet>;
  const problems: string[] = [];

  if (!isNonEmptyString(candidate.version)) problems.push("no set version");
  if (candidate.purpose !== "development" && candidate.purpose !== "decision") {
    problems.push(`purpose must be development or decision, got ${String(candidate.purpose)}`);
  }
  if (options.expectedPurpose && candidate.purpose !== options.expectedPurpose) {
    problems.push(
      `this is a ${String(candidate.purpose)} set and a ${options.expectedPurpose} set was required`
    );
  }

  const items = Array.isArray(candidate.items) ? candidate.items : [];
  if (items.length === 0) problems.push("the set has no items");

  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const label = isNonEmptyString(item?.id) ? item.id : `item ${index}`;
    if (!isNonEmptyString(item?.id)) {
      problems.push(`${label} has no id`);
    } else if (seen.has(item.id)) {
      problems.push(`${label} appears more than once`);
    } else {
      seen.add(item.id);
    }
    const stratum = item?.stratum as EvalStratum;
    if (!EVAL_STRATA.includes(stratum)) {
      problems.push(`${label} has an unknown stratum "${String(item?.stratum)}"`);
    } else if (!EVAL_CELLS[stratum].includes(item?.cell as string)) {
      problems.push(
        `${label} is in cell "${String(item?.cell)}", which is not a cell of ${stratum}`
      );
    }
    if (!isNonEmptyString(item?.prompt)) problems.push(`${label} has no prompt`);
    if (item?.source !== "real" && item?.source !== "drafted" && item?.source !== "adapted") {
      problems.push(`${label} has no recorded source`);
    }
    if (item?.status !== "candidate" && item?.status !== "adopted") {
      problems.push(`${label} has no adoption status`);
    }
    // §8/§10. An adopted item without an adopter is an item that adopted
    // itself, which is the exact step the procedure reserves for a person.
    if (item?.status === "adopted" && !(isNonEmptyString(item.adoptedBy) && isNonEmptyString(item.adoptedAt))) {
      problems.push(`${label} is adopted but records no adopter and date`);
    }
  }

  // Cell targets are what `cellShortfalls` grades against, so a target naming
  // a cell that does not exist would silently never be filled.
  for (const target of candidate.cellTargets ?? []) {
    if (!EVAL_STRATA.includes(target.stratum as EvalStratum)) {
      problems.push(`a cell target names unknown stratum "${target.stratum}"`);
    } else if (!EVAL_CELLS[target.stratum as EvalStratum].includes(target.cell)) {
      problems.push(`a cell target names unknown cell "${target.stratum}/${target.cell}"`);
    }
    if (!(typeof target.target === "number" && target.target > 0)) {
      problems.push(`cell target ${target.stratum}/${target.cell} is not a positive number`);
    }
  }

  if (candidate.purpose !== "decision") return problems;

  // §7 and §4: everything a decision set needs beyond being well-formed.
  if (!(isNonEmptyString(candidate.frozenAt) && isNonEmptyString(candidate.frozenBy))) {
    problems.push("a decision set must carry a freeze record (who froze it, and when)");
  }
  const unadopted = items.filter((item) => item.status !== "adopted");
  if (unadopted.length > 0) {
    problems.push(
      `${unadopted.length} item(s) in a decision set are still candidates: ` +
        `${unadopted.slice(0, 3).map((item) => item.id).join(", ")}${unadopted.length > 3 ? ", …" : ""}`
    );
  }
  if ((candidate.cellTargets ?? []).length === 0) {
    problems.push("a decision set must declare its cell targets, or no cell can be short");
  }
  const baseline = candidate.baseline;
  if (!baseline) {
    problems.push("a decision set must pre-register its baseline model");
  } else {
    for (const [label, value] of [
      ["model id", baseline.modelId],
      ["catalogue version", baseline.catalogueVersion],
      ["pre-registration date", baseline.preRegisteredAt],
      ["pre-registering person", baseline.preRegisteredBy],
      ["rationale", baseline.rationale],
    ] as const) {
      if (!isNonEmptyString(value)) problems.push(`the pre-registered baseline has no ${label}`);
    }
    if (
      isNonEmptyString(baseline.preRegisteredAt) &&
      isNonEmptyString(candidate.frozenAt) &&
      Date.parse(baseline.preRegisteredAt) > Date.parse(candidate.frozenAt)
    ) {
      problems.push("the baseline was pre-registered after the set was frozen");
    }
  }

  return problems;
};

/** Adopted items only. A candidate is a proposal, not a member of the set. */
export const adoptedItems = (set: EvalSet): readonly EvalSetItem[] =>
  set.items.filter((item) => item.status === "adopted");

/**
 * Cell targets covering every cell of every stratum at the same size.
 *
 * A convenience for writing a set file, not a recommendation: §3 is explicit
 * that the total is computed from a measured pilot discordance, and a target
 * chosen because it made a round number is the sizing mistake that document
 * exists to prevent.
 */
export const uniformCellTargets = (
  perCell: number
): readonly { stratum: EvalStratum; cell: string; target: number }[] =>
  EVAL_STRATA.flatMap((stratum) =>
    EVAL_CELLS[stratum].map((cell) => ({ stratum, cell, target: perCell }))
  );
