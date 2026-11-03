import type { MobileLanguage } from "./mobile";

const en = {
  chatFirst: "Ask", chatLast: "anything", chatDescription: "Ask a question, explore an idea,\nor work through your thoughts.",
  chatAutomatic: "Tomverse picks an AI for each question,\nbalancing answer quality and cost.",
  reviewFirst: "One question,", reviewLast: "different AI answers", reviewDescription: "Read the answers side by side\nand compare their differences.",
};
type Copy = typeof en;
const copies: Record<MobileLanguage, Copy> = {
  en,
  ko: { chatFirst: "편하게", chatLast: "물어보세요", chatDescription: "궁금한 점을 물어보고,\n생각을 함께 정리해 보세요.", chatAutomatic: "질문마다 AI를 알아서 골라,\n답변 품질과 비용을 함께 고려해요.", reviewFirst: "같은 질문,", reviewLast: "여러 AI의 답변", reviewDescription: "답변을 나란히 읽고 차이를 비교하세요." },
  zh: { chatFirst: "随时提问", chatLast: "轻松开始", chatDescription: "提出问题、探索想法，\n一起理清思路。", chatAutomatic: "为每个问题选择 AI，\n兼顾回答质量和费用。", reviewFirst: "同一个问题，", reviewLast: "不同 AI 的回答", reviewDescription: "并排阅读回答，比较它们的差异。" },
  de: { chatFirst: "Frag, was", chatLast: "dich beschäftigt", chatDescription: "Stelle Fragen, entdecke Ideen\nund ordne deine Gedanken.", chatAutomatic: "Tomverse wählt für jede Frage eine KI\nund berücksichtigt Qualität und Kosten.", reviewFirst: "Eine Frage,", reviewLast: "mehrere KI-Antworten", reviewDescription: "Lies Antworten nebeneinander\nund vergleiche die Unterschiede." },
  fr: { chatFirst: "Posez", chatLast: "vos questions", chatDescription: "Posez une question, explorez une idée\nou clarifiez vos pensées.", chatAutomatic: "Tomverse choisit une IA par question\nen tenant compte de la qualité et du coût.", reviewFirst: "Une question,", reviewLast: "plusieurs réponses", reviewDescription: "Lisez les réponses côte à côte\net comparez leurs différences." },
  es: { chatFirst: "Pregunta", chatLast: "lo que quieras", chatDescription: "Haz una pregunta, explora una idea\nu ordena tus pensamientos.", chatAutomatic: "Tomverse elige una IA para cada pregunta\nconsiderando la calidad y el coste.", reviewFirst: "Una pregunta,", reviewLast: "varias respuestas", reviewDescription: "Lee las respuestas en paralelo\ny compara sus diferencias." },
  pt: { chatFirst: "Pergunta", chatLast: "à vontade", chatDescription: "Faz uma pergunta, explora uma ideia\nou organiza os teus pensamentos.", chatAutomatic: "O Tomverse escolhe uma IA por pergunta,\nconsiderando a qualidade e o custo.", reviewFirst: "Uma pergunta,", reviewLast: "várias respostas", reviewDescription: "Lê as respostas lado a lado\ne compara as diferenças." },
};
export const mobileWorkspaceStartCopy = (language: MobileLanguage) => copies[language];
