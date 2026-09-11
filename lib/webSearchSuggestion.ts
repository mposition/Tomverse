// Pure, local heuristics for "does this turn want the web?" -- deliberately not
// a model call: no extra cost or latency, and they are described to the user as
// simple heuristics, not an intelligent classifier.
//
// Two questions, two functions, and they are not the same question.
//
// `hasExplicitSourceOrSearchIntent` asks whether the person *said* they want
// sources, citations or a search. It has no length floor, because "출처" is a
// complete request and its length says nothing about how sure we are.
//
// `suggestsRecentInformationNeeded` asks the softer question -- does the
// wording merely suggest the answer has to be fresh -- and keeps a four
// character floor, because a bare "오늘" under a moving cursor is a guess
// about a half-typed word rather than a statement of intent.
//
// They were one function, and the routing path reused it. That put a
// typing-time floor -- an anti-nagging rule -- inside a safety boundary: the
// task profile's `needsCurrentInformation` drives the Router's web-search hard
// filter, so a two-character request for sources produced `false`, the filter
// never ran, and a model with no search path stayed eligible for a turn that
// had asked for sources. Splitting them is what keeps a UI comfort rule out of
// a capability decision. Whether a *selected* model then really searches is a
// separate check again, at dispatch: see
// `docs/policy/tomverse-chat-router-score-policy.md` §8.
//
// A third function used to live here, `suggestsWebSearchInComposer`, together
// with a `draftSuggestionKey` for de-duplicating its nudge. Both belonged to
// the composer's "auto" mode -- offer a search before running one -- and went
// with it when web search became a switch: the switch is the consent, so there
// is nothing left to offer mid-draft. The Router-side contextual reading below
// is versioned with the task profile; the model finder's recommendation regex
// remains unchanged because that questionnaire is a different consumer.
import { RESEARCH_PATTERN } from "@/lib/modelFinder";

const RECENCY_KEYWORDS = [
  // Korean
  "오늘", "어제", "최신", "현재", "지금", "이번 주", "이번주", "이번 달", "이번달",
  "요즘", "실시간", "속보", "최근", "환율", "주가", "시세", "날씨",
  // English
  "today", "yesterday", "latest", "current", "currently", "this week",
  "this month", "right now", "recent", "recently", "breaking", "live",
  "exchange rate", "stock price", "weather forecast", "news",
];

// A bare year (e.g. "2026") is only a signal alongside other context --
// matched separately so it never fires alone on something like "iPhone 15".
const RECENT_YEAR_PATTERN = /\b20(2[4-9]|3[0-9])\b/;

const PROVIDED_RECORD_CONTEXT =
  /\b(?:synthetic|provided|supplied|given|following)\s+(?:[\w-]+\s+){0,3}(?:records?|register|rows?|cards?|data|table)\b|\b(?:records?|rows?|data|table)\s+(?:below|above)\b|(?:제공된|주어진|아래|다음)\s*(?:기록|자료|표|데이터|목록)/i;
const EXTERNAL_REQUEST_CONTEXT =
  /\b(?:online|web(?:site)?|internet|official|external|search|look\s+up|check|verify)\b|검색|인터넷|공식|외부|조회/i;

/**
 * Remove only incidental source-order spans, never an entire "closed book"
 * turn. Matching source order is not asking for sources; a separate source
 * request must remain visible even in the same sentence. Spaces preserve offsets.
 */
const withoutIncidentalSourceCues = (text: string): string => {
  const blank = (match: string) => " ".repeat(match.length);
  // Spaces/tabs or one adjacent compound hyphen, never a clause-separating
  // dash, repeated hyphens, or a line break between "source" and "order".
  return text
    .replace(/\bsource(?:['’]s)?(?:[ \t]+|-)(?:order(?:ing)?|sequence)\b/gi, blank)
    .replace(/\b(?:order|sequence)[ \t]+(?:in|of)[ \t]+(?:the[ \t]+)?(?:original[ \t]+)?source\b/gi, blank);
};

// Marked current fields, provided-record readings and directly forbidden
// date cues are recency concerns, independent of the source-only pass above.
// No turn text is cached or shared across calls; original length thresholds stay.
const withoutIncidentalRecencyCues = (text: string): string => {
  const blank = (match: string) => " ".repeat(match.length);
  const blankCurrent = (match: string) => match.replace(/\bcurrent\b/gi, blank);
  const providedRecords = PROVIDED_RECORD_CONTEXT.test(text);
  let reading = text
    // A complete boolean value must end at a field boundary, not the start
    // of prose such as "true cost" or a hyphenated word such as "no-claims".
    .replace(/\bcurrent(?=["'`]?[ \t]*[:=][ \t]*["'`]?(?:yes|no|true|false)["'`]?[ \t]*(?:[,;.:}\]\r\n]|$))/gi, blank)
    .replace(/\b(?:marked|flagged)[ \t]+current(?=[ \t]+["'`]?(?:yes|no|true|false)["'`]?[ \t]*(?:[,;.:}\]\r\n]|$))/gi, blankCurrent)
    .replace(/현재(?=[ \t]*(?:여부|표시)?[ \t]*[:=][ \t]*["'`]?(?:예|아니오|참|거짓)["'`]?[ \t]*(?:[,;.:}\]\r\n]|$))/g, blank);

  if (providedRecords) {
    // Bare values additionally require local field syntax or the record's
    // "has current no" predicate. A provided table elsewhere in the turn
    // never licenses removing "current true cost" from a separate question.
    reading = reading
      .replace(/(?:^|[{:;,\r\n])[ \t]*(?:(?:prior|previous|historical)[ \t]+)?["'`]?current(?=["'`]?[ \t]+["'`]?(?:yes|no|true|false)["'`]?[ \t]*(?:[,;.:}\]\r\n]|$))/gi, blankCurrent)
      .replace(/\bhas[ \t]+current(?=[ \t]+["'`]?(?:yes|no|true|false)["'`]?[ \t]*(?:[,;.:}\]\r\n]|$))/gi, blankCurrent);
  }

  // Negation stays within its clause. In particular, "but" starts a fresh
  // reading; it cannot hide an affirmative request following the prohibition.
  return reading.split(/([.!?;\n]|\b(?:but|however|instead)\b|하지만|그러나|대신)/i)
    .map((clause) => {
      // A data-reading verb is not enough when its clause also asks to go
      // outside the supplied records. Prefer retaining an ambiguous web cue.
      // Only a clause-leading imperative can inherit the provided records as
      // its subject. "For another application, return the current version"
      // and an explicit "version of/for ..." introduce a separate subject.
      if (providedRecords && !EXTERNAL_REQUEST_CONTEXT.test(clause)) {
        clause = clause
          .replace(/^\s*(?:please\s+)?(?:extract|return|copy|select|choose|read)\s+(?:(?:only|just)\s+)?(?:the\s+)?current\s+(?:record|version|row|entry)\b(?!\s+(?:of|for)\b)|\b(?:recorded|listed|shown|stored)\s+(?:in|on)\s+(?:the\s+)?current\s+(?:record|version|row|entry)\b(?!\s+(?:of|for)\b)/gi,
            (match) => match.replace(/\bcurrent\b/gi, blank))
          .replace(/^\s*현재\s*(?:기록|버전|행|항목)(?:만|을|를)?\s*(?:추출|반환|복사|선택)|현재\s*(?:기록|버전|행|항목)에\s*(?:있는|기록된|표시된)/g,
            (match) => match.replace(/현재/g, blank));
      }
      // Require a directly forbidden verb, or the final verb of an explicit
      // comma-separated "or" prohibition list. "Do not forget to use today" is
      // affirmative, as is a Korean date clause followed by an unrelated ban.
      // An "and" anywhere in that list can start affirmative coordination;
      // retain its cue rather than guessing the scope of the earlier negation.
      // At most four preceding items, each with at most 80 trailing characters:
      // scanning an unbounded suffix for every "do not" is quadratic on long
      // text without commas. Longer/ambiguous lists retain their recency cue.
      return clause.replace(/\b(?:do\s+not|don['’]t|never)\s+(?:(?:(?:search|use|read|open|execute|consult|infer|assume)\b[^,.!?;\n]{0,80},\s*){1,4}or\s+)?(?:use|infer|assume|consult)\s+today(?:['’]s)?(?:\s+date)?\b/gi,
        (match) => /\band\b/i.test(match) ? match : match.replace(/\btoday\b/gi, blank))
      .replace(/오늘\s*(?:의\s*)?(?:날짜|기준|시점)(?:(?:나|와|과|및)\s*(?:실제\s*)?(?:달력|날짜)(?:\s*지식)?)?(?:은|는|을|를|도)?\s*(?:사용|쓰|추론|가정|참고)(?:하)?지\s*(?:마|말)/g,
        (match) => match.replace(/오늘/g, blank));
    })
    .join("");
};

/**
 * The person asked for sources, citations, research or a web search.
 *
 * No length floor and no upper bound: this is a statement of intent, not a
 * guess from context, so its strength does not depend on how much else was
 * typed. Used for routing and capability decisions, where treating a short
 * request as no request is a safety hole rather than a quiet UI.
 */
export const hasExplicitSourceOrSearchIntent = (text: string): boolean =>
  RESEARCH_PATTERN.test(withoutIncidentalSourceCues(text.trim()));

/**
 * Softer wording that only *suggests* the answer needs to be fresh.
 *
 * Keeps its floor wherever it is used, including on the routing path. A bare
 * "오늘" is ambiguous in a way "출처" is not -- it is a guess about what the
 * turn needs rather than something the person asked for -- so it stays a
 * suggestion, and widening it is a separate decision with its own evidence.
 */
export const suggestsRecentInformationNeeded = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 4) return false;
  const reading = withoutIncidentalRecencyCues(normalized);

  const hasKeyword = RECENCY_KEYWORDS.some((keyword) =>
    reading.includes(keyword.toLowerCase())
  );
  if (hasKeyword) return true;

  return RECENT_YEAR_PATTERN.test(reading) && normalized.length <= 200;
};
