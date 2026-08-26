/**
 * Whether a finished answer should be offered an expansion into Deep Research.
 *
 * The offer is deliberately *not* "switch model and answer again". The answer
 * on screen stays, stays complete, and stays what the user asked for; this
 * only says that a second, source-heavy pass would add something. So every
 * name here is about the value ("would more sources help?") and never about
 * the mechanism ("shall I re-run this on Perplexity?"). The copy layer is
 * held to the same line by `tests/deepResearchSuggestionCopy.test.mjs`.
 *
 * ## Why the topic rules are here and not in the task profile
 *
 * `lib/taskProfileCore.ts` already reads a turn, and this module *uses* it
 * rather than re-deriving what it knows: the kind, whether the turn needs
 * current information, and how long an answer it asked for all come from
 * there. What it does not carry is the axis this offer turns on -- "would
 * several sources, compared against each other, change the answer" -- and
 * adding one would mean bumping `TASK_PROFILE_VERSION`, which is recorded on
 * every `RoutingRun` and is how a shift in routing behaviour is attributed.
 * A product offer is not entitled to make every past routing decision
 * unattributable, so the extra axis lives here.
 *
 * That is the same split `lib/webSearchSuggestion.ts` already draws between
 * `hasExplicitSourceOrSearchIntent` (a capability decision) and
 * `suggestsWebSearchInComposer` (a UI comfort rule). This module is entirely
 * on the comfort side: nothing here gates access, prices anything, or decides
 * what a request may do.
 *
 * ## No model call
 *
 * Deterministic keyword and shape rules over the turn the user already sent,
 * exactly like the two modules it builds on. Deciding whether to *offer* a
 * paid action must not itself cost a paid call, and a suggestion that arrived
 * a second after the answer -- because something had to be asked first --
 * would read as the app second-guessing what it had just said.
 *
 * Korean and English only, like every other heuristic in this repository
 * (`lib/webSearchSuggestion.ts`, `lib/imageIntentSignals.ts`,
 * `lib/taskProfileCore.ts`). A turn in a language none of them read produces
 * no signals and therefore no offer, which is the safe direction: the cost of
 * staying quiet is nothing, and the cost of guessing is a card under an answer
 * that did not need one.
 *
 * Pure and synchronous. No database, no clock, no I/O.
 */

import type { ComparisonModelStatus } from "@/lib/comparisonReadiness";
import { buildTaskProfile } from "@/lib/taskProfileCore";

/**
 * The one model this offer expands into.
 *
 * Named here because the offer, the availability check and the execution all
 * have to mean the same model, and a string literal repeated in three files is
 * three chances to mean a different one.
 */
export const DEEP_RESEARCH_MODEL_ID = "perplexity/sonar-deep-research";

/**
 * The scope an expansion runs at.
 *
 * The offer takes no second confirmation -- pressing it starts the run -- so
 * it cannot ask which depth the user wants. It takes the same value
 * `DeepResearchSetupSheet` opens on, and imports it from here so the two
 * cannot drift into offering different amounts of work under one name.
 */
export const DEEP_RESEARCH_DEFAULT_DEPTH = "standard" as const;

/**
 * Below this many characters a turn is not read at all.
 *
 * The same reasoning as the four-character floor in
 * `suggestsWebSearchInComposer`, at a higher number because this offer is
 * made about a *sent* question rather than a draft: a question short enough
 * to fit here is a lookup, and the answer to a lookup is not improved by
 * comparing twelve sources.
 */
export const DEEP_RESEARCH_SUGGESTION_MINIMUM_LENGTH = 12;

/* ------------------------------------------------------------------------ */
/* The topic axis                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Why this turn looks like one more sources would help with.
 *
 * Reported as a list rather than a single label because they are independent
 * readings, and because the caller records which ones fired -- fixed
 * identifiers from this file, never anything taken from the text.
 */
export const DEEP_RESEARCH_TOPIC_SIGNALS = [
  /** The user asked for sources, citations, research or a search themselves. */
  "explicit_research_request",
  /** The answer depends on information newer than a model's training. */
  "recency",
  /** Several sources have to be set against each other. */
  "multi_source_comparison",
  /** Claims are in dispute and need checking rather than repeating. */
  "claim_verification",
  /** Market, policy, industry or academic ground, where depth is the point. */
  "domain_depth",
] as const;

export type DeepResearchTopicSignal =
  (typeof DEEP_RESEARCH_TOPIC_SIGNALS)[number];

/** Why a turn was read and then set aside. */
export type DeepResearchTopicRefusal =
  /** Shorter than the floor above. */
  | "too_short"
  /** Code. More sources do not fix a stack trace. */
  | "coding"
  /** Writing, rewriting or translation: the work is the text, not the facts. */
  | "writing_or_translation"
  /** The user asked for one line, and a research report is not one line. */
  | "short_answer_requested"
  /** Read, and nothing in it says depth would change the answer. */
  | "no_depth_signal";

export type DeepResearchTopicDecision = {
  suggested: boolean;
  signals: readonly DeepResearchTopicSignal[];
  refusal: DeepResearchTopicRefusal | null;
};

export type DeepResearchTopicInput = {
  /** The user's turn. Never stored or echoed by this module. */
  text: string;
  attachments?: ReadonlyArray<{ name?: string; mediaType?: string }>;
  /** The user had web search switched on for this turn. */
  webSearchRequested?: boolean;
};

// Several sources, set against each other. "비교" on its own is the everyday
// word for it; the rest are the shapes a comparison request takes when the
// word itself is not used.
const COMPARISON_WORDS =
  /\b(compare|comparison|contrast|versus|vs\.?|pros and cons|trade-?offs?|which is better|cross-?check|multiple sources|several sources|different sources)\b|비교|대조|장단점|차이점|어느\s*쪽이|여러\s*(자료|출처|문헌|기사|보고서)|각각의\s*(장단점|차이)/i;

// Claims in dispute. Deliberately not the vocabulary of a simple fact check
// ("맞아?", "is it true") -- that is the case this offer must stay out of --
// but of claims that disagree with each other.
const VERIFICATION_WORDS =
  /\b(conflicting|contradict\w*|disputed|controvers\w+|debunk|fact-?check\w*|verify the claims?|sources disagree|is there evidence)\b|상충|모순|엇갈리|논란|반박|검증|진위|신빙성|근거가\s*있는지|사실인지\s*확인/i;

// Market, policy, industry and academic ground. The offer's own list, in the
// wording of the request rather than of a taxonomy.
const DOMAIN_DEPTH_WORDS =
  /\b(market (size|share|trend|analysis|landscape|outlook)|industry (trend|analysis|report|landscape)|competitive landscape|competitor analysis|regulat\w+|policy|legislation|白書|whitepaper|literature review|systematic review|meta-?analysis|academic|peer-?reviewed|prior art|due diligence|feasibility study|state of the art)\b|시장\s*(규모|점유율|동향|분석|전망|현황)|산업\s*(동향|분석|전망|현황)|업계\s*(동향|현황)|경쟁\s*(사|구도|환경)|규제|정책|법안|입법|제도\s*변화|학술|논문|선행\s*연구|문헌\s*조사|메타\s*분석|타당성\s*조사|기술\s*동향|리서치|심층\s*(분석|조사)|보고서를\s*(작성|만들)/i;

/**
 * Reads one sent turn and says whether an expansion is worth offering for it.
 *
 * Exclusions are checked before signals, and in the order a wrong offer would
 * cost the most: a coding turn offered a research report is a worse mistake
 * than a market question that was not offered one, because the second costs
 * the user nothing and the first costs them a reason to distrust the card.
 */
export const classifyDeepResearchTopic = (
  input: DeepResearchTopicInput
): DeepResearchTopicDecision => {
  const text = (input.text ?? "").trim();
  const none = (refusal: DeepResearchTopicRefusal): DeepResearchTopicDecision => ({
    suggested: false,
    signals: [],
    refusal,
  });

  if (text.length < DEEP_RESEARCH_SUGGESTION_MINIMUM_LENGTH) {
    return none("too_short");
  }

  const profile = buildTaskProfile({
    text,
    attachments: input.attachments,
    webSearchRequested: input.webSearchRequested,
  });

  if (profile.kind === "coding") return none("coding");
  if (profile.kind === "writing" || profile.kind === "multilingual") {
    return none("writing_or_translation");
  }
  // "한 줄로", "간단히", "yes or no". Whatever else the turn is about, it
  // asked for something a report is not.
  if (profile.expectedOutputLength === "short") {
    return none("short_answer_requested");
  }

  const signals: DeepResearchTopicSignal[] = [];
  // `kind: "research"` is set by the same predicate that means "the user asked
  // for sources, citations or a search" (lib/taskProfileCore.ts), which is the
  // strongest statement of intent this offer can read.
  if (profile.kind === "research") signals.push("explicit_research_request");
  if (profile.needsCurrentInformation) signals.push("recency");
  if (COMPARISON_WORDS.test(text)) signals.push("multi_source_comparison");
  if (VERIFICATION_WORDS.test(text)) signals.push("claim_verification");
  if (DOMAIN_DEPTH_WORDS.test(text)) signals.push("domain_depth");

  /**
   * Recency alone is not enough, and that is the rule that keeps this offer
   * away from simple fact checks.
   *
   * "오늘 서울 날씨 알려줘" needs current information and nothing else. It is
   * long enough to clear the floor, it is not code, not writing, and it did
   * not ask for one line -- so every other rule here passes it. Offering a
   * multi-minute research report for it would be the card's most common
   * appearance, and its least useful one.
   *
   * The exception is a turn that asked for depth as well: "2026년 전기차
   * 보조금 정책 변화를 자세히 정리해줘" is recency *and* a request for a long
   * answer, and that pair is a research question however it is worded.
   */
  const hasDepthSignal = signals.some(
    (signal) => signal !== "recency"
  );
  const recencyWithDepthRequested =
    signals.includes("recency") && profile.expectedOutputLength === "long";

  if (!hasDepthSignal && !recencyWithDepthRequested) {
    return { suggested: false, signals, refusal: "no_depth_signal" };
  }

  return { suggested: true, signals, refusal: null };
};

/**
 * Stable key for "this topic has already been answered for in this
 * conversation".
 *
 * The same shape and the same reason as `imageIntentDraftKey` in
 * `lib/imageIntentSignals.ts`: deterministic per trimmed question, not
 * cryptographic.
 *
 * Written out here rather than imported. `lib/webSearchSuggestion.ts` exports a
 * `draftSuggestionKey` of exactly this shape today, but it belongs to the
 * composer's "auto" web-search nudge -- and that nudge is on its way out with
 * the switch that replaces the three modes with two. Borrowing it would tie
 * this offer's "same topic" rule to the lifetime of an unrelated feature, and
 * three lines are cheaper than that coupling.
 */
export const deepResearchTopicKey = (text: string): string =>
  text.trim().toLowerCase();

/* ------------------------------------------------------------------------ */
/* The offer                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Whether this viewer could run Deep Research at all, decided by the caller
 * from the same facts the setup sheet reads -- the model's presence in the
 * catalogue and `canUseModelWithPlan` -- never from an identity branch here.
 */
export type DeepResearchAvailability =
  | "available"
  /** No such model in this deployment's catalogue, or it is switched off. */
  | "unavailable"
  | "sign_in_required"
  | "plan_locked";

/**
 * The turn an offer would be about: one question, and the ids that identify
 * it. `promptId` is the comparison id every panel of a multi-model send
 * already answers under, which is what makes "once per question" expressible
 * at all -- see `offered` below.
 */
export type DeepResearchSuggestionTurn = {
  conversationId: string;
  promptId: string;
  text: string;
  attachments?: ReadonlyArray<{ name?: string; mediaType?: string }>;
  webSearchRequested?: boolean;
};

export type DeepResearchSuggestionRefusal =
  /** Nothing has been asked yet, or the last send was itself deep research. */
  | "no_turn"
  /** The recorded turn belongs to a conversation that is no longer on screen. */
  | "conversation_changed"
  | "feature_unavailable"
  | "sign_in_required"
  | "plan_locked"
  /** Deep Research is one of the models answering this question already. */
  | "already_deep_research"
  /** A deep research job is running right now. */
  | "deep_research_in_progress"
  /** At least one panel is still streaming. */
  | "still_generating"
  /** Everything settled and nothing usable came out of it. */
  | "no_usable_answer"
  /** Offered and answered for this topic already, in this conversation. */
  | "resolved"
  /** Shown for this topic already, under an earlier question. */
  | "already_offered"
  | "topic_not_suitable";

export type DeepResearchSuggestion = {
  offered: boolean;
  refusal: DeepResearchSuggestionRefusal | null;
  /** The question an expansion would carry. Null unless `offered`. */
  promptId: string | null;
  text: string | null;
  topicKey: string | null;
  signals: readonly DeepResearchTopicSignal[];
};

export type DeepResearchSuggestionInput = {
  /** The conversation currently on screen. */
  conversationId: string | null;
  /** The last ordinary question asked in it, or null. */
  turn: DeepResearchSuggestionTurn | null;
  selectedModelIds: readonly string[];
  disabledModelIds: readonly string[];
  /** Per-panel runtime status, the same map the comparison rail reads. */
  modelStatuses: Readonly<Record<string, ComparisonModelStatus | undefined>>;
  availability: DeepResearchAvailability;
  /** A deep research job this page started is still running. */
  isDeepResearchRunning: boolean;
  /**
   * Topic keys this conversation has already settled -- dismissed by the user
   * or expanded by them. Both end the offer for the topic, because both are
   * an answer to it.
   */
  resolvedTopicKeys: readonly string[];
  /**
   * Topics this conversation has already put the card on screen for, each
   * with the question that did it.
   *
   * "Already offered" and "already answered" are different facts and both end
   * the repeat: someone who was shown the card and neither took nor declined
   * it has still seen it, and showing it again for the same question is the
   * app asking twice. The promptId is what makes the rule expressible without
   * the card refusing itself -- the entry is written the moment it appears, so
   * the turn that caused it must be exempt from it.
   */
  offeredTopics: readonly { topicKey: string; promptId: string }[];
};

const NOT_OFFERED = (
  refusal: DeepResearchSuggestionRefusal
): DeepResearchSuggestion => ({
  offered: false,
  refusal,
  promptId: null,
  text: null,
  topicKey: null,
  signals: [],
});

/**
 * The single decision both shells read.
 *
 * Called once per shell with that shell's own status map, exactly like
 * `deriveComparisonReadiness` -- the panels report to the shell, so the shell
 * is where the map lives, and the *rules* are here so desktop and mobile
 * cannot come to disagree about when the card appears.
 *
 * ## Why this is once per question and not once per answer
 *
 * A three-model comparison produces three finished answers to one question.
 * Three cards under three panels would be three offers to do the same thing,
 * priced once and running once. So the decision is keyed on the question --
 * `turn.promptId` -- and the card is rendered by the shell in the bottom
 * workflow dock, which exists once however many panels are on screen.
 *
 * ## Why a locked viewer sees nothing
 *
 * The image workspace states its requirement up front and routes the click to
 * sign-in, because those are *entry points* to a feature and hiding an entry
 * point hides the feature. This is not an entry point: Deep Research already
 * has its own, in the composer, where a locked viewer meets exactly that
 * treatment. An unusable card volunteered under an answer nobody asked to
 * expand would be an upsell attached to a finished piece of work.
 */
export const deriveDeepResearchSuggestion = (
  input: DeepResearchSuggestionInput
): DeepResearchSuggestion => {
  const { turn } = input;
  if (!turn) return NOT_OFFERED("no_turn");
  if (!input.conversationId || turn.conversationId !== input.conversationId) {
    return NOT_OFFERED("conversation_changed");
  }

  if (input.availability === "unavailable") {
    return NOT_OFFERED("feature_unavailable");
  }
  if (input.availability === "sign_in_required") {
    return NOT_OFFERED("sign_in_required");
  }
  if (input.availability === "plan_locked") return NOT_OFFERED("plan_locked");

  if (input.selectedModelIds.includes(DEEP_RESEARCH_MODEL_ID)) {
    return NOT_OFFERED("already_deep_research");
  }
  if (input.isDeepResearchRunning) {
    return NOT_OFFERED("deep_research_in_progress");
  }

  const topicKey = deepResearchTopicKey(turn.text);
  if (input.resolvedTopicKeys.includes(topicKey)) {
    return NOT_OFFERED("resolved");
  }
  if (
    input.offeredTopics.some(
      (offered) =>
        offered.topicKey === topicKey && offered.promptId !== turn.promptId
    )
  ) {
    return NOT_OFFERED("already_offered");
  }

  // The same population the comparison rail draws from: selected, minus the
  // panels the user paused. A paused panel is outside the question.
  const active = input.selectedModelIds.filter(
    (modelId) => !input.disabledModelIds.includes(modelId)
  );
  let completed = 0;
  for (const modelId of active) {
    const status = input.modelStatuses[modelId];
    if (status === "loading" || status === "responding") {
      return NOT_OFFERED("still_generating");
    }
    if (status === "idle") completed += 1;
  }
  if (completed === 0) return NOT_OFFERED("no_usable_answer");

  const topic = classifyDeepResearchTopic({
    text: turn.text,
    attachments: turn.attachments,
    webSearchRequested: turn.webSearchRequested,
  });
  if (!topic.suggested) return NOT_OFFERED("topic_not_suitable");

  return {
    offered: true,
    refusal: null,
    promptId: turn.promptId,
    text: turn.text,
    topicKey,
    signals: topic.signals,
  };
};
