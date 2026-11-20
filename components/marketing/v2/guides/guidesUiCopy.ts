import type { Language } from "@/lib/language";

/**
 * Short interface labels and the illustration data of the V2 usage guides
 * (/compare-ai-models, /ai-answer-review, /chatgpt-vs-claude, /ai-for-file-analysis).
 *
 * The guides' own wording (titles, paragraphs, example answers) is not here: it stays in
 * searchIntentContent.ts, ChatGptVsClaudeGuide.tsx and AiReviewDemo.tsx so the live
 * wording keeps its ranking. This file only holds
 *  - labels the template needs (tabs, copy button, view switch),
 *  - which phrases of the existing example answers are highlighted as "kept facts",
 *  - the fictional club notice of the file-extraction illustration, split into
 *    [before, highlighted, after] pieces. The pieces repeat the notice that already sits
 *    in each guide's sample prompt (tests/guidePagesV2.test.mjs keeps the two in step).
 */

/** One sentence of the fictional notice: [text before, highlighted phrase, text after]. */
export type NoticeSentence = [before: string, mark: string, after: string];
type Four<T> = [T, T, T, T];

export type GuideUiCopy = {
  /** Breadcrumb root and the label of the guide tabs. */
  guides: string;
  /** Short names of the four guides, as in the footer's guide list. */
  tabs: { "compare-ai-models": string; "ai-answer-review": string; "chatgpt-vs-claude": string; "ai-for-file-analysis": string };
  /** One line under the related-guide cards for the two guides that have no such line elsewhere. */
  blurbs: { "ai-answer-review": string; "chatgpt-vs-claude": string };
  /** Accessible name of the before/after switch. */
  viewLabel: string;
  copyPrompt: string;
  copied: string;
  allFormats: string;
  fileDemo: {
    file: string;
    notice: Four<NoticeSentence>;
    /** [label, extracted value] for date, items, reply deadline and venue. */
    items: Four<[string, string]>;
  };
  /** Phrases kept from the notice, as written in each example answer (exact substrings). */
  facts: {
    legend: Four<string>;
    gpt: Four<string>;
    claude: Four<string>;
  };
};

export const guidesUiCopy: Record<Language, GuideUiCopy> = {
  ko: {
    guides: "활용 가이드",
    tabs: { "compare-ai-models": "AI 모델 비교", "ai-answer-review": "AI 답변 교차검토", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "AI 파일 분석" },
    blurbs: { "ai-answer-review": "답변의 공통점·차이·누락 보기", "chatgpt-vs-claude": "같은 기준으로 두 모델 비교" },
    viewLabel: "보기 전환",
    copyPrompt: "질문 복사",
    copied: "복사됨",
    allFormats: "모든 형식 보기",
    fileDemo: {
      file: "독서 모임 공지.pdf",
      notice: [
        ["독서 모임은 ", "11월 7일 오후 2시", "에 시작합니다."],
        ["", "읽은 책 한 권과 메모", "를 가져오세요."],
        ["참석 여부는 ", "11월 3일까지", " 알려주세요."],
        ["", "장소는 추후 안내", "합니다."],
      ],
      items: [["모임 날짜", "11월 7일 오후 2시"], ["준비물", "읽은 책 한 권과 메모"], ["회신 기한", "11월 3일까지"], ["장소", "미정"]],
    },
    facts: {
      legend: ["11월 7일 오후 2시", "책 한 권과 메모", "11월 3일 회신", "장소 미정"],
      gpt: ["11월 7일 오후 2시", "읽은 책 한 권과 메모", "11월 3일까지 회신", "장소는 추후 안내"],
      claude: ["11월 7일 오후 2시", "읽은 책 한 권과 메모", "11월 3일까지 참석 여부를 알립니다", "장소는 아직 안내되지 않았습니다"],
    },
  },
  en: {
    guides: "Guides",
    tabs: { "compare-ai-models": "Compare AI models", "ai-answer-review": "AI answer review", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "AI file analysis" },
    blurbs: { "ai-answer-review": "See what answers share, differ on and miss", "chatgpt-vs-claude": "Compare two models by the same criteria" },
    viewLabel: "Switch view",
    copyPrompt: "Copy prompt",
    copied: "Copied",
    allFormats: "See all formats",
    fileDemo: {
      file: "book-club-notice.pdf",
      notice: [
        ["The book club starts on ", "7 November at 2 pm", "."],
        ["Bring ", "one book you have read and your notes", "."],
        ["Confirm attendance ", "by 3 November", "."],
        ["The venue will be ", "announced later", "."],
      ],
      items: [["Meeting date", "7 November at 2 pm"], ["What to bring", "One book and notes"], ["Reply deadline", "By 3 November"], ["Venue", "Undecided"]],
    },
    facts: {
      legend: ["7 November at 2 pm", "One book and notes", "3 November reply", "Venue undecided"],
      gpt: ["7 November at 2 pm", "one book you have read and your notes", "by 3 November", "venue announced later"],
      claude: ["7 November at 2 pm", "a book you have read, along with notes", "by 3 November", "the venue is not yet announced"],
    },
  },
  zh: {
    guides: "使用指南",
    tabs: { "compare-ai-models": "比较 AI 模型", "ai-answer-review": "AI 回答交叉审查", "chatgpt-vs-claude": "ChatGPT 与 Claude", "ai-for-file-analysis": "AI 文件分析" },
    blurbs: { "ai-answer-review": "查看回答的共识、差异与遗漏", "chatgpt-vs-claude": "用相同标准比较两个模型" },
    viewLabel: "切换视图",
    copyPrompt: "复制提问",
    copied: "已复制",
    allFormats: "查看全部格式",
    fileDemo: {
      file: "读书会通知.pdf",
      notice: [
        ["读书会于", "11月7日下午2点", "开始。"],
        ["请带", "一本读过的书和笔记", "。"],
        ["请在", "11月3日前", "确认是否参加。"],
        ["", "地点稍后通知", "。"],
      ],
      items: [["活动日期", "11月7日下午2点"], ["准备物品", "一本读过的书和笔记"], ["回复期限", "11月3日前"], ["地点", "未定"]],
    },
    facts: {
      legend: ["11月7日下午2点", "一本书与笔记", "11月3日回复", "地点未定"],
      gpt: ["11月7日下午2点", "一本读过的书和笔记", "11月3日前确认参加", "地点稍后通知"],
      claude: ["11月7日下午2点", "一本读过的书与笔记", "11月3日前回复是否参加", "地点尚未公布"],
    },
  },
  "zh-Hant": {
    guides: "使用指南",
    tabs: { "compare-ai-models": "比較 AI 模型", "ai-answer-review": "AI 回答交叉審查", "chatgpt-vs-claude": "ChatGPT 與 Claude", "ai-for-file-analysis": "AI 檔案分析" },
    blurbs: { "ai-answer-review": "查看回答的共識、差異與遺漏", "chatgpt-vs-claude": "用相同標準比較兩個模型" },
    viewLabel: "切換檢視",
    copyPrompt: "複製提問",
    copied: "已複製",
    allFormats: "查看全部格式",
    fileDemo: {
      file: "讀書會通知.pdf",
      notice: [
        ["讀書會於", "11月7日下午2點", "開始。"],
        ["請攜帶", "一本讀過的書與筆記", "。"],
        ["請於", "11月3日前", "確認是否參加。"],
        ["", "地點稍後通知", "。"],
      ],
      items: [["活動日期", "11月7日下午2點"], ["準備物品", "一本讀過的書與筆記"], ["回覆期限", "11月3日前"], ["地點", "未定"]],
    },
    facts: {
      legend: ["11月7日下午2點", "一本書與筆記", "11月3日回覆", "地點未定"],
      gpt: ["11月7日下午2點", "一本讀過的書與筆記", "11月3日前確認參加", "地點稍後通知"],
      claude: ["11月7日下午2點", "一本讀過的書與筆記", "11月3日前回覆是否參加", "地點尚未公布"],
    },
  },
  fr: {
    guides: "Guides",
    tabs: { "compare-ai-models": "Comparer les modèles", "ai-answer-review": "Revue des réponses IA", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "Analyse de fichiers" },
    blurbs: { "ai-answer-review": "Voir points communs, écarts et oublis", "chatgpt-vs-claude": "Comparer deux modèles avec la même grille" },
    viewLabel: "Changer d’affichage",
    copyPrompt: "Copier la question",
    copied: "Copié",
    allFormats: "Voir tous les formats",
    fileDemo: {
      file: "annonce-club-lecture.pdf",
      notice: [
        ["Le club de lecture commence le ", "7 novembre à 14 h", "."],
        ["Apportez ", "un livre lu et vos notes", "."],
        ["Confirmez votre présence ", "avant le 3 novembre", "."],
        ["Le lieu sera ", "communiqué ultérieurement", "."],
      ],
      items: [["Date de la réunion", "7 novembre à 14 h"], ["À apporter", "Un livre lu et vos notes"], ["Délai de réponse", "Avant le 3 novembre"], ["Lieu", "Indéterminé"]],
    },
    facts: {
      legend: ["7 novembre à 14 h", "Un livre et des notes", "Réponse avant le 3 novembre", "Lieu indéterminé"],
      gpt: ["7 novembre à 14 h", "un livre lu et vos notes", "avant le 3 novembre", "lieu communiqué plus tard"],
      claude: ["7 novembre à 14 h", "un livre lu et des notes", "avant le 3 novembre", "le lieu n’est pas encore annoncé"],
    },
  },
  de: {
    guides: "Anleitungen",
    tabs: { "compare-ai-models": "KI-Modelle vergleichen", "ai-answer-review": "KI-Antworten prüfen", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "KI-Dateianalyse" },
    blurbs: { "ai-answer-review": "Gemeinsamkeiten, Unterschiede und Lücken sehen", "chatgpt-vs-claude": "Zwei Modelle mit denselben Kriterien vergleichen" },
    viewLabel: "Ansicht wechseln",
    copyPrompt: "Frage kopieren",
    copied: "Kopiert",
    allFormats: "Alle Formate anzeigen",
    fileDemo: {
      file: "lesekreis-nachricht.pdf",
      notice: [
        ["Der Lesekreis beginnt am ", "7. November um 14 Uhr", "."],
        ["Bringen Sie ", "ein gelesenes Buch und Notizen", " mit."],
        ["Teilnahme ", "bis 3. November", " bestätigen."],
        ["Der Ort ", "folgt später", "."],
      ],
      items: [["Termin", "7. November um 14 Uhr"], ["Mitbringen", "Ein gelesenes Buch und Notizen"], ["Antwortfrist", "Bis 3. November"], ["Ort", "Offen"]],
    },
    facts: {
      legend: ["7. November um 14 Uhr", "Ein Buch und Notizen", "Antwort bis 3. November", "Ort offen"],
      gpt: ["7. November um 14 Uhr", "ein gelesenes Buch und Notizen", "bis 3. November", "Ort folgt später"],
      claude: ["7. November um 14 Uhr", "Ein gelesenes Buch und Notizen", "Bis 3. November", "der Ort steht noch nicht fest"],
    },
  },
  es: {
    guides: "Guías",
    tabs: { "compare-ai-models": "Comparar modelos", "ai-answer-review": "Revisar respuestas de IA", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "Análisis de archivos" },
    blurbs: { "ai-answer-review": "Ver coincidencias, diferencias y omisiones", "chatgpt-vs-claude": "Comparar dos modelos con los mismos criterios" },
    viewLabel: "Cambiar vista",
    copyPrompt: "Copiar pregunta",
    copied: "Copiado",
    allFormats: "Ver todos los formatos",
    fileDemo: {
      file: "aviso-club-lectura.pdf",
      notice: [
        ["El club de lectura empieza el ", "7 de noviembre a las 14:00", "."],
        ["Lleva ", "un libro que hayas leído y tus notas", "."],
        ["Confirma ", "antes del 3 de noviembre", "."],
        ["El lugar ", "se anunciará después", "."],
      ],
      items: [["Fecha de la reunión", "7 de noviembre a las 14:00"], ["Qué llevar", "Un libro leído y tus notas"], ["Plazo de respuesta", "Antes del 3 de noviembre"], ["Lugar", "Pendiente"]],
    },
    facts: {
      legend: ["7 de noviembre a las 14:00", "Un libro y notas", "Respuesta antes del 3 de noviembre", "Lugar pendiente"],
      gpt: ["7 de noviembre a las 14:00", "un libro leído y tus notas", "antes del 3 de noviembre", "lugar por anunciar"],
      claude: ["7 de noviembre a las 14:00", "un libro leído y notas", "antes del 3 de noviembre", "el lugar aún no se anuncia"],
    },
  },
  pt: {
    guides: "Guias",
    tabs: { "compare-ai-models": "Comparar modelos", "ai-answer-review": "Revisar respostas de IA", "chatgpt-vs-claude": "ChatGPT vs Claude", "ai-for-file-analysis": "Análise de arquivos" },
    blurbs: { "ai-answer-review": "Ver semelhanças, diferenças e omissões", "chatgpt-vs-claude": "Comparar dois modelos com os mesmos critérios" },
    viewLabel: "Alternar visualização",
    copyPrompt: "Copiar pergunta",
    copied: "Copiado",
    allFormats: "Ver todos os formatos",
    fileDemo: {
      file: "aviso-clube-leitura.pdf",
      notice: [
        ["O clube de leitura começa em ", "7 de novembro às 14h", "."],
        ["Leve ", "um livro que já leu e suas anotações", "."],
        ["Confirme ", "até 3 de novembro", "."],
        ["O local será ", "informado depois", "."],
      ],
      items: [["Data do encontro", "7 de novembro às 14h"], ["O que levar", "Um livro lido e anotações"], ["Prazo de resposta", "Até 3 de novembro"], ["Local", "Indefinido"]],
    },
    facts: {
      legend: ["7 de novembro às 14h", "Um livro e anotações", "Resposta até 3 de novembro", "Local indefinido"],
      gpt: ["7 de novembro às 14h", "um livro lido e anotações", "até 3 de novembro", "local a informar"],
      claude: ["7 de novembro às 14h", "um livro lido e anotações", "até 3 de novembro", "o local ainda não foi informado"],
    },
  },
};
