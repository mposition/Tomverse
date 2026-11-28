import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { QuizView } from "@/components/chat/ChatQuiz";
import { FlashcardsView } from "@/components/chat/ChatFlashcards";
import { StudyModeChip, StudyModeRow } from "@/components/chat/StudyModeControls";
import type { Message } from "@/components/chat/types";
import { FIRST_CARD, emptyQuizAnswers, flipCard, parseFlashcardSpec, parseQuizSpec, pickQuizOption } from "@/lib/chatStudy";
import { chatStudyCopy } from "@/locales/chatStudy";

const question: Message = { id: "u1", role: "user", content: "Question" };
const answerWith = (content: string): Message => ({
  id: "a1",
  role: "assistant",
  modelId: "gpt-5-6-luna",
  status: "normal",
  content,
});

type ListProps = Partial<React.ComponentProps<typeof ChatMessageList>>;
const render = (messages: Message[], props: ListProps = {}, lang: "en" | "ko" = "en") =>
  renderToStaticMarkup(
    <SessionProvider session={null}>
      <LanguageProvider initialLang={lang}>
        <ChatMessageList messages={messages} currentChatId="c1" {...props} />
      </LanguageProvider>
    </SessionProvider>
  );

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
const block = (language: string, spec: object) => ["```" + language, JSON.stringify(spec), "```"].join("\n");

const quizSpec = {
  title: "Fractions",
  questions: [
    { question: "What is 1/2 + 1/4?", options: ["3/4", "2/6", "1/8"], answer: 0, explanation: "1/2 is 2/4." },
    { question: "What is 1/3 of 9?", options: ["2", "3", "6"], answer: 1, explanation: "9 divided by 3." },
  ],
};
const cardSpec = { title: "French", cards: [{ front: "bonjour", back: "hello" }, { front: "merci", back: "thanks" }] };

/* ------------------------------------------------- blocks in an answer */

test("a finished answer's quiz block is drawn as a quiz, in Korean too", () => {
  const html = render([question, answerWith(block("quiz", quizSpec))]);
  assert.match(html, /data-testid="chat-quiz"/);
  assert.equal(count(html, /data-testid="chat-quiz-question"/g), 2);
  assert.equal(count(html, /data-testid="chat-quiz-option"/g), 6);
  assert.match(html, /aria-label="Quiz: Fractions"/);
  assert.match(html, /0 of 2 answered/);
  // The ordinary code block is not drawn as well.
  assert.ok(!html.includes("chat-code-copy-button"));
  const ko = render([question, answerWith(block("quiz", quizSpec))], {}, "ko");
  assert.match(ko, /aria-label="퀴즈: Fractions"/);
  assert.match(ko, /2문항 중 0문항 풀었습니다/);
});

test("a finished answer's flashcards block is drawn as a deck", () => {
  const html = render([question, answerWith(block("flashcards", cardSpec))]);
  assert.match(html, /data-testid="chat-flashcards"/);
  assert.match(html, /data-face="front"/);
  assert.match(html, /bonjour/);
  assert.ok(!html.includes("hello"), "the back is not shown until the card is turned");
  assert.match(html, /Card 1 of 2/);
  assert.match(render([question, answerWith(block("flashcards", cardSpec))], {}, "ko"), /2장 중 1번째 카드/);
});

test("study blocks are code while the answer streams, and when their spec is invalid", () => {
  const streaming = render([question, answerWith(block("quiz", quizSpec))], { isSending: true });
  assert.ok(!streaming.includes("chat-quiz"));
  assert.match(streaming, /data-testid="chat-code-copy-button"/);
  const streamingCards = render([question, answerWith(block("flashcards", cardSpec))], { isSending: true });
  assert.ok(!streamingCards.includes("chat-flashcards"));

  const invalidQuiz = render([question, answerWith(block("quiz", { questions: [{ question: "Q", options: ["a", "b"], answer: 5 }] }))]);
  assert.ok(!invalidQuiz.includes('data-testid="chat-quiz"'));
  assert.match(invalidQuiz, /data-testid="chat-code-copy-button"/);
  const invalidCards = render([question, answerWith(block("flashcards", { cards: [{ front: "a" }] }))]);
  assert.ok(!invalidCards.includes('data-testid="chat-flashcards"'));
  // Over a limit is invalid too, never cut.
  const tooMany = { questions: Array.from({ length: 21 }, () => quizSpec.questions[0]) };
  assert.ok(!render([question, answerWith(block("quiz", tooMany))]).includes('data-testid="chat-quiz"'));
});

test("a user's own message is never drawn as a quiz", () => {
  const html = render([{ id: "u1", role: "user", content: block("quiz", quizSpec) }]);
  assert.ok(!html.includes("chat-quiz"));
});

/* ------------------------------------------------------------- quiz view */

const copy = chatStudyCopy.en;
const noop = () => undefined;
const quizHtml = (answers: (number | null)[], lang = copy) =>
  renderToStaticMarkup(
    <QuizView spec={parseQuizSpec(JSON.stringify(quizSpec))!} answers={answers} copy={lang} onPick={noop} onRetry={noop} onExplain={noop} />
  );

test("an unanswered quiz offers every option and shows no result yet", () => {
  const html = quizHtml([null, null]);
  assert.equal(count(html, /data-state="open"/g), 6);
  assert.ok(!html.includes("aria-disabled"));
  assert.ok(!html.includes("chat-quiz-score"));
  assert.match(html, /<div role="status" aria-live="polite" data-testid="chat-quiz-feedback"[^>]*><\/div>/);
});

test("an answered question says right or wrong in words, locks, and gives the reason", () => {
  const spec = parseQuizSpec(JSON.stringify(quizSpec))!;
  const answers = pickQuizOption(spec, emptyQuizAnswers(spec), 0, 1);
  const html = quizHtml([...answers]);
  // Question one: picked B (wrong), A is the answer. Marked by text, not colour alone.
  assert.match(html, /Not quite\. The correct answer is A\. 3\/4/);
  assert.match(html, /Correct answer/);
  assert.match(html, /Your answer/);
  assert.match(html, /1\/2 is 2\/4\./);
  assert.equal(count(html, /data-state="correct"/g), 1);
  assert.equal(count(html, /data-state="wrong"/g), 1);
  // Question one's options all ignore a second press; question two is still open.
  assert.equal(count(html, /aria-disabled="true"/g), 3);
  assert.equal(count(html, /data-state="open"/g), 3);
  assert.match(html, /1 of 2 answered/);
});

test("a finished quiz shows the score, and offers the missed ones only when there are some", () => {
  const missed = quizHtml([1, 1]);
  assert.match(missed, /data-testid="chat-quiz-score"[^>]*>Score: 1 of 2/);
  assert.match(missed, /data-testid="chat-quiz-explain"/);
  assert.match(missed, /Explain the ones I missed/);
  assert.match(missed, /data-testid="chat-quiz-retry"/);

  const perfect = quizHtml([0, 1]);
  assert.match(perfect, /Score: 2 of 2\. Every answer was correct\./);
  assert.match(missed, /Score: 1 of 2\.</);
  assert.ok(!perfect.includes("chat-quiz-explain"));
  assert.match(perfect, /data-testid="chat-quiz-retry"/);

  const ko = quizHtml([1, 1], chatStudyCopy.ko);
  assert.match(ko, /점수: 2문항 중 1문항 정답/);
  assert.match(ko, /틀린 문제 다시 설명해 줘/);
});

/* ------------------------------------------------------ flashcards view */

const cardsHtml = (position: { index: number; flipped: boolean }, announce = false) =>
  renderToStaticMarkup(
    <FlashcardsView
      spec={parseFlashcardSpec(JSON.stringify(cardSpec))!}
      position={position}
      announce={announce}
      copy={copy}
      onFlip={noop}
      onMove={noop}
    />
  );

test("a card shows its front, then its back once turned, and says which face is up", () => {
  const front = cardsHtml(FIRST_CARD);
  assert.match(front, /data-face="front"[^>]*aria-pressed="false"/);
  assert.match(front, />Front</);
  assert.match(front, /bonjour/);
  const back = cardsHtml(flipCard(FIRST_CARD));
  assert.match(back, /data-face="back"[^>]*aria-pressed="true"/);
  assert.match(back, />Back</);
  assert.match(back, /hello/);
  assert.ok(!back.includes("bonjour"));
});

test("the deck stops at its ends and announces a turn only after the reader has acted", () => {
  const first = cardsHtml(FIRST_CARD);
  assert.match(first, /data-testid="chat-flashcards-previous"[^>]*disabled=""/);
  assert.ok(!/data-testid="chat-flashcards-next"[^>]*disabled=""/.test(first));
  const last = cardsHtml({ index: 1, flipped: false });
  assert.match(last, /data-testid="chat-flashcards-next"[^>]*disabled=""/);
  assert.match(last, /Card 2 of 2/);
  assert.match(first, /data-testid="chat-flashcards-announce"[^>]*><\/p>/, "silent on first paint");
  assert.match(cardsHtml(flipCard(FIRST_CARD), true), /data-testid="chat-flashcards-announce"[^>]*>Card 1 of 2\. Back: hello<\/p>/);
});

/* ------------------------------------------------------- composer controls */

test("the study switch carries its state in aria-checked and its words in every language", () => {
  const off = renderToStaticMarkup(<StudyModeRow copy={copy} on={false} onToggle={noop} />);
  assert.match(off, /role="switch"[^>]*aria-checked="false"/);
  assert.match(off, /data-state="off"/);
  assert.match(off, /Study mode/);
  const on = renderToStaticMarkup(<StudyModeRow copy={chatStudyCopy.ko} on onToggle={noop} />);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /data-state="on"/);
  assert.match(on, /학습 모드/);
  // The row is a 44px target.
  assert.match(on, /min-h-11/);
});

test("the study chip names the mode, can be removed, and compacts on a phone", () => {
  const wide = renderToStaticMarkup(<StudyModeChip copy={copy} compact={false} onRemove={noop} />);
  assert.match(wide, /data-testid="study-mode-chip"/);
  assert.match(wide, /aria-label="Turn off study mode"/);
  assert.match(wide, /h-9/);
  const narrow = renderToStaticMarkup(<StudyModeChip copy={chatStudyCopy.ko} compact onRemove={noop} />);
  assert.match(narrow, /h-8/);
  assert.match(narrow, /aria-label="학습 모드 끄기"/);
  assert.match(narrow, /before:-inset-2\.5/, "the remove button keeps a 44px hit area");
});
