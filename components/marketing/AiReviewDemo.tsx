"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { localizedPath } from "@/lib/seo";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

type ReviewDemoCopy = {
  eyebrow: string;
  title: string;
  description: string;
  example: string;
  promptLabel: string;
  prompt: string;
  before: string;
  answers: string[];
  after: string;
  findings: Array<{ title: string; body: string }>;
  disclaimer: string;
  learnMore: string;
  tryReview: string;
};

const copy: Record<Language, ReviewDemoCopy> = {
  en: {
    eyebrow: "AI Review",
    title: "Compare the answers, then review what they missed.",
    description:
      "After two or three models respond, AI Review organizes their common ground, important differences, contradictions, omissions, and claims that still need verification.",
    example: "Fictional products · edited example answers",
    promptLabel: "One question",
    prompt: "I’m comparing two fictional laptops. A weighs 1.2 kg with 8 GB RAM and costs A$700; B weighs 1.7 kg with 16 GB RAM and costs A$900. My budget is A$900. I’ll carry it daily and mainly use documents and video. What criteria and missing details should I consider?",
    before: "Before · three separate answers",
    answers: ["Both options are within budget. If you carry it daily, look at the lighter A first. Check whether 8 GB meets the needs of your tasks.","Both options are within budget. For several tasks at once, compare B with 16 GB RAM first. Check whether carrying 1.7 kg daily is comfortable.","Both options are within budget. Before deciding from weight and RAM alone, check battery life, screen and CPU. Compare portability with the tasks you actually need."],
    after: "After · structured cross-review",
    findings: [
      { title: "Common ground", body: "All three answers state that both fictional options are within budget." },
      { title: "Different priorities", body: "In this example, A focuses on carrying weight, B on RAM and C on missing specifications. These are different priorities, not a factual contradiction. A: “the lighter A”; B: “B with 16 GB RAM”." },
      { title: "Missing point", body: "Battery life, screen and CPU, raised by answer C, are absent from the question. Check them before weighing daily portability against your tasks. C: “battery life, screen and CPU”." },
      { title: "Verify next", body: "Check battery, screen and CPU specifications against the tasks you need." },
    ],
    disclaimer:
      "AI Review compares supplied answers. It does not browse, externally verify facts, or decide the correct answer. Order randomization reduces one source of position bias, but reviewer models can still be influenced by position, wording, length, and style.",
    learnMore: "How AI Review works",
    tryReview: "Compare answers in Tomverse",
  },
  ko: {
    eyebrow: "AI Review",
    title: "답변을 비교한 뒤, 놓친 부분까지 다시 검토하세요.",
    description:
      "2~3개 모델이 답변하면 AI Review가 합의점, 중요한 차이, 모순, 누락과 추가 검증이 필요한 주장을 구조화합니다.",
    example: "가상 제품 · 편집용 답변 예시",
    promptLabel: "한 번의 질문",
    prompt: "가상 노트북 두 개를 비교하고 있어. A는 1.2kg, RAM 8GB, 70만원이고 B는 1.7kg, RAM 16GB, 90만원이야. 예산은 90만원이고 매일 들고 다니며 문서와 영상 시청에 주로 쓸 거야. 어떤 기준으로 고르고, 무엇을 더 확인해야 할까?",
    before: "Before · 서로 다른 3개 답변",
    answers: ["두 제품 모두 예산 안입니다. 매일 들고 다닌다면 가벼운 A를 먼저 살펴보세요. RAM 8GB로 필요한 작업을 할 수 있는지는 더 확인해야 합니다.","두 제품 모두 예산 안입니다. 여러 작업을 함께 한다면 RAM 16GB인 B를 먼저 비교해 보세요. 다만 매일 들고 다닐 때 1.7kg이 부담스럽지 않은지 확인하세요.","두 제품 모두 예산 안입니다. 무게와 RAM만으로 결정하기 전에 배터리 사용 시간, 화면과 CPU도 확인하세요. 이동성과 실제 작업 요구를 함께 비교하면 선택 기준이 더 분명해집니다."],
    after: "After · 구조화된 답변 간 교차검토",
    findings: [
      { title: "합의점", body: "세 답변 모두 두 가상 제품이 예산 안에 있다고 말합니다." },
      { title: "관점 차이", body: "이 예시에서 답변 A는 이동 무게, B는 RAM 여유, C는 아직 없는 사양을 강조합니다. 다른 선택 기준이며 사실적 모순은 아닙니다. A: “가벼운 A”; B: “RAM 16GB인 B”." },
      { title: "누락", body: "답변 C가 짚은 배터리 사용 시간·화면·CPU는 질문에 없습니다. 해당 정보를 확인한 뒤 매일 들고 다닐 편의와 필요한 작업을 함께 비교하세요. C: “배터리 사용 시간, 화면과 CPU”." },
      { title: "추가 확인", body: "제품 사양에서 배터리·화면·CPU를 확인하고, 실제 필요한 작업에 맞춰 비교하세요." },
    ],
    disclaimer:
      "AI Review는 제공된 답변끼리 비교합니다. 웹 검색, 외부 사실검증 또는 정답 판정을 수행하지 않습니다. 답변 순서 무작위화로 위치 편향 요인 하나를 줄이지만, 검토 모델은 여전히 위치, 표현, 길이와 문체의 영향을 받을 수 있습니다.",
    learnMore: "AI Review 작동 방식",
    tryReview: "Tomverse에서 답변 비교하기",
  },
  zh: {
    eyebrow: "AI Review",
    title: "比较回答后，再检查它们遗漏了什么。",
    description: "当两到三个模型回答后，AI Review 会整理共识、重要差异、矛盾、遗漏和仍需核实的说法。",
    example: "虚构产品 · 编辑示例回答",
    promptLabel: "一个问题",
    prompt: "我在比较两款虚构笔记本。A重1.2千克、内存8GB、价格700澳元；B重1.7千克、内存16GB、价格900澳元。预算900澳元，每天携带，主要处理文档和观看视频。该看哪些标准，还需要确认什么？",
    before: "Before · 三个独立回答",
    answers: ["两款都在预算内。每天携带时，可以先看更轻的A。还需要确认8GB是否满足你的任务。","两款都在预算内。同时处理多项任务时，可先比较16GB的B。但要确认每天携带1.7千克是否方便。","两款都在预算内。不要只凭重量和内存决定，也要确认续航、屏幕和CPU，并结合便携性与实际任务比较。"],
    after: "After · 结构化交叉审查",
    findings: [
      { title: "共识", body: "三个回答都说明两款虚构产品在预算内。" },
      { title: "侧重点不同", body: "此示例中，A关注携带重量，B关注内存，C关注缺少的规格。这是选择重点不同，而非事实矛盾。 A: “更轻的A”; B: “16GB的B”." },
      { title: "遗漏", body: "回答C提到的续航、屏幕和CPU不在问题中。确认这些信息后，再结合日常携带与任务需求比较。 C: “续航、屏幕和CPU”." },
      { title: "下一步核实", body: "确认续航、屏幕和CPU规格，并按实际任务比较。" },
    ],
    disclaimer: "AI Review 只比较提供的回答，不浏览网页、不进行外部事实核验，也不判定唯一正确答案。随机化顺序可减少一种位置偏差，但审查模型仍可能受位置、措辞、长度和风格影响。",
    learnMore: "AI Review 如何工作",
    tryReview: "在 Tomverse 比较回答",
  },
  fr: {
    eyebrow: "AI Review",
    title: "Comparez les réponses, puis repérez ce qu’elles ont oublié.",
    description: "Après deux ou trois réponses, AI Review structure les accords, différences, contradictions, omissions et points à vérifier.",
    example: "Produits fictifs · réponses éditées",
    promptLabel: "Une question",
    prompt: "Je compare deux ordinateurs fictifs : A, 1,2 kg, 8 Go de mémoire, prix 700 € ; B, 1,7 kg, 16 Go, prix 900 €. Mon budget est de 900 €. Je le transporte chaque jour pour des documents et des vidéos. Quels critères et informations manquantes examiner ?",
    before: "Avant · trois réponses séparées",
    answers: ["Les deux respectent le budget. Pour un transport quotidien, examinez d’abord A, plus léger. Vérifiez si 8 Go suffisent à vos tâches.","Les deux respectent le budget. Pour plusieurs tâches simultanées, comparez d’abord B avec ses 16 Go. Vérifiez si porter 1,7 kg chaque jour vous convient.","Les deux respectent le budget. Avant de décider sur le poids et la mémoire seuls, vérifiez autonomie, écran et processeur. Comparez mobilité et besoins réels."],
    after: "Après · revue croisée structurée",
    findings: [
      { title: "Accord", body: "Les trois réponses indiquent que les deux options fictives respectent le budget." },
      { title: "Priorités différentes", body: "Dans cet exemple, A privilégie le poids, B la mémoire et C les caractéristiques manquantes. Ces priorités diffèrent sans constituer une contradiction factuelle. A: “A, plus léger”; B: “B avec ses 16 Go”." },
      { title: "Omission", body: "L’autonomie, l’écran et le processeur signalés par C manquent dans la question. Vérifiez-les avant de comparer mobilité quotidienne et besoins. C: “autonomie, écran et processeur”." },
      { title: "À vérifier", body: "Vérifiez autonomie, écran et processeur selon vos tâches réelles." },
    ],
    disclaimer: "AI Review compare uniquement les réponses fournies. Il ne recherche pas sur le Web, ne vérifie pas les faits à l’extérieur et ne décide pas de la bonne réponse. La randomisation réduit un biais de position, sans éliminer les effets de position, formulation, longueur ou style.",
    learnMore: "Fonctionnement d’AI Review",
    tryReview: "Comparer dans Tomverse",
  },
  de: {
    eyebrow: "AI Review",
    title: "Antworten vergleichen und anschließend Lücken erkennen.",
    description: "Nach zwei oder drei Antworten ordnet AI Review Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken und noch zu prüfende Aussagen.",
    example: "Fiktive Produkte · redaktionelle Antworten",
    promptLabel: "Eine Frage",
    prompt: "Ich vergleiche zwei fiktive Laptops: A mit 1,2 kg, 8 GB RAM und Preis 700 €; B mit 1,7 kg, 16 GB RAM und Preis 900 €. Mein Budget ist 900 €. Ich trage ihn täglich und nutze Dokumente und Videos. Welche Kriterien und fehlenden Angaben sind wichtig?",
    before: "Vorher · drei getrennte Antworten",
    answers: ["Beide liegen im Budget. Für tägliches Tragen schauen Sie zuerst auf das leichtere A. Prüfen Sie, ob 8 GB für Ihre Aufgaben reichen.","Beide liegen im Budget. Bei mehreren gleichzeitigen Aufgaben vergleichen Sie zuerst B mit 16 GB. Prüfen Sie, ob 1,7 kg täglich angenehm zu tragen sind.","Beide liegen im Budget. Prüfen Sie vor einer Entscheidung nur nach Gewicht und RAM auch Akku, Display und CPU. Vergleichen Sie Mobilität mit Ihren tatsächlichen Aufgaben."],
    after: "Nachher · strukturierte Gegenprüfung",
    findings: [
      { title: "Gemeinsamkeit", body: "Alle drei Antworten sagen, dass beide fiktiven Optionen im Budget liegen." },
      { title: "Unterschiedliche Prioritäten", body: "In diesem Beispiel betont A das Gewicht, B den RAM und C fehlende Daten. Das sind unterschiedliche Prioritäten, kein sachlicher Widerspruch. A: “das leichtere A”; B: “B mit 16 GB”." },
      { title: "Lücke", body: "Die von C genannten Angaben zu Akku, Display und CPU fehlen in der Frage. Prüfen Sie diese vor dem Vergleich von Mobilität und Aufgaben. C: “Akku, Display und CPU”." },
      { title: "Zu prüfen", body: "Prüfen Sie Akku, Display und CPU anhand Ihrer tatsächlichen Aufgaben." },
    ],
    disclaimer: "AI Review vergleicht nur die bereitgestellten Antworten. Es sucht nicht im Web, verifiziert Fakten nicht extern und bestimmt keine richtige Antwort. Zufällige Reihenfolge reduziert eine Positionsquelle, beseitigt Einflüsse durch Position, Formulierung, Länge oder Stil aber nicht.",
    learnMore: "So funktioniert AI Review",
    tryReview: "Antworten in Tomverse vergleichen",
  },
  es: {
    eyebrow: "AI Review",
    title: "Compara las respuestas y revisa lo que dejaron fuera.",
    description: "Tras dos o tres respuestas, AI Review organiza acuerdos, diferencias, contradicciones, omisiones y afirmaciones pendientes de verificar.",
    example: "Productos ficticios · respuestas editadas",
    promptLabel: "Una pregunta",
    prompt: "Comparo dos portátiles ficticios: A pesa 1,2 kg, tiene 8 GB y cuesta 700 €; B pesa 1,7 kg, tiene 16 GB y cuesta 900 €. Mi presupuesto es 900 € y lo llevaré a diario para documentos y vídeos. ¿Qué criterios e información faltante debo revisar?",
    before: "Antes · tres respuestas separadas",
    answers: ["Ambas opciones están dentro del presupuesto. Si lo llevas a diario, mira primero A, más ligero. Comprueba si 8 GB bastan para tus tareas.","Ambas opciones están dentro del presupuesto. Para varias tareas a la vez, compara primero B con 16 GB. Comprueba si llevar 1,7 kg a diario te resulta cómodo.","Ambas opciones están dentro del presupuesto. Antes de decidir solo por peso y memoria, revisa batería, pantalla y CPU. Compara movilidad y tus tareas reales."],
    after: "Después · revisión cruzada estructurada",
    findings: [
      { title: "Acuerdo", body: "Las tres respuestas indican que ambas opciones ficticias están dentro del presupuesto." },
      { title: "Prioridades distintas", body: "En este ejemplo, A se centra en el peso, B en la memoria y C en especificaciones que faltan. Son prioridades distintas, no una contradicción factual. A: “A, más ligero”; B: “B con 16 GB”." },
      { title: "Omisión", body: "La batería, la pantalla y la CPU que señala C no aparecen en la pregunta. Compruébalas antes de comparar movilidad y necesidades. C: “batería, pantalla y CPU”." },
      { title: "Verificar", body: "Comprueba batería, pantalla y CPU según tus tareas reales." },
    ],
    disclaimer: "AI Review compara las respuestas proporcionadas. No navega, no verifica hechos externamente ni decide la respuesta correcta. Aleatorizar el orden reduce una fuente de sesgo posicional, pero no elimina influencias de posición, redacción, longitud o estilo.",
    learnMore: "Cómo funciona AI Review",
    tryReview: "Comparar respuestas en Tomverse",
  },
  pt: {
    eyebrow: "AI Review",
    title: "Compare as respostas e revise o que ficou de fora.",
    description: "Depois de duas ou três respostas, o AI Review organiza consensos, diferenças, contradições, omissões e alegações que ainda precisam de verificação.",
    example: "Produtos fictícios · respostas editadas",
    promptLabel: "Uma pergunta",
    prompt: "Comparo dois notebooks fictícios: A pesa 1,2 kg, tem 8 GB e custa R$700; B pesa 1,7 kg, tem 16 GB e custa R$900. Meu orçamento é R$900 e vou levá-lo diariamente para documentos e vídeos. Quais critérios e informações faltam?",
    before: "Antes · três respostas separadas",
    answers: ["As duas opções cabem no orçamento. Para levar diariamente, veja primeiro o A, mais leve. Confira se 8 GB atendem às suas tarefas.","As duas opções cabem no orçamento. Para várias tarefas ao mesmo tempo, compare primeiro o B com 16 GB. Confira se carregar 1,7 kg diariamente é confortável.","As duas opções cabem no orçamento. Antes de decidir só por peso e memória, veja bateria, tela e CPU. Compare mobilidade e suas tarefas reais."],
    after: "Depois · revisão cruzada estruturada",
    findings: [
      { title: "Consenso", body: "As três respostas dizem que as duas opções fictícias cabem no orçamento." },
      { title: "Prioridades diferentes", body: "Neste exemplo, A destaca o peso, B a memória e C as especificações ausentes. São prioridades diferentes, não uma contradição factual. A: “o A, mais leve”; B: “o B com 16 GB”." },
      { title: "Omissão", body: "Bateria, tela e CPU, mencionadas por C, não estão na pergunta. Confira esses dados antes de comparar mobilidade e suas tarefas. C: “bateria, tela e CPU”." },
      { title: "Verificar", body: "Confira bateria, tela e CPU conforme suas tarefas reais." },
    ],
    disclaimer: "O AI Review compara apenas as respostas fornecidas. Não navega, não verifica fatos externamente nem decide a resposta correta. A ordem aleatória reduz uma fonte de viés posicional, mas não elimina efeitos de posição, redação, tamanho ou estilo.",
    learnMore: "Como funciona o AI Review",
    tryReview: "Comparar respostas no Tomverse",
  },
};

const findingIcons = [CheckCircle2, AlertTriangle, ListChecks, CircleHelp];

export function AiReviewDemo({
  showLearnMore = true,
}: {
  showLearnMore?: boolean;
}) {
  const { lang } = useLanguage();
  const text = copy[lang];
  const reviewPath = lang === "en" ? "/ai-answer-review" : localizedPath(lang, "/ai-answer-review");
  const chatPath = `${REVIEW_WORKSPACE_PATH}?lang=${encodeURIComponent(lang)}`;

  return (
    <div className="overflow-hidden rounded-[2rem] border border-tomverse-review-border bg-white shadow-xl shadow-blue-950/5 dark:bg-zinc-950">
      <div
        aria-hidden="true"
        className="h-[3px] w-full bg-gradient-to-r from-tomverse-accent-start via-tomverse-accent-mid to-tomverse-accent-end"
      />
      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-blue-100 bg-gradient-to-br from-accent-ai-review-mid-50 via-white to-accent-ai-review-end-50 p-5 dark:border-blue-900/40 dark:from-accent-ai-review-mid-950/40 dark:via-zinc-950 dark:to-accent-ai-review-end-950/30 sm:p-7 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-accent-ai-review-start-700 via-accent-ai-review-mid-600 to-accent-ai-review-end-600 px-3 py-1 text-xs font-bold text-white">
              <Sparkles className="h-3.5 w-3.5" />
              {text.eyebrow}
            </span>
            <span className="rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs font-bold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-300">
              {text.example}
            </span>
          </div>
          <h2 className="mt-5 text-3xl font-black leading-tight text-zinc-950 dark:text-white sm:text-4xl">
            {text.title}
          </h2>
          <p className="mt-4 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
            {text.description}
          </p>

          <div className="mt-6 rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
              {text.promptLabel}
            </p>
            <p className="mt-2 text-sm font-bold leading-6 text-zinc-800 dark:text-zinc-100">
              {text.prompt}
            </p>
          </div>

          <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
            {text.before}
          </p>
          <div className="mt-3 grid gap-2">
            {text.answers.map((answer, index) => (
              <div
                key={answer}
                className="flex gap-3 rounded-xl border border-zinc-200 bg-white/80 p-3 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {String.fromCharCode(65 + index)}
                </span>
                {answer}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-zinc-950 p-5 text-white sm:p-7">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-tomverse-review-selected-text">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-accent-ai-review-start-400 via-accent-ai-review-mid-400 to-accent-ai-review-end-400"
            />
            {text.after}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {text.findings.map((finding, index) => {
              const Icon = findingIcons[index] ?? ListChecks;
              const warning = index === 1 || index === 3;
              return (
                <article
                  key={finding.title}
                  className={`rounded-2xl border p-4 ${
                    warning
                      ? "border-amber-500/30 bg-amber-500/10"
                      : "border-blue-500/30 bg-blue-500/10"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${warning ? "text-amber-300" : "text-blue-300"}`} />
                  <h3 className="mt-3 text-sm font-bold">{finding.title}</h3>
                  <p className="mt-2 text-xs leading-5 text-zinc-300">{finding.body}</p>
                </article>
              );
            })}
          </div>

          <div className="mt-5 flex gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-xs leading-5 text-zinc-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <p>{text.disclaimer}</p>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            {showLearnMore ? (
              <Link
                href={reviewPath}
                onClick={() =>
                  trackProductEvent("cta_start_click", 0, {
                    cta_location: "ai_review_demo_learn_more",
                  })
                }
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-bold text-white transition hover:bg-zinc-900"
              >
                {text.learnMore}
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
            <Link
              href={chatPath}
              onClick={() =>
                trackProductEvent("cta_start_click", 0, {
                  cta_location: "ai_review_demo_try",
                })
              }
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-500"
            >
              {text.tryReview}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
