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

import { createHash } from "node:crypto";

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

/**
 * docs/ops/tomverse-chat-router-evaluation-set.md §8 lists language beside stratum and cell, and the two are not the same
 * thing.
 *
 * For thirteen of the fifteen cells the cell name is the language and this
 * field only restates it. The two that matter are
 * `translation_cross_language`, whose cell is `ko-en`: that is a direction,
 * not a language. Storing it as one string would mean a later question --
 * "how does the Router do on Korean prompts?" -- could not separate a Korean
 * prompt answered in Korean from a Korean prompt answered in English, and
 * those measure different things.
 */
export type EvalItemLanguage = {
  /** The language the person writes in. */
  prompt: string;
  /** The language a correct answer comes back in. */
  expectedResponse: string;
};

/**
 * How a drafted item was produced, in enough detail to make it again.
 *
 * A free-text "drafted by Claude" reconstructs nothing a year later. docs/ops/tomverse-chat-router-evaluation-set.md §8 makes
 * a drafted item a candidate precisely because the drafter's phrasing is a
 * confound, so the reviewer weighing that confound needs to know which model,
 * which version, and under which prompt.
 *
 * `modelVersion` is whatever identifier the provider actually returned. If it
 * returned none, the field is null -- a guessed snapshot id is worse than an
 * absent one, because it looks checkable and is not.
 */
export const UNRECORDED_PROVENANCE = "unrecorded";

export type EvalDraftProvenance = {
  batchId: string;
  provider: string;
  /** The Tomverse catalogue id, e.g. `mistral-large-3`. */
  modelId: string;
  /**
   * The string actually put in the request body, which for several catalogue
   * entries is a moving alias -- `mistral-large-3` sends
   * `mistral-large-latest`. Recorded separately from `modelId` because the
   * two answer different questions: which model Tomverse calls, and which
   * name the provider was asked for. When the alias moves, only this one
   * stays true about what was sent.
   */
  requestedApiModel: string;
  /**
   * What the provider called itself in its own response. Null when it
   * returned nothing usable: a guessed snapshot id looks checkable and is
   * not.
   *
   * This field was written to hold the version that answered, on the
   * reasoning that an echo of the request would record nothing. Mistral
   * returns the requested alias verbatim here, so for Wave 1 it held
   * `mistral-large-latest` on both sides of a ko/en pair -- a match that
   * proves nothing. Read it with `isEchoOfRequest`, and use
   * `aliasResolution` for the comparison it was meant to support.
   */
  modelVersion: string | null;
  /**
   * The concrete model the provider's own listing puts behind
   * `requestedApiModel`, read at a stated moment from a separate,
   * unbilled call.
   *
   * Absent on batches drafted before this was recorded, and carrying a null
   * `resolvedModelId` whenever the listing could not settle it. Neither
   * absence is a defect to be filled in later by inference: an alias
   * resolved after the fact says where it pointed then, not where it
   * pointed during the request.
   */
  aliasResolution?: {
    resolvedModelId: string | null;
    outcome: "resolved" | "no-alias-recorded" | "ambiguous" | "not-listed" | "unavailable";
    candidates: string[];
    /** When the listing was read; null when it never was. */
    resolvedAt: string | null;
    source: string;
    /** Why the listing could not be read, when that is the reason. */
    note?: string | null;
  };
  /**
   * The request parameters, so a batch can be reproduced rather than
   * approximated. A temperature or a cap that changed between batches is a
   * reason two batches differ, and without this the record would not show it.
   */
  generationParameters: Readonly<Record<string, number | string | boolean>>;
  promptTemplateVersion: string;
  promptTemplateHash: string;
  generatorCommit: string | null;
  draftedAt: string;
};

export type EvalSetItem = {
  id: string;
  stratum: EvalStratum;
  cell: string;
  language: EvalItemLanguage;
  source: EvalItemSource;
  /** §8/§10: adoption is a human act, so the record is a person and a date. */
  status: "candidate" | "adopted";
  adoptedBy: string | null;
  adoptedAt: string | null;
  /** Present on every drafted item; absent on one taken from real traffic. */
  draftProvenance?: EvalDraftProvenance;
  /**
   * The item this one replaces, when a reviewer rejected the original.
   *
   * A rejected prompt is not edited into an accepted one: it is redrafted
   * under a new id, so the review that rejected it still refers to what was
   * actually rejected.
   */
  replaces?: string;
  prompt: string;
  /** Media types only. The set never carries a file, only the shape of one. */
  attachments?: readonly { mediaType: string }[];
  webSearchRequested?: boolean;
  notes?: string;
};

/**
 * The language pair each cell implies, for checking an item against its cell.
 *
 * Kept beside `EVAL_CELLS` rather than derived from the cell name, because
 * `ko-en` does not parse into a pair by any rule that would survive a third
 * cross-language cell being added.
 */
export const CELL_LANGUAGES: Readonly<
  Record<string, { prompt: string; expectedResponse: string }>
> = {
  ko: { prompt: "ko", expectedResponse: "ko" },
  en: { prompt: "en", expectedResponse: "en" },
  "ko-en": { prompt: "ko", expectedResponse: "en" },
};

export type EvalSetBaseline = {
  modelId: string;
  catalogueVersion: string;
  preRegisteredAt: string;
  preRegisteredBy: string;
  rationale: string;
};

/**
 * Which model grades the pairs, fixed before the run.
 *
 * Separate from the baseline because they answer different questions and can
 * be the same model without being the same decision: naming one as the thing
 * to beat says nothing about whether it should also be the one deciding who
 * won.
 */
export type EvalSetJudge = {
  modelId: string;
  preRegisteredAt: string;
  preRegisteredBy: string;
  rationale: string;
};

/**
 * The seed the arm ordering is drawn from, fixed before the run.
 *
 * A seed chosen after seeing a result is a result chosen: the ordering decides
 * which answer the judge reads first, and position bias is real. Recording it
 * afterwards makes the run replayable; recording it beforehand makes it one
 * run rather than the best of several.
 */
export type EvalSetSeed = {
  value: number;
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
  /**
   * `evalSampleDigest` of the sample as it stood at the freeze, so the freeze
   * can be checked rather than believed.
   *
   * Without it `frozenAt` records only that somebody typed a date. The set
   * file stays editable afterwards -- it has to, since the reserve items and
   * the notes live in the same file -- so "frozen" has to mean something a
   * later run can test, not something the file asserts about itself.
   */
  frozenDigest?: string | null;
  baseline: EvalSetBaseline | null;
  judge?: EvalSetJudge | null;
  seed?: EvalSetSeed | null;
  /**
   * docs/ops/tomverse-chat-router-evaluation-set.md §11's "Strata and cell targets frozen" record. A human entry: filled when
   * a person freezes the targets, and what `cellShortfalls` grades against.
   */
  cellTargets: readonly { stratum: string; cell: string; target: number }[];
  /**
   * What an agent may propose instead.
   *
   * Deliberately a different field from `cellTargets`, not a default for it.
   * A proposal and a freeze are different acts by different parties, and one
   * field holding both would make the freeze record unfalsifiable -- there
   * would be no way to tell a target a person chose from one a script wrote.
   */
  proposedPilotCellTarget?: number | null;
  /**
   * Set by a person when the pool is believed complete, which is when a short
   * cell becomes an error rather than work in progress.
   */
  pilotReady?: boolean;
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

    // docs/ops/tomverse-chat-router-evaluation-set.md §8. The cell fixes the language pair, so an item disagreeing with its
    // own cell is one of the two mislabelled -- and either way the cell it
    // gets counted in is not the cell it belongs to.
    const expectedLanguage = CELL_LANGUAGES[item?.cell as string];
    const language = item?.language;
    if (!language || typeof language !== "object") {
      problems.push(`${label} records no language (prompt and expected response)`);
    } else if (expectedLanguage) {
      if (language.prompt !== expectedLanguage.prompt) {
        problems.push(
          `${label} is in cell "${String(item?.cell)}" but its prompt language is ` +
            `"${String(language.prompt)}", not "${expectedLanguage.prompt}"`
        );
      }
      if (language.expectedResponse !== expectedLanguage.expectedResponse) {
        problems.push(
          `${label} is in cell "${String(item?.cell)}" but expects a ` +
            `"${String(language.expectedResponse)}" answer, not "${expectedLanguage.expectedResponse}"`
        );
      }
    }

    // A drafted item whose drafter is unrecorded cannot be weighed for the
    // confound docs/ops/tomverse-chat-router-evaluation-set.md §8 names, which is the whole reason drafted items stay
    // candidates.
    if (item?.source === "drafted") {
      const provenance = item.draftProvenance;
      if (!provenance || typeof provenance !== "object") {
        problems.push(`${label} is drafted but records no draft provenance`);
      } else {
        for (const field of [
          "batchId",
          "provider",
          "modelId",
          "requestedApiModel",
          "promptTemplateVersion",
          "promptTemplateHash",
          "draftedAt",
        ] as const) {
          if (!isNonEmptyString(provenance[field])) {
            problems.push(`${label} draft provenance has no ${field}`);
          }
        }
        if (!provenance.generationParameters || typeof provenance.generationParameters !== "object") {
          problems.push(`${label} draft provenance records no generation parameters`);
        }
      }
    }
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
  const drift = freezeDrift(candidate as EvalSet);
  if (drift) problems.push(drift);
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

  const judge = candidate.judge;
  if (!judge) {
    problems.push("a decision set must pre-register its judge model");
  } else {
    for (const [label, value] of [
      ["model id", judge.modelId],
      ["pre-registration date", judge.preRegisteredAt],
      ["pre-registering person", judge.preRegisteredBy],
      ["rationale", judge.rationale],
    ] as const) {
      if (!isNonEmptyString(value)) problems.push(`the pre-registered judge has no ${label}`);
    }
  }

  const seed = candidate.seed;
  if (!seed) {
    problems.push("a decision set must pre-register its seed");
  } else {
    // Zero is not a seed here: `seededRandom(0)` is what the runner falls back
    // to when --seed is absent, so a stored 0 would read as a choice and act
    // as an omission.
    if (!(typeof seed.value === "number" && Number.isInteger(seed.value) && seed.value > 0)) {
      problems.push("the pre-registered seed is not a positive integer");
    }
    for (const [label, value] of [
      ["pre-registration date", seed.preRegisteredAt],
      ["pre-registering person", seed.preRegisteredBy],
      ["rationale", seed.rationale],
    ] as const) {
      if (!isNonEmptyString(value)) problems.push(`the pre-registered seed has no ${label}`);
    }
  }

  return problems;
};

/** Adopted items only. A candidate is a proposal, not a member of the set. */
export const adoptedItems = (set: EvalSet): readonly EvalSetItem[] =>
  set.items.filter((item) => item.status === "adopted");

/**
 * A fingerprint of what the frozen sample asks, for checking a set against its
 * own freeze record.
 *
 * ## What it covers, and why not everything
 *
 * Only the adopted items, and of those only the fields that decide what a
 * model is handed: the id it is filed under, its cell, its language, the
 * prompt, the shape of any attachment, and whether web search was requested.
 * Those are what a run's numbers are attributable to, so a change to any of
 * them makes the run a measurement of a different thing.
 *
 * Deliberately excluded: `notes`, `adoptedBy`, `adoptedAt`, `draftProvenance`,
 * and every candidate item. Fixing a typo in a reviewer's note, or drafting a
 * replacement into the reserve, does not change what the sample asks -- and a
 * digest that flagged it would be turned off within a week, which is the
 * failure mode of a check that cries wolf.
 *
 * A candidate flipping to adopted, or an adopted item flipping back, does
 * change the digest: `adoptedItems` filters on status, so membership is part
 * of the fingerprint without status needing to be hashed.
 */
export const evalSampleDigest = (set: EvalSet): string => {
  const sample = adoptedItems(set)
    .map((item) => ({
      id: item.id,
      stratum: item.stratum,
      cell: item.cell,
      language: item.language,
      prompt: item.prompt,
      // Array.isArray rather than `?? []`: `evalSetProblems` reaches here with
      // a set it has already found malformed, and a digest that throws would
      // replace a list of problems with a stack trace.
      attachments: (Array.isArray(item.attachments) ? item.attachments : []).map(
        (attachment) => attachment?.mediaType ?? null
      ),
      webSearchRequested: item.webSearchRequested === true,
    }))
    // Sorted so a reordering of the file is not a change to the sample. The
    // ids are unique, so this is a total order.
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(sample)).digest("hex")}`;
};

/**
 * Why the set no longer matches its freeze record, or null if it does.
 *
 * Separated from the callers because both `evalSetProblems` and
 * `decisionRunRefusals` need the same answer phrased the same way, and a set
 * that drifted after freezing should read identically whichever one caught it.
 */
export const freezeDrift = (set: EvalSet): string | null => {
  if (!(isNonEmptyString(set.frozenAt) && isNonEmptyString(set.frozenBy))) {
    return "the set carries no freeze record, so there is no moment its contents are pinned to";
  }
  if (!isNonEmptyString(set.frozenDigest)) {
    return (
      `the freeze record (${set.frozenAt}, ${set.frozenBy}) carries no digest, so nothing ` +
      `distinguishes the set that was frozen from the set as it stands now`
    );
  }
  const now = evalSampleDigest(set);
  if (set.frozenDigest !== now) {
    return (
      `the sample has changed since it was frozen at ${set.frozenAt}: ` +
      `frozen as ${set.frozenDigest}, now ${now}`
    );
  }
  return null;
};

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


/** Every cell of every stratum, as the flat list the counters work over. */
export const allCells = (): readonly { stratum: EvalStratum; cell: string }[] =>
  EVAL_STRATA.flatMap((stratum) => EVAL_CELLS[stratum].map((cell) => ({ stratum, cell })));

export type CellFill = {
  stratum: EvalStratum;
  cell: string;
  target: number;
  candidates: number;
  adopted: number;
  /** Adopted is what counts: a candidate is a proposal, not a member. */
  short: number;
};

/**
 * How full each cell is, counted per cell and never pooled.
 *
 * docs/ops/tomverse-chat-router-evaluation-set.md §2 manages cells independently and reports a short cell as `UNDERPOWERED`
 * rather than averaging it away, so this returns one row per cell -- including
 * the cells that are full. A summary that listed only the short ones would
 * make "no output" mean both "everything is full" and "nothing was counted".
 *
 * The target is the frozen `cellTargets` entry where one exists, and the
 * agent's `proposedPilotCellTarget` otherwise. Which of the two was used is a
 * question for the caller to report; this function does not decide whether a
 * shortfall is an error, because during collection every cell is short and
 * that is not a failure.
 */
/**
 * Why a decision run must be refused, or an empty list if it may proceed.
 *
 * `evalSetProblems` already refuses a decision set that is unfrozen, still
 * holds candidates, declares no cell targets or pre-registers no baseline.
 * Two things it does not say, and both decide whether a *run* is the pilot
 * that was designed:
 *
 *   - `pilotReady` is the flag a person sets to mean "measure this now". The
 *     runner never read it, so setting it or not made no difference.
 *   - A cell holding MORE than its target is as wrong as one holding less.
 *     Collection overshoots on purpose -- spare candidates cover review
 *     rejections -- and a run that takes all of them silently reweights the
 *     strata and resizes an n that
 *     docs/ops/tomverse-chat-router-evaluation-set.md §3 fixes in advance.
 *
 * Kept out of `evalSetProblems` because that answers "is this set usable",
 * which a set with spare adopted items still is. This answers "is this run
 * the pre-registered one", which is a different question with a different
 * answer.
 */
export const decisionRunRefusals = (set: EvalSet): readonly string[] => {
  const refusals: string[] = [];
  if (set.pilotReady !== true) {
    refusals.push(
      `the set does not say it is ready: pilotReady is ${JSON.stringify(set.pilotReady ?? null)}, not true`
    );
  }
  if ((set.cellTargets ?? []).length === 0) {
    refusals.push("cellTargets is empty, so no cell has a frozen target to match");
  }
  for (const cell of cellFill(set)) {
    if (cell.adopted !== cell.target) {
      refusals.push(
        `${cell.stratum}/${cell.cell} holds ${cell.adopted} adopted against a target of ${cell.target}`
      );
    }
  }
  if (!set.baseline?.modelId) {
    refusals.push("no baseline is pre-registered, so there is nothing to compare against");
  }
  if (!set.judge?.modelId) {
    refusals.push("no judge is pre-registered, so nothing fixes who grades the pairs");
  }
  if (!set.seed?.value) {
    refusals.push("no seed is pre-registered, so the arm ordering was not fixed in advance");
  }
  // The one condition the other conditions cannot stand in for: every one of
  // them reads the set as it is now, and all of them can be satisfied by a set
  // edited this morning. This one asks whether it is still the set that was
  // frozen.
  const drift = freezeDrift(set);
  if (drift) refusals.push(drift);
  return refusals;
};

/**
 * Where a run's arguments disagree with what the set pre-registered.
 *
 * The runner takes `--baseline`, `--judge` and `--seed` as free arguments and
 * writes the set's pre-registration provenance into the report beside them. So
 * a run could be given a model nobody registered and produce a record saying
 * it was registered by a named person on a stated date -- the provenance would
 * be true of the field it was copied from and false of the run it described.
 *
 * `mode` is read for one exception: the bias run of
 * docs/ops/tomverse-chat-router-evaluation-set.md §5 deliberately puts a
 * different model in the baseline arm, because a judge compared against itself
 * measures nothing. Its judge and seed are still the pre-registered ones.
 */
export const runParameterMismatches = (
  set: EvalSet,
  run: { mode: string; baselineModelId: string; judgeModelId: string; seed: number }
): readonly string[] => {
  const mismatches: string[] = [];
  const registered = set.baseline?.modelId;
  if (run.mode !== "judge-bias" && registered && run.baselineModelId !== registered) {
    mismatches.push(
      `--baseline=${run.baselineModelId}, but the set pre-registered ${registered}`
    );
  }
  if (set.judge?.modelId && run.judgeModelId !== set.judge.modelId) {
    mismatches.push(`--judge=${run.judgeModelId}, but the set pre-registered ${set.judge.modelId}`);
  }
  if (set.seed?.value && run.seed !== set.seed.value) {
    mismatches.push(`--seed=${run.seed}, but the set pre-registered ${set.seed.value}`);
  }
  return mismatches;
};

export const cellFill = (set: EvalSet): readonly CellFill[] => {
  const frozen = new Map(
    (set.cellTargets ?? []).map((target) => [`${target.stratum}/${target.cell}`, target.target])
  );
  const proposed =
    typeof set.proposedPilotCellTarget === "number" && set.proposedPilotCellTarget > 0
      ? set.proposedPilotCellTarget
      : 0;
  return allCells().map(({ stratum, cell }) => {
    const items = set.items.filter((item) => item.stratum === stratum && item.cell === cell);
    const adopted = items.filter((item) => item.status === "adopted").length;
    const target = frozen.get(`${stratum}/${cell}`) ?? proposed;
    return {
      stratum,
      cell,
      target,
      candidates: items.filter((item) => item.status === "candidate").length,
      adopted,
      short: Math.max(0, target - adopted),
    };
  });
};

/**
 * Drafted items whose drafter cannot be reconstructed.
 *
 * `evalSetProblems` only asks that a drafted item record a provenance, and a
 * field reading "unrecorded" satisfies that. It is a truthful record of a real
 * gap -- some items predate the schema -- but it would otherwise pass a check
 * whose whole point is reconstructability, silently. So the gap is counted and
 * reported rather than left to look like a filled field.
 */
export const unrecordedProvenanceItems = (set: EvalSet): readonly EvalSetItem[] =>
  set.items.filter(
    (item) =>
      item.source === "drafted" &&
      (item.draftProvenance?.provider ?? UNRECORDED_PROVENANCE) === UNRECORDED_PROVENANCE
  );

/**
 * Batches whose drafter answered under a different version from its siblings.
 *
 * A wave pairs a `ko` batch with an `en` one so the reviewer can compare the
 * two languages. That comparison only holds if the same model wrote both: if
 * the provider moved an alias between the two calls -- which
 * `mistral-large-latest` is built to do -- then a difference the reviewer
 * reads as "Korean came out weaker" may be the two models differing instead.
 *
 * Returns one entry per distinct `modelVersion` seen across the given
 * batches, so an empty-or-single result means they agree. This reports; it
 * does not reject. Whether a mismatch disqualifies a wave is
 * docs/ops/tomverse-chat-router-evaluation-set.md §8's adoption question, and belongs
 * to the person doing the adopting.
 */
export const draftVersionsAcross = (
  set: EvalSet,
  batchIds: readonly string[]
): readonly { modelVersion: string | null; batchIds: readonly string[] }[] => {
  const byVersion = new Map<string, { modelVersion: string | null; batchIds: string[] }>();
  for (const batchId of batchIds) {
    for (const item of set.items) {
      if (item.draftProvenance?.batchId !== batchId) continue;
      const version = item.draftProvenance.modelVersion;
      const key = version ?? "\u0000null";
      const entry = byVersion.get(key) ?? { modelVersion: version, batchIds: [] };
      if (!entry.batchIds.includes(batchId)) entry.batchIds.push(batchId);
      byVersion.set(key, entry);
    }
  }
  return [...byVersion.values()];
};
