/**
 * Words for study mode: the composer switch and chip, and the quiz and
 * flashcards drawn from an answer's blocks (lib/chatStudy.ts).
 *
 * A side table keyed by language, the shape locales/chatAnswerSurface.ts uses,
 * so these screens do not share a merge hot spot with the large locale files.
 * `{name}` placeholders are filled by `fillStudyCopy`.
 */
import type { Language } from "@/lib/language";

export type ChatStudyCopy = {
  modeTitle: string;
  modeDescription: string;
  chipDescription: string;
  chipRemove: string;
  quizLabel: string;
  quizProgress: string;
  quizQuestionNumber: string;
  quizOptionCorrect: string;
  quizOptionPicked: string;
  quizResultCorrect: string;
  quizResultWrong: string;
  quizScore: string;
  quizAllCorrect: string;
  quizExplainMissed: string;
  quizExplainIntro: string;
  quizRetry: string;
  cardsLabel: string;
  cardCounter: string;
  cardFront: string;
  cardBack: string;
  cardFlip: string;
  cardPrevious: string;
  cardNext: string;
};

/** Fills `{name}` placeholders; a placeholder with no value is left as written. */
export const fillStudyCopy = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

export const chatStudyCopy: Record<Language, ChatStudyCopy> = {
  en: {
    modeTitle: "Study mode",
    modeDescription: "Guides you step by step and can make quizzes and flashcards",
    chipDescription: "Study mode is on for this conversation: answers guide you step by step.",
    chipRemove: "Turn off study mode",
    quizLabel: "Quiz",
    quizProgress: "{answered} of {total} answered",
    quizQuestionNumber: "Question {n}",
    quizOptionCorrect: "Correct answer",
    quizOptionPicked: "Your answer",
    quizResultCorrect: "Correct.",
    quizResultWrong: "Not quite. The correct answer is {answer}.",
    quizScore: "Score: {correct} of {total}.",
    quizAllCorrect: "Every answer was correct.",
    quizExplainMissed: "Explain the ones I missed",
    quizExplainIntro: "I got these quiz questions wrong. Please explain each one step by step, then check that I understand:",
    quizRetry: "Try again",
    cardsLabel: "Flashcards",
    cardCounter: "Card {n} of {total}",
    cardFront: "Front",
    cardBack: "Back",
    cardFlip: "Flip card",
    cardPrevious: "Previous card",
    cardNext: "Next card",
  },
  ko: {
    modeTitle: "학습 모드",
    modeDescription: "단계별로 이끌어 주고 퀴즈와 플래시카드를 만들어 줍니다",
    chipDescription: "이 대화에서 학습 모드가 켜져 있습니다. 답을 단계별로 이끌어 줍니다.",
    chipRemove: "학습 모드 끄기",
    quizLabel: "퀴즈",
    quizProgress: "{total}문항 중 {answered}문항 풀었습니다",
    quizQuestionNumber: "{n}번 문제",
    quizOptionCorrect: "정답",
    quizOptionPicked: "내가 고른 답",
    quizResultCorrect: "정답입니다.",
    quizResultWrong: "아쉽네요. 정답은 {answer}입니다.",
    quizScore: "점수: {total}문항 중 {correct}문항 정답.",
    quizAllCorrect: "모두 맞혔습니다.",
    quizExplainMissed: "틀린 문제 다시 설명해 줘",
    quizExplainIntro: "퀴즈에서 아래 문제를 틀렸어요. 하나씩 단계별로 설명해 주고, 제가 이해했는지 확인해 주세요.",
    quizRetry: "다시 풀기",
    cardsLabel: "플래시카드",
    cardCounter: "{total}장 중 {n}번째 카드",
    cardFront: "앞면",
    cardBack: "뒷면",
    cardFlip: "카드 뒤집기",
    cardPrevious: "이전 카드",
    cardNext: "다음 카드",
  },
  zh: {
    modeTitle: "学习模式",
    modeDescription: "一步步引导你学习，并可生成测验和记忆卡片",
    chipDescription: "此对话已开启学习模式：回答会一步步引导你。",
    chipRemove: "关闭学习模式",
    quizLabel: "测验",
    quizProgress: "共 {total} 题，已答 {answered} 题",
    quizQuestionNumber: "第 {n} 题",
    quizOptionCorrect: "正确答案",
    quizOptionPicked: "你的答案",
    quizResultCorrect: "回答正确。",
    quizResultWrong: "不太对。正确答案是 {answer}。",
    quizScore: "得分：{total} 题中答对 {correct} 题。",
    quizAllCorrect: "全部答对。",
    quizExplainMissed: "请讲解我答错的题",
    quizExplainIntro: "下面这些测验题我答错了，请逐题一步步讲解，并确认我是否理解：",
    quizRetry: "重新作答",
    cardsLabel: "记忆卡片",
    cardCounter: "第 {n} 张，共 {total} 张",
    cardFront: "正面",
    cardBack: "背面",
    cardFlip: "翻转卡片",
    cardPrevious: "上一张",
    cardNext: "下一张",
  },
  "zh-Hant": {
    modeTitle: "學習模式",
    modeDescription: "一步步引導你學習，並可產生測驗與記憶卡",
    chipDescription: "此對話已開啟學習模式：回覆會一步步引導你。",
    chipRemove: "關閉學習模式",
    quizLabel: "測驗",
    quizProgress: "共 {total} 題，已答 {answered} 題",
    quizQuestionNumber: "第 {n} 題",
    quizOptionCorrect: "正確答案",
    quizOptionPicked: "你的答案",
    quizResultCorrect: "答對了。",
    quizResultWrong: "不太對。正確答案是 {answer}。",
    quizScore: "得分：{total} 題中答對 {correct} 題。",
    quizAllCorrect: "全部答對。",
    quizExplainMissed: "請講解我答錯的題目",
    quizExplainIntro: "下列測驗題我答錯了，請逐題一步步講解，並確認我是否理解：",
    quizRetry: "重新作答",
    cardsLabel: "記憶卡",
    cardCounter: "第 {n} 張，共 {total} 張",
    cardFront: "正面",
    cardBack: "背面",
    cardFlip: "翻轉卡片",
    cardPrevious: "上一張",
    cardNext: "下一張",
  },
  fr: {
    modeTitle: "Mode étude",
    modeDescription: "Vous guide pas à pas et peut créer des quiz et des cartes mémoire",
    chipDescription: "Le mode étude est activé pour cette conversation : les réponses vous guident pas à pas.",
    chipRemove: "Désactiver le mode étude",
    quizLabel: "Quiz",
    quizProgress: "{answered} réponse(s) sur {total}",
    quizQuestionNumber: "Question {n}",
    quizOptionCorrect: "Bonne réponse",
    quizOptionPicked: "Votre réponse",
    quizResultCorrect: "Bonne réponse.",
    quizResultWrong: "Pas tout à fait. La bonne réponse est {answer}.",
    quizScore: "Score : {correct} sur {total}.",
    quizAllCorrect: "Toutes les réponses étaient justes.",
    quizExplainMissed: "Expliquer celles que j'ai ratées",
    quizExplainIntro: "Je me suis trompé sur ces questions du quiz. Explique-les une par une, pas à pas, puis vérifie que j'ai compris :",
    quizRetry: "Recommencer",
    cardsLabel: "Cartes mémoire",
    cardCounter: "Carte {n} sur {total}",
    cardFront: "Recto",
    cardBack: "Verso",
    cardFlip: "Retourner la carte",
    cardPrevious: "Carte précédente",
    cardNext: "Carte suivante",
  },
  de: {
    modeTitle: "Lernmodus",
    modeDescription: "Führt Schritt für Schritt und erstellt Quizze und Lernkarten",
    chipDescription: "Der Lernmodus ist für diese Unterhaltung an: Antworten führen Sie Schritt für Schritt.",
    chipRemove: "Lernmodus ausschalten",
    quizLabel: "Quiz",
    quizProgress: "{answered} von {total} beantwortet",
    quizQuestionNumber: "Frage {n}",
    quizOptionCorrect: "Richtige Antwort",
    quizOptionPicked: "Ihre Antwort",
    quizResultCorrect: "Richtig.",
    quizResultWrong: "Leider nicht. Die richtige Antwort ist {answer}.",
    quizScore: "Ergebnis: {correct} von {total}.",
    quizAllCorrect: "Alle Antworten waren richtig.",
    quizExplainMissed: "Die falschen Fragen erklären",
    quizExplainIntro: "Diese Quizfragen habe ich falsch beantwortet. Bitte erkläre jede Schritt für Schritt und prüfe danach, ob ich es verstanden habe:",
    quizRetry: "Noch einmal",
    cardsLabel: "Lernkarten",
    cardCounter: "Karte {n} von {total}",
    cardFront: "Vorderseite",
    cardBack: "Rückseite",
    cardFlip: "Karte umdrehen",
    cardPrevious: "Vorherige Karte",
    cardNext: "Nächste Karte",
  },
  es: {
    modeTitle: "Modo estudio",
    modeDescription: "Te guía paso a paso y puede crear cuestionarios y tarjetas de estudio",
    chipDescription: "El modo estudio está activado en esta conversación: las respuestas te guían paso a paso.",
    chipRemove: "Desactivar el modo estudio",
    quizLabel: "Cuestionario",
    quizProgress: "{answered} de {total} respondidas",
    quizQuestionNumber: "Pregunta {n}",
    quizOptionCorrect: "Respuesta correcta",
    quizOptionPicked: "Tu respuesta",
    quizResultCorrect: "Correcto.",
    quizResultWrong: "No exactamente. La respuesta correcta es {answer}.",
    quizScore: "Puntuación: {correct} de {total}.",
    quizAllCorrect: "Todas las respuestas fueron correctas.",
    quizExplainMissed: "Explícame las que fallé",
    quizExplainIntro: "Fallé estas preguntas del cuestionario. Explícalas una por una, paso a paso, y comprueba después que lo he entendido:",
    quizRetry: "Intentar de nuevo",
    cardsLabel: "Tarjetas de estudio",
    cardCounter: "Tarjeta {n} de {total}",
    cardFront: "Anverso",
    cardBack: "Reverso",
    cardFlip: "Girar la tarjeta",
    cardPrevious: "Tarjeta anterior",
    cardNext: "Tarjeta siguiente",
  },
  pt: {
    modeTitle: "Modo de estudo",
    modeDescription: "Guia você passo a passo e pode criar questionários e cartões de estudo",
    chipDescription: "O modo de estudo está ativado nesta conversa: as respostas guiam você passo a passo.",
    chipRemove: "Desativar o modo de estudo",
    quizLabel: "Questionário",
    quizProgress: "{answered} de {total} respondidas",
    quizQuestionNumber: "Pergunta {n}",
    quizOptionCorrect: "Resposta correta",
    quizOptionPicked: "Sua resposta",
    quizResultCorrect: "Correto.",
    quizResultWrong: "Não foi dessa vez. A resposta correta é {answer}.",
    quizScore: "Pontuação: {correct} de {total}.",
    quizAllCorrect: "Todas as respostas estavam corretas.",
    quizExplainMissed: "Explique as que errei",
    quizExplainIntro: "Errei estas perguntas do questionário. Explique cada uma passo a passo e depois confira se eu entendi:",
    quizRetry: "Tentar de novo",
    cardsLabel: "Cartões de estudo",
    cardCounter: "Cartão {n} de {total}",
    cardFront: "Frente",
    cardBack: "Verso",
    cardFlip: "Virar o cartão",
    cardPrevious: "Cartão anterior",
    cardNext: "Próximo cartão",
  },
};
