/**
 * HELP-NAV-01: matches a "how do I ..." question to one registered help intent,
 * without calling any model.
 *
 * Three outcomes, the same three the answer key uses
 * (docs/ops/help-nav/answer-key.v2.json):
 *
 * - `intent`: one intent clearly fits.
 * - `clarify`: two intents fit equally well, so the answer asks which one
 *   rather than guessing. Only ever the top two.
 * - `unsupported`: nothing fits, or the question asks for something the help
 *   assistant must never do (read someone's conversation, open admin pages,
 *   manage a sign-in password Tomverse does not have). Those are refused
 *   before any intent is scored, so a keyword such as "password" cannot turn
 *   a refusal into an answer.
 *
 * ## How the rules were made
 *
 * Tuned on the answer key's `dev` split only. The `holdout` split was not read
 * while writing them and is used only by `scripts/score-help-nav-matcher.mjs`
 * to report how the rules do on questions they were not written for.
 *
 * Terms are regular expressions over a normalised question (NFKC, lower case,
 * punctuation to spaces). Korean is matched on stems rather than tokens --
 * "가져오" matches 가져오기 and 가져오려면 -- because the question is not
 * morphologically analysed. A specific term weighs 3, a supporting one 1 or 2.
 *
 * Nothing here reads, stores or logs the question. The caller passes a string
 * and gets an outcome naming registered ids.
 */

import { HELP_INTENT_IDS } from "@/lib/helpNavigationIntents";

export const HELP_NAVIGATION_MATCHER_VERSION = "help-nav-matcher-v1";

export type HelpUnsupportedReason =
    /** Asks the assistant to read or show conversation content, its own or anyone's. */
    | "reads-content"
    /** Asks for administrator pages or powers. */
    | "admin"
    /** Sign-in passwords: accounts sign in with Google, Microsoft or an email code. */
    | "sign-in-password"
    /** No registered intent fits. */
    | "no-intent";

export type HelpMatch =
    | { outcome: "intent"; intentId: string }
    | { outcome: "clarify"; intentIds: [string, string] }
    | { outcome: "unsupported"; reason: HelpUnsupportedReason };

type WeightedTerm = readonly [pattern: RegExp, weight: number];

const REFUSALS: ReadonlyArray<readonly [RegExp, HelpUnsupportedReason]> = [
    // Anyone else's content. Refused by default whenever another person is
    // named; the exceptions, below, are sharing *with* someone and the
    // viewer's own other account. Listing the ways to ask ("what did another
    // user ask", "what another user asked", ...) was tried and every list had
    // another phrasing.
    [
        /\b(another|other|someone|somebody|anyone)( else'?s?)? (users?|person|people|accounts?|members?)\b|\b(someone|somebody|anyone) else\b|\bother users'?|다른 (사용자|사람|유저|계정|회원)/,
        "reads-content",
    ],
    // The viewer's own content read back or worked on: conversations, files
    // and attachments, Memory, imports, drafts.
    [
        /\b(read|summari[sz]e|show me|tell me|go through|look (at|through)|explain|analy[sz]e|translate|review|describe|check|extract|quote)\b.*\b(conversations?|chats?|messages?|pdfs?|files?|attachments?|attached|uploaded|documents?|memor(y|ies)|remember(ed|s)?|imported|imports?|drafts?)\b|(대화|메시지|첨부|파일|pdf|문서|기억|메모리|가져온|초안)\S*( \S+){0,3} ?(읽어|요약해|요약 해|보여 ?줘|보여 ?주세요|알려 ?줘|알려 ?주세요|뭐라고|설명해|분석해|번역해|검토해)/,
        "reads-content",
    ],
    [/\badmin|administrator|관리자/, "admin"],
    // Passwords. Tomverse accounts sign in without one, and the only password
    // in the product locks a conversation. So every password question is
    // refused unless the question names that lock, and never when it also
    // names signing in or an account.
    [/password|passcode|비밀번호|암호/, "sign-in-password"],
];

/** "How do I ..." asks for directions, not for content to be read out. */
const HOW_TO = /\bhow (do|can|to|should|would)\b|어떻게|방법/;
/** Asks the assistant itself to act ("get you to summarise ..."), which no how-to excuses. */
const ASKS_ASSISTANT = /\b(get|have|make|want|ask) you to\b|\b(can|could|would|will) you\b|\bplease\b|해 ?줘|해 ?주세요|해 ?줄래/;
/** Asks where a settings page or screen is, which is navigation, not reading. */
const NAVIGATION = /\bsettings?\b|\bpage\b|\bscreen\b|\bmenu\b|\bwhere\b|설정|페이지|화면|메뉴|어디/;
/** The conversation lock, named. Not "conversation" alone, and not "chat", the product's name. */
const CONVERSATION_LOCK =
    /\block(ed|ing|s)?\b|잠금|잠그|잠가|password (on|for|to) (a |the |my |this |that )?conversation|conversation password|대화(에|의)? ?비밀번호/;
const NAMES_ACCOUNT = /\b(log|sign)(s|ged|ging|ing|ed)?[ -]?(in|into|on)\b|\blogin\b|로그인|계정|\baccounts?\b/;
/** Sharing with someone, as opposed to sharing someone's content. */
const SHARING_WITH = /\bshar(e|es|ed|ing)\b.*\b(with|to) (another|other|someone|somebody|anyone)\b|(다른 (사용자|사람|유저|회원))(에게|한테|과|와|이랑|하고) ?공유/;
/** The viewer's own other account. */
const OWN_OTHER_ACCOUNT = /\bmy (other|another|second|old|previous) accounts?\b|(내|제|저의|나의) (다른|예전|이전) 계정/;

/**
 * Judged one clause at a time, so a how-to in one clause cannot excuse a
 * request to read something out in the next ("How do I attach a PDF, and
 * summarise my memories"). What a clause is about can live in another clause,
 * so exceptions that need context (a lock, sharing with someone, one's own
 * account) read the whole question.
 */
const clausesOf = (question: string) =>
    question
        .split(/[.?!;,\n]+|\b(?:and|also|then|plus|but)\b|그리고|또한|그리고요|하고/i)
        .map((clause) => normalise(clause ?? ""))
        .filter(Boolean);

const refusedBy = (reason: HelpUnsupportedReason, clause: string, pattern: RegExp, whole: string) => {
    if (reason === "reads-content" && pattern === REFUSALS[0][0]) {
        if (OWN_OTHER_ACCOUNT.test(whole) && !/(users?|person|people|members?|사용자|사람|유저|회원)/.test(clause)) return false;
        // Possessive ("another user's conversation") is someone's content even
        // when the verb is share.
        if (/'s\b|의 /.test(clause)) return true;
        return !(HOW_TO.test(whole) && SHARING_WITH.test(whole));
    }
    if (reason === "reads-content") {
        if (ASKS_ASSISTANT.test(clause)) return true;
        if (NAVIGATION.test(clause) && !/\b(read|summari[sz]e|explain|analy[sz]e|translate)\b|읽어|요약|설명해|분석해|번역해/.test(clause)) {
            return false;
        }
        return !HOW_TO.test(clause);
    }
    if (reason === "sign-in-password") return !(CONVERSATION_LOCK.test(whole) && !NAMES_ACCOUNT.test(whole));
    return true;
};

const TERMS: Readonly<Record<string, readonly WeightedTerm[]>> = {
    "imported-conversations": [
        [/가져오|가져와|불러오|\bimport(s|ed|ing)?\b/, 3],
        [/이어가|이어서|이어 (하|가)|continue/, 2],
        [/다른 ?ai|chatgpt|gpt에서|gemini|claude에서|another ai|other ai/, 3],
        [/대화 ?기록|chat history|conversation history/, 1],
    ],
    "manage-memory": [
        [/메모리|memory|memories/, 3],
        [/기억|remember/, 3],
    ],
    "choose-models": [
        [/모델|models?\b/, 3],
        [/나란히|side by side|several|여러/, 2],
        [/비교|compare/, 1],
    ],
    "ai-review": [
        [/교차 ?검토|교차 ?검증|ai ?review|cross.?check|cross.?review/, 3],
        [/검토|review/, 1],
    ],
    "attach-files": [
        [/첨부|attach|upload|업로드/, 3],
        [/파일|files?\b|pdf|엑셀|excel|word|이미지|image/, 2],
        [/드라이브|drive/, 3],
    ],
    "projects": [
        [/프로젝트|projects?\b/, 3],
        [/폴더|folders?\b/, 3],
        [/묶|group|organi[sz]e/, 2],
    ],
    "lock-or-share": [
        [/잠금|잠그|잠가|lock/, 3],
        [/비밀번호|password/, 3],
        [/공유|share|sharing/, 3],
    ],
    "credits-and-plan": [
        [/크레딧|credits?\b/, 3],
        [/요금제|플랜|plans?\b|pricing|구독|subscription|upgrade|업그레이드/, 3],
        [/가격|price|충전|top.?up/, 2],
        // "요금" alone is about money in general, not the plan specifically.
        [/요금(?!제)|cost|fees?\b/, 2],
    ],
    "billing-and-refund": [
        [/환불|refund/, 3],
        [/결제|청구|영수증|billing|invoice|receipt|charged?\b|payment/, 3],
        [/요금(?!제)|cost|fees?\b/, 2],
    ],
    "email-notifications": [
        [/이메일|메일|e-?mail|newsletter|뉴스레터/, 3],
        [/알림|수신|구독 ?취소|unsubscribe|notifications?\b/, 2],
        [/광고|marketing|promotions?\b/, 1],
    ],
    "export-or-delete-account-data": [
        [/내보내|export|다운로드|download/, 3],
        [/탈퇴|계정(을|를)? ?삭제|delete (my )?account|close (my )?account/, 3],
        [/(내|제|my) ?데이터|all (my )?data/, 2],
    ],
    "report-a-problem": [
        [/오류|에러|error|버그|bug/, 3],
        [/안 ?나와|안 ?나오|안 ?돼|안 ?되|작동(하지|을| 안)|not working|broken|doesn'?t work|멈춰|멈췄/, 3],
        [/신고|report|문제|problem/, 2],
    ],
};

/*
 * Two cases the answer key marks as genuinely ambiguous, and why a score tie
 * would not reliably find them:
 *
 * - Deleting "my data" without saying which: what the account remembers and
 *   the account itself are both data, and deleting the wrong one cannot be
 *   undone, so the answer asks.
 */
const AMBIGUOUS: ReadonlyArray<readonly [RegExp, [string, string], RegExp]> = [
    [
        // "My data" or "all data" -- no narrower owner named.
        /((내|제|저의|나의) ?데이터|\b(my|all( of)?( my)?) data\b).*(지워|지우|삭제|없애|delete|erase|remove|wipe)|(지워|지우|삭제|delete|erase|remove|wipe).*((내|제|저의|나의) ?데이터|\b(my|all( of)?( my)?) data\b)/,
        ["manage-memory", "export-or-delete-account-data"],
        // Unless the question already said which, or named something narrower.
        /기억|메모리|memory|탈퇴|계정|account|다운로드|download|내보내|export|프로젝트|project|대화|conversation|파일|file/,
    ],
];

const normalise = (question: string) =>
    question
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}'.-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

const scoreIntent = (text: string, terms: readonly WeightedTerm[]) =>
    terms.reduce((total, [pattern, weight]) => total + (pattern.test(text) ? weight : 0), 0);

/** The smallest score that counts as a match at all. */
const MIN_SCORE = 2;

export const matchHelpQuestion = (question: string): HelpMatch => {
    const text = normalise(question);
    if (!text) return { outcome: "unsupported", reason: "no-intent" };

    for (const clause of clausesOf(question)) {
        for (const [pattern, reason] of REFUSALS) {
            if (pattern.test(clause) && refusedBy(reason, clause, pattern, text)) return { outcome: "unsupported", reason };
        }
    }
    for (const [pattern, intentIds, unless] of AMBIGUOUS) {
        if (pattern.test(text) && !unless.test(text)) return { outcome: "clarify", intentIds };
    }

    const ranked = HELP_INTENT_IDS.map((intentId) => ({
        intentId,
        score: scoreIntent(text, TERMS[intentId] ?? []),
    }))
        .filter((entry) => entry.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) return { outcome: "unsupported", reason: "no-intent" };
    const [first, second] = ranked;
    if (second && second.score === first.score) {
        return { outcome: "clarify", intentIds: [first.intentId, second.intentId] };
    }
    return { outcome: "intent", intentId: first.intentId };
};

/** Every intent the matcher can produce has terms, and no terms name an unregistered intent. */
export const helpMatcherProblems = (): string[] => {
    const problems: string[] = [];
    for (const id of HELP_INTENT_IDS) if (!TERMS[id]?.length) problems.push(`${id}: no terms`);
    for (const id of Object.keys(TERMS)) if (!HELP_INTENT_IDS.includes(id)) problems.push(`${id}: not a registered intent`);
    for (const [, intentIds] of AMBIGUOUS) {
        for (const id of intentIds) if (!HELP_INTENT_IDS.includes(id)) problems.push(`${id}: ambiguous pair names an unregistered intent`);
    }
    return problems;
};
