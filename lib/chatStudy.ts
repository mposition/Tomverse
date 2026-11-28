/**
 * Study blocks in a Chat answer: a ```quiz block (multiple-choice questions) and
 * a ```flashcards block (front and back cards), each holding one small JSON
 * object. They are drawn after the answer has finished
 * (components/chat/ChatQuiz.tsx, components/chat/ChatFlashcards.tsx).
 *
 * Pure and free of React, like lib/chatChart.ts, so the parsing, the limits and
 * the answer bookkeeping are testable without a renderer. A spec that does not
 * validate is `null` and the caller then shows the ordinary code block. Text is
 * never cut to fit: a field over its limit makes the whole block invalid,
 * because half a question is worse than the JSON the reader can see.
 *
 *   { "title": "...",
 *     "questions": [{ "question": "...", "options": ["...", "..."],
 *                     "answer": 0,            // index of the right option
 *                     "explanation": "..." }] }
 *
 *   { "title": "...", "cards": [{ "front": "...", "back": "..." }] }
 */

import { fencedBlockSourceFromPre } from "@/lib/chatMermaidBlock";

export const STUDY_LIMITS = {
  sourceCharacters: 20_000,
  quizQuestions: 20,
  quizOptionsMin: 2,
  quizOptionsMax: 6,
  cards: 50,
  titleCharacters: 120,
  questionCharacters: 400,
  optionCharacters: 200,
  explanationCharacters: 600,
  frontCharacters: 300,
  backCharacters: 600,
} as const;

export type QuizQuestion = { question: string; options: string[]; answer: number; explanation: string };
export type QuizSpec = { title: string; questions: QuizQuestion[] };
export type FlashcardSpec = { title: string; cards: { front: string; back: string }[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed string within `max`, or null when it is not text, empty (unless allowed) or too long. */
const field = (value: unknown, max: number, allowEmpty = false): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max || (!allowEmpty && trimmed.length === 0)) return null;
  return trimmed;
};

const parseObject = (source: string): Record<string, unknown> | null => {
  if (source.length > STUDY_LIMITS.sourceCharacters) return null;
  try {
    const raw: unknown = JSON.parse(source);
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** The validated quiz of a quiz block's JSON text, or null when anything is off. */
export function parseQuizSpec(source: string): QuizSpec | null {
  const raw = parseObject(source);
  if (!raw || !Array.isArray(raw.questions)) return null;
  const title = field(raw.title ?? "", STUDY_LIMITS.titleCharacters, true);
  if (title === null || raw.questions.length === 0 || raw.questions.length > STUDY_LIMITS.quizQuestions) return null;
  const questions: QuizQuestion[] = [];
  for (const entry of raw.questions) {
    if (!isRecord(entry) || !Array.isArray(entry.options)) return null;
    const question = field(entry.question, STUDY_LIMITS.questionCharacters);
    const explanation = field(entry.explanation ?? "", STUDY_LIMITS.explanationCharacters, true);
    if (question === null || explanation === null) return null;
    if (entry.options.length < STUDY_LIMITS.quizOptionsMin || entry.options.length > STUDY_LIMITS.quizOptionsMax) return null;
    const options: string[] = [];
    for (const option of entry.options) {
      const text = field(option, STUDY_LIMITS.optionCharacters);
      if (text === null) return null;
      options.push(text);
    }
    const answer = entry.answer;
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
    questions.push({ question, options, answer, explanation });
  }
  return { title, questions };
}

/** The validated flashcards of a flashcards block's JSON text, or null when anything is off. */
export function parseFlashcardSpec(source: string): FlashcardSpec | null {
  const raw = parseObject(source);
  if (!raw || !Array.isArray(raw.cards)) return null;
  const title = field(raw.title ?? "", STUDY_LIMITS.titleCharacters, true);
  if (title === null || raw.cards.length === 0 || raw.cards.length > STUDY_LIMITS.cards) return null;
  const cards: FlashcardSpec["cards"] = [];
  for (const entry of raw.cards) {
    if (!isRecord(entry)) return null;
    const front = field(entry.front, STUDY_LIMITS.frontCharacters);
    const back = field(entry.back, STUDY_LIMITS.backCharacters);
    if (front === null || back === null) return null;
    cards.push({ front, back });
  }
  return { title, cards };
}

type PreNode = Parameters<typeof fencedBlockSourceFromPre>[0];

/** The quiz of a `<pre><code class="language-quiz">` block, else null. */
export function quizSpecFromPre(node: PreNode): QuizSpec | null {
  const source = fencedBlockSourceFromPre(node, "quiz", STUDY_LIMITS.sourceCharacters);
  return source ? parseQuizSpec(source) : null;
}

/** The flashcards of a `<pre><code class="language-flashcards">` block, else null. */
export function flashcardSpecFromPre(node: PreNode): FlashcardSpec | null {
  const source = fencedBlockSourceFromPre(node, "flashcards", STUDY_LIMITS.sourceCharacters);
  return source ? parseFlashcardSpec(source) : null;
}

/* ------------------------------------------------------------------ quiz */

/** One entry per question: the option picked, or null while unanswered. */
export type QuizAnswers = readonly (number | null)[];

export const emptyQuizAnswers = (spec: QuizSpec): QuizAnswers => spec.questions.map(() => null);

/** Records a pick. The first pick stands: an answered question cannot be changed, and a stray index is ignored. */
export function pickQuizOption(spec: QuizSpec, answers: QuizAnswers, question: number, option: number): QuizAnswers {
  const target = spec.questions[question];
  if (!target || answers[question] !== null || option < 0 || option >= target.options.length) return answers;
  return answers.map((value, index) => (index === question ? option : value));
}

export type QuizProgress = {
  total: number;
  answered: number;
  correct: number;
  /** Indexes of the questions answered wrongly, in order. */
  missed: number[];
  done: boolean;
};

export function quizProgress(spec: QuizSpec, answers: QuizAnswers): QuizProgress {
  let answered = 0;
  let correct = 0;
  const missed: number[] = [];
  spec.questions.forEach((question, index) => {
    const picked = answers[index] ?? null;
    if (picked === null) return;
    answered += 1;
    if (picked === question.answer) correct += 1;
    else missed.push(index);
  });
  return { total: spec.questions.length, answered, correct, missed, done: answered === spec.questions.length };
}

/**
 * The follow-up that asks for the missed questions to be explained: `intro`
 * (already in the reader's language) and then each question with the answer
 * the reader gave. Placed in the composer, never sent.
 */
export function quizFollowUpDraft(spec: QuizSpec, answers: QuizAnswers, intro: string, maxCharacters = 2_000): string {
  const lines = [intro];
  for (const index of quizProgress(spec, answers).missed) {
    const question = spec.questions[index];
    const picked = answers[index];
    lines.push(`${index + 1}. ${question.question}${picked === null || picked === undefined ? "" : ` (${question.options[picked]})`}`);
  }
  return lines.join("\n").slice(0, maxCharacters);
}

/* ------------------------------------------------------------- flashcards */

export type CardPosition = { index: number; flipped: boolean };

export const FIRST_CARD: CardPosition = { index: 0, flipped: false };

export const flipCard = (position: CardPosition): CardPosition => ({ ...position, flipped: !position.flipped });

/** Moves by `delta` and shows the front. Stops at the first and last card. */
export function moveCard(position: CardPosition, delta: number, count: number): CardPosition {
  const index = Math.min(Math.max(position.index + delta, 0), Math.max(count - 1, 0));
  return index === position.index ? position : { index, flipped: false };
}
