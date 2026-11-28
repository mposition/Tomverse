import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CARD,
  STUDY_LIMITS,
  emptyQuizAnswers,
  flipCard,
  moveCard,
  parseFlashcardSpec,
  parseQuizSpec,
  pickQuizOption,
  quizFollowUpDraft,
  quizProgress,
} from "../lib/chatStudy.ts";
import { CHAT_STUDY_MODE_PROMPT } from "../lib/chatStudyPrompt.ts";
import { chatStudyCopy, fillStudyCopy } from "../locales/chatStudy.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import { appendQuoteToDraft } from "../lib/chatQuote.ts";
import { validateChatPayload } from "../lib/chatSecurity.ts";

const question = (extra = {}) => ({
  question: "What is 1/2 + 1/4?",
  options: ["3/4", "2/6", "1/8"],
  answer: 0,
  explanation: "1/2 is 2/4.",
  ...extra,
});
const quiz = (extra = {}) => JSON.stringify({ title: "Fractions", questions: [question(), question({ question: "Second?", answer: 2 })], ...extra });
const cards = (extra = {}) => JSON.stringify({ title: "Words", cards: [{ front: "bonjour", back: "hello" }, { front: "merci", back: "thanks" }], ...extra });

/* ------------------------------------------------------------ quiz parse */

test("a quiz spec validates and is trimmed", () => {
  const spec = parseQuizSpec(quiz({ title: "  Fractions  " }));
  assert.equal(spec?.title, "Fractions");
  assert.equal(spec?.questions.length, 2);
  assert.deepEqual(spec?.questions[0].options, ["3/4", "2/6", "1/8"]);
  assert.equal(spec?.questions[1].answer, 2);
  // The title and the explanation are optional.
  const bare = parseQuizSpec(JSON.stringify({ questions: [{ question: "Q?", options: ["a", "b"], answer: 1 }] }));
  assert.equal(bare?.title, "");
  assert.equal(bare?.questions[0].explanation, "");
});

test("anything malformed stays null, so the code block remains", () => {
  assert.equal(parseQuizSpec("not json"), null);
  assert.equal(parseQuizSpec("[]"), null);
  assert.equal(parseQuizSpec(JSON.stringify({ questions: [] })), null, "needs a question");
  assert.equal(parseQuizSpec(JSON.stringify({ title: 5, questions: [question()] })), null, "title is text");
  assert.equal(parseQuizSpec(quiz({ questions: [question({ answer: 3 })] })), null, "answer past the options");
  assert.equal(parseQuizSpec(quiz({ questions: [question({ answer: -1 })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ answer: 0.5 })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ answer: "0" })] })), null, "a number, not text");
  assert.equal(parseQuizSpec(quiz({ questions: [question({ options: ["only one"] })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ options: ["a", ""] })] })), null, "an empty option");
  assert.equal(parseQuizSpec(quiz({ questions: [question({ options: ["a", 2] })] })), null, "options are text");
  assert.equal(parseQuizSpec(quiz({ questions: [question({ question: " " })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ explanation: 3 })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: ["text"] })), null);
});

test("a quiz over a limit is refused whole, never cut", () => {
  const many = Array.from({ length: STUDY_LIMITS.quizQuestions + 1 }, () => question());
  assert.equal(parseQuizSpec(quiz({ questions: many })), null);
  assert.ok(parseQuizSpec(quiz({ questions: many.slice(1) })), "the limit itself is allowed");
  const wide = Array.from({ length: STUDY_LIMITS.quizOptionsMax + 1 }, (_, i) => String(i));
  assert.equal(parseQuizSpec(quiz({ questions: [question({ options: wide })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ question: "x".repeat(STUDY_LIMITS.questionCharacters + 1) })] })), null);
  assert.ok(parseQuizSpec(quiz({ questions: [question({ question: "x".repeat(STUDY_LIMITS.questionCharacters) })] })));
  assert.equal(parseQuizSpec(quiz({ questions: [question({ options: ["a", "x".repeat(STUDY_LIMITS.optionCharacters + 1)] })] })), null);
  assert.equal(parseQuizSpec(quiz({ questions: [question({ explanation: "x".repeat(STUDY_LIMITS.explanationCharacters + 1) })] })), null);
  assert.equal(parseQuizSpec(quiz({ title: "x".repeat(STUDY_LIMITS.titleCharacters + 1) })), null);
  assert.equal(parseQuizSpec(" ".repeat(STUDY_LIMITS.sourceCharacters + 1)), null);
});

/* ------------------------------------------------------- flashcard parse */

test("a flashcard spec validates and is trimmed", () => {
  const spec = parseFlashcardSpec(cards({ cards: [{ front: " bonjour ", back: "hello" }] }));
  assert.equal(spec?.title, "Words");
  assert.deepEqual(spec?.cards, [{ front: "bonjour", back: "hello" }]);
  assert.equal(parseFlashcardSpec(JSON.stringify({ cards: [{ front: "a", back: "b" }] }))?.title, "");
});

test("flashcards that are malformed or over a limit stay null", () => {
  assert.equal(parseFlashcardSpec("nope"), null);
  assert.equal(parseFlashcardSpec(JSON.stringify({ cards: [] })), null);
  assert.equal(parseFlashcardSpec(cards({ cards: [{ front: "a" }] })), null, "a card needs both faces");
  assert.equal(parseFlashcardSpec(cards({ cards: [{ front: "a", back: 2 }] })), null);
  assert.equal(parseFlashcardSpec(cards({ cards: [{ front: " ", back: "b" }] })), null);
  assert.equal(parseFlashcardSpec(cards({ cards: ["a"] })), null);
  const many = Array.from({ length: STUDY_LIMITS.cards + 1 }, () => ({ front: "a", back: "b" }));
  assert.equal(parseFlashcardSpec(cards({ cards: many })), null);
  assert.ok(parseFlashcardSpec(cards({ cards: many.slice(1) })));
  assert.equal(parseFlashcardSpec(cards({ cards: [{ front: "x".repeat(STUDY_LIMITS.frontCharacters + 1), back: "b" }] })), null);
  assert.equal(parseFlashcardSpec(cards({ cards: [{ front: "a", back: "x".repeat(STUDY_LIMITS.backCharacters + 1) }] })), null);
});

/* ------------------------------------------------------------ quiz flow */

test("the first pick stands and the score counts right and wrong picks", () => {
  const spec = parseQuizSpec(quiz());
  let answers = emptyQuizAnswers(spec);
  assert.deepEqual(quizProgress(spec, answers), { total: 2, answered: 0, correct: 0, missed: [], done: false });

  answers = pickQuizOption(spec, answers, 0, 0);
  assert.equal(quizProgress(spec, answers).correct, 1);
  // A second pick on an answered question changes nothing, and a stray index is ignored.
  assert.equal(pickQuizOption(spec, answers, 0, 1), answers);
  assert.equal(pickQuizOption(spec, answers, 5, 0), answers);
  assert.equal(pickQuizOption(spec, answers, 1, 9), answers);
  assert.equal(pickQuizOption(spec, answers, 1, -1), answers);

  answers = pickQuizOption(spec, answers, 1, 1);
  assert.deepEqual(quizProgress(spec, answers), { total: 2, answered: 2, correct: 1, missed: [1], done: true });
});

test("the follow-up draft names the missed questions with the pick the reader made, and is bounded", () => {
  const spec = parseQuizSpec(quiz());
  const answers = pickQuizOption(spec, pickQuizOption(spec, emptyQuizAnswers(spec), 0, 0), 1, 1);
  const draft = quizFollowUpDraft(spec, answers, "Explain these:");
  assert.equal(draft, "Explain these:\n2. Second? (2/6)");
  assert.equal(quizFollowUpDraft(spec, answers, "x".repeat(50), 20).length, 20);
  // The draft joins the composer after whatever is typed, as a quote does.
  assert.equal(appendQuoteToDraft("my note", draft), `my note\n\n${draft}\n\n`);
});

/* ------------------------------------------------------------ flashcards */

test("a card flips, and moving shows the next front and stops at the ends", () => {
  let position = flipCard(FIRST_CARD);
  assert.equal(position.flipped, true);
  assert.equal(flipCard(position).flipped, false);
  position = moveCard(position, 1, 3);
  assert.deepEqual(position, { index: 1, flipped: false });
  assert.equal(moveCard(position, -1, 3).index, 0);
  assert.equal(moveCard(FIRST_CARD, -1, 3), FIRST_CARD, "no card before the first");
  const last = moveCard(moveCard(position, 1, 3), 1, 3);
  assert.equal(last.index, 2);
  assert.equal(moveCard(last, 1, 3), last, "no card after the last");
});

/* ---------------------------------------------------------------- prompt */

test("the study prompt names both block formats and keeps the user's own instructions in force", () => {
  assert.match(CHAT_STUDY_MODE_PROMPT, /^# Study mode/);
  assert.match(CHAT_STUDY_MODE_PROMPT, /language `quiz`/);
  assert.match(CHAT_STUDY_MODE_PROMPT, /language `flashcards`/);
  assert.match(CHAT_STUDY_MODE_PROMPT, /0-based index/);
  assert.match(CHAT_STUDY_MODE_PROMPT, /custom instructions, language and tone/);
  // Its own example is a block the renderer accepts.
  const example = CHAT_STUDY_MODE_PROMPT.match(/```quiz\n([\s\S]*?)\n```/);
  assert.ok(parseQuizSpec(example[1]));
});

/* ---------------------------------------------------------------- request */

test("a chat payload carries study mode as a boolean and refuses anything else", () => {
  const payload = { messages: [{ role: "user", content: "hi" }], modelId: "gpt-5-6-luna" };
  assert.equal(validateChatPayload(payload).studyMode, undefined);
  assert.equal(validateChatPayload({ ...payload, studyMode: true }).studyMode, true);
  assert.equal(validateChatPayload({ ...payload, studyMode: false }).studyMode, false);
  for (const invalid of ["true", 1, 0, null, {}]) {
    assert.throws(() => validateChatPayload({ ...payload, studyMode: invalid }), (error) => error.code === "INVALID_STUDY_MODE");
  }
});

/* ----------------------------------------------------------------- words */

test("study words exist in every language, with the placeholders each sentence needs", () => {
  const needs = {
    quizProgress: ["answered", "total"],
    quizQuestionNumber: ["n"],
    quizResultWrong: ["answer"],
    quizScore: ["correct", "total"],
    cardCounter: ["n", "total"],
  };
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [key, value] of Object.entries(chatStudyCopy[lang])) {
      assert.ok(value.trim().length > 0, `${lang}.${key}`);
    }
    for (const [key, names] of Object.entries(needs)) {
      for (const name of names) assert.ok(chatStudyCopy[lang][key].includes(`{${name}}`), `${lang}.${key} needs {${name}}`);
    }
  }
  assert.equal(fillStudyCopy("{n} of {total} {unknown}", { n: 1, total: 4 }), "1 of 4 {unknown}");
});
