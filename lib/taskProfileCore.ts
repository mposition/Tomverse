/**
 * The versioned task profile — step 1 of the Router rollout order in
 * `docs/policy/tomverse-chat-delivery-plan.md` §6.
 *
 * A user turn arrives as text and attachments. The Router has to choose a
 * model from that, and the choice depends on several things that are not one
 * thing: whether the turn is code, whether it needs information newer than any
 * model's training, whether an image has to be understood, how long the answer
 * is likely to be. Collapsing those into a single label would force the Router
 * to re-derive them, so this reports them as independent axes.
 *
 * Three properties are load-bearing, and each exists because of a rule the
 * routing policy already states.
 *
 * **Content-free output.** `docs/policy/tomverse-chat-routing.md` §2: raw
 * effective prompts are not copied into routing telemetry. A profile is
 * recorded on every `RoutingRun`, so it carries labels, booleans and the
 * *names* of the rules that fired — never the text that matched them. A test
 * pins that, because the tempting debugging aid ("which phrase triggered
 * this?") is exactly the leak.
 *
 * **Versioned.** `RoutingRun` records the Task Profiler version alongside the
 * Router and Estimator versions, so a shift in routing behaviour can be
 * attributed. Changing any rule below changes the version.
 *
 * **Deterministic, and not pretending otherwise.** These are keyword and shape
 * rules. They run in shadow mode first (§6 step 3) while the user's own
 * selection stays authoritative, and their quality is judged against a
 * decision-grade evaluation set that does not exist yet — that set is a
 * separate, human-owned data task, the same separation
 * `docs/ops/tomverse-chat-router-evaluation-set.md` requires. Until it exists,
 * nothing here may be described as accurate; it can only be described as
 * defined.
 *
 * Nothing in this module fetches, reads a database, or calls a model.
 */

import { CJK_CHARACTER_PATTERN } from "@/lib/chatTokenEstimate";
import {
    hasExplicitSourceOrSearchIntent,
    suggestsRecentInformationNeeded,
} from "@/lib/webSearchSuggestion";

/**
 * Bump on any change to the rules, the axes, or their meanings.
 *
 * A profile whose version is not recorded is a routing decision that cannot be
 * explained afterwards, which is the whole reason `RoutingRun` carries one.
 *
 * v2: an explicit request for sources, citations or a search now sets
 * `needsCurrentInformation` at any length. v1 read that flag through the
 * composer's suggestion heuristic, which ignores drafts shorter than four
 * characters so it does not nag while somebody types -- and that typing-time
 * floor was load-bearing on a safety boundary, because the flag drives the
 * Router's web-search hard filter. So `"출처"` recorded `false` and a model
 * with no search path stayed eligible for a turn that asked for sources.
 * Recorded as a new version rather than fixed in place: one version answering
 * `false` before the change and `true` after would make every run under it
 * unattributable.
 */
export const TASK_PROFILE_VERSION = "task-profile-v2";

/**
 * The dominant shape of the turn.
 *
 * Deliberately the same vocabulary as `MODEL_FINDER_TASKS` where it overlaps,
 * so the repository does not grow two competing names for "this is a coding
 * question". They stay separate functions, though: the model finder is a
 * questionnaire the user answers about themselves, and this is a server-side
 * reading of one turn. Fusing them would make a user's stated preference and a
 * classifier's guess the same input.
 */
export const TASK_KINDS = [
    "coding",
    "documents",
    "research",
    "writing",
    "multilingual",
    "general",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * How many independent rules agreed, banded.
 *
 * Not a probability, and named so it cannot be mistaken for one. Deterministic
 * keyword rules have no calibrated likelihood to report, and printing `0.83`
 * would invite the Router to compare it against a threshold as though it meant
 * something. Once the decision-grade set exists these bands can be measured;
 * until then they say only how much of this module agreed with itself.
 */
export const TASK_CONFIDENCE_BANDS = ["none", "weak", "strong"] as const;
export type TaskConfidenceBand = (typeof TASK_CONFIDENCE_BANDS)[number];

export type ExpectedOutputLength = "short" | "medium" | "long";

export type TaskProfileInput = {
    /** The user's turn. Never stored or echoed by this module. */
    text: string;
    attachments?: ReadonlyArray<{ name?: string; mediaType?: string }>;
    /** The user asked for web search explicitly, rather than the rule guessing. */
    webSearchRequested?: boolean;
};

export type TaskProfile = {
    version: string;
    kind: TaskKind;
    kindConfidence: TaskConfidenceBand;
    /**
     * The turn wants information newer than a model's training data. Kept
     * separate from `kind: "research"` because they answer different
     * questions: a one-line "what's the weather" needs current information and
     * is not research, and a literature summary is research that may need
     * nothing current.
     *
     * Separate does not mean symmetrical, and the asymmetry is worth knowing
     * before reading a profile. The research *kind* is recognised by someone
     * asking for sources, citations or a search, so a research turn also needs
     * the web -- there is no `kind: "research"` with this false. The direction
     * that stays open is the other one, and it is the one that matters: this
     * flag being true says nothing about the kind, and a literature summary
     * arrives as document work with this false. Which is why the Router filters
     * on this flag and never on the kind: filtering on the kind would put
     * document analysis on a search model for no reason.
     */
    needsCurrentInformation: boolean;
    /** Hard capability filters for the Router's candidate set. */
    hasImageInput: boolean;
    hasDocumentInput: boolean;
    /**
     * A coarse expectation used to size `maxOutputTokens`, not a promise. It
     * reads the request ("in one line", "write a full report"), so a turn that
     * says nothing about length lands on `medium`.
     */
    expectedOutputLength: ExpectedOutputLength;
    /** Present scripts, for tokenizer-stratified estimation and quality arms. */
    scripts: readonly ("latin" | "cjk")[];
    /**
     * Which rules fired, by name. Content-free by construction: rule names are
     * fixed identifiers in this file, never anything taken from the input.
     */
    signals: readonly string[];
};

const IMAGE_MEDIA = /^image\//i;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i;
const DOCUMENT_MEDIA = /pdf|officedocument|opendocument|msword|ms-excel|ms-powerpoint|csv|plain/i;
const DOCUMENT_NAME = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|txt|md|rtf)$/i;

/**
 * Code is recognised by shape before vocabulary. A fenced block or a stack
 * trace is a far stronger signal than the word "function", which appears in
 * ordinary prose about mathematics and about organisations.
 */
const CODE_FENCE = /```|~~~/;
const CODE_SHAPE =
    /(^|\n)\s*(?:def |class |import |from \w+ import|function |const |let |var |public |private |#include|package |SELECT .+ FROM|<\/?[a-z][\w-]*>)/i;
const STACK_TRACE =
    /(Traceback \(most recent call last\)|^\s*at [\w$.]+\(|Exception in thread|error TS\d{4}|SyntaxError|NullPointerException)/im;
const CODE_WORDS =
    /\b(bug|debug|refactor|compile|compiler|stack ?trace|regex|api|sdk|typescript|javascript|python|rust|golang|sql|docker|kubernetes)\b|버그|디버그|리팩터|컴파일|스택\s*트레이스|정규식/i;

const WRITING_WORDS =
    /\b(write|draft|rewrite|edit|proofread|essay|poem|story|blog post|email|copy)\b|글쓰기|작성해|초안|다듬어|교정|에세이|시\s*써|이메일\s*써/i;

const DOCUMENT_WORDS =
    /\b(summari[sz]e|summary|contract|agreement|clause|due diligence|report|whitepaper|attached document)\b|요약|계약서|조항|실사|보고서|첨부\s*문서/i;

const TRANSLATION_WORDS =
    /\b(translate|translation|in korean|in english|localis|localiz)\b|번역|한국어로|영어로|현지화/i;

const SHORT_OUTPUT =
    /\b(in one (line|sentence)|briefly|short answer|tl;?dr|yes or no|one word)\b|한\s*줄로|간단히|짧게|요약만|한\s*문장으로/i;
const LONG_OUTPUT =
    /\b(in detail|detailed|step by step|comprehensive|full (report|guide)|essay|thorough|write an? (article|report|guide))\b|자세히|상세히|단계별로|전체\s*보고서|길게|자세한\s*설명/i;

/**
 * Reads one turn.
 *
 * Order matters where two rules could both fire: attachments outrank text,
 * because a PDF in the request is a fact and a keyword is a guess. Beyond
 * that, kinds are checked strongest-signal first.
 */
export function buildTaskProfile(input: TaskProfileInput): TaskProfile {
    const text = input.text ?? "";
    const trimmed = text.trim();
    const attachments = input.attachments ?? [];
    const signals: string[] = [];
    const fired = (signal: string) => {
        signals.push(signal);
        return true;
    };

    const hasImageInput = attachments.some((attachment) => {
        const mediaType = attachment.mediaType ?? "";
        const name = attachment.name ?? "";
        return IMAGE_MEDIA.test(mediaType) || IMAGE_NAME.test(name);
    });
    const hasDocumentInput = attachments.some((attachment) => {
        const mediaType = attachment.mediaType ?? "";
        const name = attachment.name ?? "";
        // Checked after images so an `image/svg+xml` never counts as a
        // document as well, which would put a screenshot into the documents
        // kind and route it at a long-context model for no reason.
        if (IMAGE_MEDIA.test(mediaType) || IMAGE_NAME.test(name)) return false;
        return DOCUMENT_MEDIA.test(mediaType) || DOCUMENT_NAME.test(name);
    });
    if (hasImageInput) fired("attachment:image");
    if (hasDocumentInput) fired("attachment:document");

    // Three ways a turn can need the web, strongest first, and each records
    // which one it was. They are separate signals rather than one because
    // "the user turned search on", "the user asked for sources" and "this
    // wording sounds time-sensitive" are three different claims, and a
    // decision that cannot say which of them fired cannot be reviewed.
    //
    // An explicit setting beats every heuristic: the user said so.
    const explicitSearch = input.webSearchRequested === true;
    if (explicitSearch) fired("search:requested");
    // Stated intent, at any length. See the version note above for why the
    // length floor below must not apply here.
    const sourceIntent =
        !explicitSearch && hasExplicitSourceOrSearchIntent(trimmed);
    if (sourceIntent) fired("search:source-intent");
    // And the softer reading of wording that merely sounds time-sensitive,
    // which keeps its floor: a bare "오늘" is a guess about the turn, not a
    // request in it.
    const inferredSearch =
        !explicitSearch &&
        !sourceIntent &&
        suggestsRecentInformationNeeded(trimmed);
    if (inferredSearch) fired("search:recency-heuristic");

    const codeSignals = [
        CODE_FENCE.test(text) && fired("code:fence"),
        STACK_TRACE.test(text) && fired("code:stack-trace"),
        CODE_SHAPE.test(text) && fired("code:shape"),
        CODE_WORDS.test(trimmed) && fired("code:vocabulary"),
    ].filter(Boolean).length;

    // The same predicate as the source-intent signal above, deliberately: one
    // definition of "asked for sources", read by two independent axes. Sharing
    // the *reading* is not collapsing the axes -- `kind` says what shape of
    // work this is and `needsCurrentInformation` says whether it needs the
    // web, and the tests below hold a turn that has one without the other.
    const researchSignals = [
        hasExplicitSourceOrSearchIntent(trimmed) && fired("research:vocabulary"),
        explicitSearch && fired("research:search-requested"),
    ].filter(Boolean).length;

    const documentSignals = [
        hasDocumentInput && fired("documents:attachment"),
        DOCUMENT_WORDS.test(trimmed) && fired("documents:vocabulary"),
    ].filter(Boolean).length;

    const translationSignals = TRANSLATION_WORDS.test(trimmed)
        ? Number(fired("multilingual:vocabulary"))
        : 0;

    const writingSignals = WRITING_WORDS.test(trimmed)
        ? Number(fired("writing:vocabulary"))
        : 0;

    // Strongest evidence first. Code shape is the least ambiguous thing a turn
    // can contain, and a document actually attached is a fact rather than a
    // reading of intent.
    let kind: TaskKind = "general";
    let matched = 0;
    if (codeSignals > 0) {
        kind = "coding";
        matched = codeSignals;
    } else if (documentSignals > 0) {
        kind = "documents";
        matched = documentSignals;
    } else if (translationSignals > 0) {
        kind = "multilingual";
        matched = translationSignals;
    } else if (researchSignals > 0) {
        kind = "research";
        matched = researchSignals;
    } else if (writingSignals > 0) {
        kind = "writing";
        matched = writingSignals;
    }

    const kindConfidence: TaskConfidenceBand =
        matched === 0 ? "none" : matched >= 2 ? "strong" : "weak";

    let expectedOutputLength: ExpectedOutputLength = "medium";
    // Short wins a tie: over-reserving output tokens on a turn that asked for
    // one line costs the account credits it did not need to spend, and the
    // opposite mistake is recoverable by the user asking for more.
    if (SHORT_OUTPUT.test(trimmed)) {
        expectedOutputLength = "short";
        fired("length:short-requested");
    } else if (LONG_OUTPUT.test(trimmed)) {
        expectedOutputLength = "long";
        fired("length:long-requested");
    }

    const scripts: Array<"latin" | "cjk"> = [];
    // `CJK_CHARACTER_PATTERN` carries the global flag, so its lastIndex has to
    // be reset before each use or every second call answers about where the
    // previous one stopped.
    CJK_CHARACTER_PATTERN.lastIndex = 0;
    if (CJK_CHARACTER_PATTERN.test(text)) scripts.push("cjk");
    if (/[A-Za-z]/.test(text)) scripts.push("latin");

    return {
        version: TASK_PROFILE_VERSION,
        kind,
        kindConfidence,
        needsCurrentInformation: explicitSearch || sourceIntent || inferredSearch,
        hasImageInput,
        hasDocumentInput,
        expectedOutputLength,
        scripts,
        signals,
    };
}
