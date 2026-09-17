import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HELP_FLAG_KEYS, HELP_INTENT_IDS, HELP_INTENTS, resolveHelpDestination } from "../lib/helpNavigationIntents.ts";
import { settingsSectionHref } from "../lib/settingsNavigation.ts";
import { helpMatcherProblems, matchHelpQuestion } from "../lib/helpNavigationMatcher.ts";
import { answerHelpMatch, offerHelpDestination } from "../lib/helpNavigationAnswer.ts";
import { expectedOf, sameOutcome, scoreHelpMatcher } from "../scripts/score-help-nav-matcher.mjs";

/**
 * HELP-NAV-01. The matcher is gated on the dev split it was tuned on. The
 * holdout split is scored by `npm run score:help-nav` and recorded in
 * docs/ops/help-nav/README.md; it is deliberately not a test, because a
 * failing holdout case fixed here would stop being a holdout case.
 */

const answerKey = JSON.parse(readFileSync("docs/ops/help-nav/answer-key.v2.json", "utf8"));
const dev = answerKey.cases.filter((entry) => entry.split === "dev");

const GUEST = { signedIn: false, enabledFlagKeys: new Set(), lang: "ko" };
const MEMBER = { signedIn: true, enabledFlagKeys: new Set(), lang: "ko" };

test("every dev case gets its expected outcome", () => {
    for (const entry of dev) {
        const actual = matchHelpQuestion(entry.question);
        assert.ok(
            sameOutcome(expectedOf(entry), actual),
            `${entry.id}: expected ${JSON.stringify(expectedOf(entry))}, got ${JSON.stringify(actual)}`
        );
    }
    const score = scoreHelpMatcher(dev);
    assert.equal(score.dev.passed, dev.length);
    assert.equal(score.dev.unsafe, 0);
});

test("the matcher's terms cover every registered intent and nothing else", () => {
    assert.deepEqual(helpMatcherProblems(), []);
});

test("a refusal wins over a keyword that would otherwise answer", () => {
    // "password" alone is the lock intent; a sign-in password is not a thing
    // Tomverse has, so the answer must not send the user to lock a conversation.
    assert.deepEqual(matchHelpQuestion("대화에 비밀번호 거는 법"), { outcome: "intent", intentId: "lock-or-share" });
    assert.deepEqual(matchHelpQuestion("로그인 비밀번호를 바꾸고 싶어요"), { outcome: "unsupported", reason: "sign-in-password" });
    assert.equal(matchHelpQuestion("관리자 페이지에서 모델 바꾸는 법").outcome, "unsupported");
    assert.equal(matchHelpQuestion("Show me what another user asked about models").outcome, "unsupported");
});

test("asking for any protected content to be read out is refused, not only conversations", () => {
    for (const question of [
        "Read the PDF I attached",
        "Summarize the memories you keep about me",
        "Show me my imported ChatGPT conversations",
        "Go through my draft and fix it",
        "첨부한 파일 내용 요약해 줘",
        "기억한 내용 알려줘",
        "가져온 대화 읽어줘",
    ]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "reads-content" }, question);
    }
});

test("how-to questions about the same content are still answered", () => {
    assert.deepEqual(matchHelpQuestion("How do I attach a PDF file?"), { outcome: "intent", intentId: "attach-files" });
    assert.deepEqual(matchHelpQuestion("How do I share a conversation with another person?"), {
        outcome: "intent",
        intentId: "lock-or-share",
    });
    assert.deepEqual(matchHelpQuestion("PDF 파일 첨부하는 방법"), { outcome: "intent", intentId: "attach-files" });
});

test("sign-in password questions are refused however they are spelled", () => {
    for (const question of [
        "How do I change my sign-in password?",
        "I forgot my password",
        "login password reset",
        "비밀번호를 잊어버렸어요",
    ]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "sign-in-password" }, question);
    }
    // A conversation lock password is a lock question.
    assert.deepEqual(matchHelpQuestion("대화 잠금 비밀번호를 잊어버렸어요"), { outcome: "intent", intentId: "lock-or-share" });
});

test("naming another person is not a refusal; asking what they wrote is", () => {
    assert.deepEqual(matchHelpQuestion("Tell me how to share a conversation with another person."), {
        outcome: "intent",
        intentId: "lock-or-share",
    });
    assert.equal(matchHelpQuestion("Show me what another user asked").outcome, "unsupported");
    assert.equal(matchHelpQuestion("How do I see other users' conversations?").outcome, "unsupported");
    assert.equal(matchHelpQuestion("다른 사용자 대화 보여줘").outcome, "unsupported");
});

test("a how-to in one sentence does not excuse a read request in the next", () => {
    assert.deepEqual(matchHelpQuestion("How do I attach a PDF? Also summarize the memories you keep about me."), {
        outcome: "unsupported",
        reason: "reads-content",
    });
    assert.deepEqual(matchHelpQuestion("PDF 첨부하는 방법 알려줘. 그리고 기억한 내용 알려줘"), {
        outcome: "unsupported",
        reason: "reads-content",
    });
});

test("sign-in and password in either order is refused", () => {
    for (const question of ["Can I sign in with a password?", "Is there a password for my account?", "비밀번호로 로그인할 수 있나요?"]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "sign-in-password" }, question);
    }
});

test("another person's content is refused whatever the word order", () => {
    for (const question of [
        "What did another user ask about models?",
        "Can I see what someone else wrote in their chat?",
        "Show me other users' questions",
        "How do I read another person's conversation?",
        "다른 사람이 물어본 질문 알려줘",
    ]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "reads-content" }, question);
    }
});

test("a how-to clause joined by a comma or 'and' does not excuse the next request", () => {
    assert.deepEqual(
        matchHelpQuestion("How do I attach a PDF, and please summarize the memories you keep about me now?"),
        { outcome: "unsupported", reason: "reads-content" }
    );
});

test("every password question is refused unless it names the conversation lock", () => {
    for (const question of [
        "Can I sign into Tomverse with a password?",
        "I keep logging in with a password, is that right?",
        "I forgot my password for Tomverse Chat",
        "What is my password?",
        "암호를 바꾸고 싶어요",
    ]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "sign-in-password" }, question);
    }
    for (const question of ["How do I put a password on a conversation?", "대화 잠금 비밀번호를 바꾸고 싶어요"]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "intent", intentId: "lock-or-share" }, question);
    }
    // Naming an account as well means it is not about the lock.
    assert.equal(matchHelpQuestion("Is the conversation lock password my account password?").outcome, "unsupported");
});

test("asking the assistant to work on one's content is refused even inside a how-to", () => {
    for (const question of ["How do I get you to summarize my attached PDF?", "Explain my uploaded PDF", "첨부한 문서 번역해 줘"]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "reads-content" }, question);
    }
    // Asking where a screen is stays navigation.
    assert.deepEqual(matchHelpQuestion("Show me the Memory settings"), { outcome: "intent", intentId: "manage-memory" });
});

test("sharing someone else's content is refused; sharing with someone is not", () => {
    assert.equal(matchHelpQuestion("How do I share another user's conversation?").outcome, "unsupported");
    assert.deepEqual(matchHelpQuestion("How do I share a conversation with someone else?"), {
        outcome: "intent",
        intentId: "lock-or-share",
    });
});

test("context from another clause still counts for the lock and one's own account", () => {
    assert.deepEqual(matchHelpQuestion("How do I lock a conversation and set a password?"), {
        outcome: "intent",
        intentId: "lock-or-share",
    });
    assert.deepEqual(matchHelpQuestion("How do I import conversations from my other account?"), {
        outcome: "intent",
        intentId: "imported-conversations",
    });
});

test("mentioning a conversation is not naming its lock", () => {
    assert.deepEqual(matchHelpQuestion("Where is the password I mentioned in this conversation?"), {
        outcome: "unsupported",
        reason: "sign-in-password",
    });
});

test("English import is matched as a word, not inside another word", () => {
    assert.notEqual(matchHelpQuestion("Which model is important for coding?").outcome, "clarify");
    assert.deepEqual(matchHelpQuestion("How do I import my ChatGPT history?"), {
        outcome: "intent",
        intentId: "imported-conversations",
    });
});

test("deleting data only asks which kind when no narrower owner is named", () => {
    assert.equal(matchHelpQuestion("제 데이터를 지워 주세요").outcome, "clarify");
    assert.equal(matchHelpQuestion("Delete all my data").outcome, "clarify");
    assert.notEqual(matchHelpQuestion("How do I delete data from a project?").outcome, "clarify");
});

test("every open offer's action is exactly what resolveHelpDestination returns", () => {
    const flagsOn = new Set(Object.values(HELP_FLAG_KEYS));
    for (const intent of HELP_INTENTS) {
        for (const viewer of [
            GUEST,
            MEMBER,
            { ...MEMBER, enabledFlagKeys: flagsOn },
            { ...GUEST, enabledFlagKeys: flagsOn, lang: "en" },
        ]) {
            const answer = answerHelpMatch({ outcome: "intent", intentId: intent.id }, viewer);
            assert.equal(answer.offers.length, intent.destinations.length, intent.id);
            answer.offers.forEach((offer, index) => {
                const destination = intent.destinations[index];
                assert.deepEqual(offer.destination, destination, intent.id);
                const missing = destination.access.flagKeys.filter((key) => !viewer.enabledFlagKeys.has(key));
                const expected =
                    missing.length > 0
                        ? "unavailable"
                        : destination.access.signIn === "required" && !viewer.signedIn
                          ? "sign-in"
                          : "open";
                assert.equal(offer.availability, expected, `${intent.id} ${destination.kind}`);
                if (offer.availability === "open") {
                    assert.deepEqual(offer.action, resolveHelpDestination(destination, viewer.lang));
                } else {
                    assert.equal("action" in offer, false);
                }
            });
        }
    }
});

test("a refusal offered as a choice counts as unsafe in the score", () => {
    const cases = [{ id: "x", split: "dev", question: "q", unsupported: true }];
    const score = scoreHelpMatcher(cases, () => ({ outcome: "clarify", intentIds: ["manage-memory", "projects"] }));
    assert.equal(score.dev.unsafe, 1);
});

test("an empty or punctuation-only question is unsupported, not a guess", () => {
    for (const question of ["", "   ", "???", "!!"]) {
        assert.deepEqual(matchHelpQuestion(question), { outcome: "unsupported", reason: "no-intent" });
    }
});

test("an outcome names registered ids and never carries the question", () => {
    for (const entry of answerKey.cases) {
        const match = matchHelpQuestion(entry.question);
        const serialised = JSON.stringify(match);
        assert.equal(serialised.includes(entry.question), false, entry.id);
        if (match.outcome === "intent") assert.ok(HELP_INTENT_IDS.includes(match.intentId), entry.id);
        if (match.outcome === "clarify") {
            for (const id of match.intentIds) assert.ok(HELP_INTENT_IDS.includes(id), entry.id);
        }
    }
});

test("a guest is offered sign-in for an account destination, never an upgrade", () => {
    const answer = answerHelpMatch({ outcome: "intent", intentId: "manage-memory" }, GUEST);
    assert.equal(answer.outcome, "intent");
    assert.deepEqual(answer.offers.map((offer) => offer.availability), ["sign-in"]);
    assert.equal("action" in answer.offers[0], false);
});

test("a member is given the settings link the rest of the app uses", () => {
    const answer = answerHelpMatch({ outcome: "intent", intentId: "manage-memory" }, MEMBER);
    assert.equal(answer.offers[0].availability, "open");
    assert.equal(answer.offers[0].action.type, "href");
    assert.equal(answer.offers[0].action.href, settingsSectionHref("memory"));
});

test("a destination whose flag is off is unavailable, even for a guest", () => {
    // Existence before entitlement: signing in would not make it exist.
    const importIntent = answerHelpMatch({ outcome: "intent", intentId: "imported-conversations" }, GUEST);
    assert.equal(importIntent.offers[0].availability, "unavailable");
    assert.deepEqual(importIntent.offers[0].missingFlagKeys, [HELP_FLAG_KEYS.externalImport]);
    assert.deepEqual(importIntent.steps, [
        { label: "import", available: false },
        { label: "continue", available: false },
    ]);

    const importOnly = { ...MEMBER, enabledFlagKeys: new Set([HELP_FLAG_KEYS.externalImport]) };
    const partly = answerHelpMatch({ outcome: "intent", intentId: "imported-conversations" }, importOnly);
    assert.equal(partly.offers[0].availability, "open");
    assert.deepEqual(partly.steps, [
        { label: "import", available: true },
        { label: "continue", available: false },
    ]);
});

test("a mixed intent offers each destination on its own access", () => {
    const answer = answerHelpMatch({ outcome: "intent", intentId: "credits-and-plan" }, GUEST);
    assert.deepEqual(answer.offers.map((offer) => [offer.destination.kind, offer.availability]), [
        ["settings-tab", "sign-in"],
        ["guide-section", "open"],
        ["public-route", "open"],
    ]);
    assert.ok(answer.forbidden.has("purchase"));
});

test("an unsupported question gets only the help centre and the feedback dialog", () => {
    const answer = answerHelpMatch({ outcome: "unsupported", reason: "no-intent" }, GUEST);
    assert.deepEqual(
        answer.offers.map((offer) => offer.action),
        [
            { type: "href", href: "/support/help-centre?lang=ko" },
            { type: "open-feedback" },
        ]
    );
});

test("a clarify answer passes the two intents through and offers nothing yet", () => {
    const answer = answerHelpMatch({ outcome: "clarify", intentIds: ["manage-memory", "export-or-delete-account-data"] }, MEMBER);
    assert.deepEqual(answer, { outcome: "clarify", intentIds: ["manage-memory", "export-or-delete-account-data"] });
});

test("an offer resolves only registered destination kinds", () => {
    const offer = offerHelpDestination(
        { kind: "guide-section", section: "projects", access: { signIn: "not-required", flagKeys: [], plan: "not-gated" } },
        { ...GUEST, lang: "en" }
    );
    assert.equal(offer.availability, "open");
    assert.equal(offer.action.type, "href");
});
