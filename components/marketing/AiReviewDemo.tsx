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
    eyebrow: "Tomverse AI Review",
    title: "Compare the answers, then review what they missed.",
    description:
      "After two or three models respond, AI Review organizes their common ground, important differences, contradictions, omissions, and claims that still need verification.",
    example: "Illustrative example",
    promptLabel: "One question",
    prompt: "How should a small team roll out an AI assistant to customers?",
    before: "Before · three separate answers",
    answers: [
      "Launch to every customer now and improve it from feedback.",
      "Run a two-week pilot with 10% of users and define rollback criteria.",
      "Wait until monitoring, support ownership, and privacy review are ready.",
    ],
    after: "After · structured cross-review",
    findings: [
      { title: "Common ground", body: "Measure feedback and monitor the rollout." },
      { title: "Contradiction", body: "Immediate release conflicts with staged or delayed rollout." },
      { title: "Missing point", body: "No answer defines an incident owner or success threshold." },
      { title: "Verify next", body: "Confirm privacy obligations and provider limits in primary sources." },
    ],
    disclaimer:
      "AI Review compares supplied answers. It does not browse, externally verify facts, or decide the correct answer. Order randomization reduces one source of position bias, but reviewer models can still be influenced by position, wording, length, and style.",
    learnMore: "How AI Review works",
    tryReview: "Compare answers in Tomverse",
  },
  ko: {
    eyebrow: "Tomverse AI Review",
    title: "답변을 비교한 뒤, 놓친 부분까지 다시 검토하세요.",
    description:
      "2~3개 모델이 답변하면 AI Review가 합의점, 중요한 차이, 모순, 누락과 추가 검증이 필요한 주장을 구조화합니다.",
    example: "이해를 돕기 위한 예시",
    promptLabel: "한 번의 질문",
    prompt: "소규모 팀은 고객용 AI 도우미를 어떻게 출시해야 할까요?",
    before: "Before · 서로 다른 3개 답변",
    answers: [
      "모든 고객에게 바로 출시하고 피드백으로 개선하세요.",
      "사용자 10%를 대상으로 2주간 시험하고 롤백 기준을 정하세요.",
      "모니터링, 지원 담당자, 개인정보 검토가 준비될 때까지 기다리세요.",
    ],
    after: "After · 구조화된 답변 간 교차검토",
    findings: [
      { title: "합의점", body: "피드백을 측정하고 출시 상태를 모니터링해야 합니다." },
      { title: "모순", body: "즉시 전체 출시와 단계적·지연 출시는 서로 충돌합니다." },
      { title: "누락", body: "장애 책임자와 성공 기준을 정의한 답변이 없습니다." },
      { title: "추가 확인", body: "개인정보 의무와 공급자 한도를 1차 출처에서 확인해야 합니다." },
    ],
    disclaimer:
      "AI Review는 제공된 답변끼리 비교합니다. 웹 검색, 외부 사실검증 또는 정답 판정을 수행하지 않습니다. 답변 순서 무작위화로 위치 편향 요인 하나를 줄이지만, 검토 모델은 여전히 위치, 표현, 길이와 문체의 영향을 받을 수 있습니다.",
    learnMore: "AI Review 작동 방식",
    tryReview: "Tomverse에서 답변 비교하기",
  },
  zh: {
    eyebrow: "Tomverse AI Review",
    title: "比较回答后，再检查它们遗漏了什么。",
    description: "当两到三个模型回答后，AI Review 会整理共识、重要差异、矛盾、遗漏和仍需核实的说法。",
    example: "说明性示例",
    promptLabel: "一个问题",
    prompt: "小型团队应如何向客户推出 AI 助手？",
    before: "Before · 三个独立回答",
    answers: ["立即向所有客户推出，再根据反馈改进。", "先向 10% 用户试运行两周，并设定回滚条件。", "等监控、支持负责人和隐私审查就绪后再推出。"],
    after: "After · 结构化交叉审查",
    findings: [
      { title: "共识", body: "应衡量反馈并监控发布过程。" },
      { title: "矛盾", body: "立即全面发布与分阶段或延后发布相冲突。" },
      { title: "遗漏", body: "没有回答定义事故负责人或成功门槛。" },
      { title: "下一步核实", body: "通过一手来源确认隐私义务和提供商限制。" },
    ],
    disclaimer: "AI Review 只比较提供的回答，不浏览网页、不进行外部事实核验，也不判定唯一正确答案。随机化顺序可减少一种位置偏差，但审查模型仍可能受位置、措辞、长度和风格影响。",
    learnMore: "AI Review 如何工作",
    tryReview: "在 Tomverse 比较回答",
  },
  fr: {
    eyebrow: "Tomverse AI Review",
    title: "Comparez les réponses, puis repérez ce qu’elles ont oublié.",
    description: "Après deux ou trois réponses, AI Review structure les accords, différences, contradictions, omissions et points à vérifier.",
    example: "Exemple illustratif",
    promptLabel: "Une question",
    prompt: "Comment une petite équipe devrait-elle lancer un assistant IA auprès de ses clients ?",
    before: "Avant · trois réponses séparées",
    answers: ["Lancez-le immédiatement à tous les clients et améliorez-le avec leurs retours.", "Testez-le deux semaines avec 10 % des utilisateurs et définissez un retour arrière.", "Attendez que le suivi, le support et l’examen de confidentialité soient prêts."],
    after: "Après · revue croisée structurée",
    findings: [
      { title: "Accord", body: "Mesurer les retours et surveiller le déploiement." },
      { title: "Contradiction", body: "Le lancement immédiat s’oppose au déploiement progressif ou différé." },
      { title: "Omission", body: "Aucune réponse ne définit le responsable d’incident ni le seuil de réussite." },
      { title: "À vérifier", body: "Confirmer les obligations de confidentialité et limites fournisseur dans des sources primaires." },
    ],
    disclaimer: "AI Review compare uniquement les réponses fournies. Il ne recherche pas sur le Web, ne vérifie pas les faits à l’extérieur et ne décide pas de la bonne réponse. La randomisation réduit un biais de position, sans éliminer les effets de position, formulation, longueur ou style.",
    learnMore: "Fonctionnement d’AI Review",
    tryReview: "Comparer dans Tomverse",
  },
  de: {
    eyebrow: "Tomverse AI Review",
    title: "Antworten vergleichen und anschließend Lücken erkennen.",
    description: "Nach zwei oder drei Antworten ordnet AI Review Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken und noch zu prüfende Aussagen.",
    example: "Beispiel zur Veranschaulichung",
    promptLabel: "Eine Frage",
    prompt: "Wie sollte ein kleines Team einen KI-Assistenten für Kunden einführen?",
    before: "Vorher · drei getrennte Antworten",
    answers: ["Sofort für alle Kunden starten und aus Feedback lernen.", "Zwei Wochen mit 10 % der Nutzer testen und Rückrollkriterien festlegen.", "Warten, bis Monitoring, Support-Verantwortung und Datenschutzprüfung bereit sind."],
    after: "Nachher · strukturierte Gegenprüfung",
    findings: [
      { title: "Gemeinsamkeit", body: "Feedback messen und die Einführung überwachen." },
      { title: "Widerspruch", body: "Sofortiger Start widerspricht einer gestuften oder späteren Einführung." },
      { title: "Lücke", body: "Keine Antwort nennt Incident-Verantwortung oder Erfolgsschwellen." },
      { title: "Zu prüfen", body: "Datenschutzpflichten und Anbieterlimits anhand von Primärquellen bestätigen." },
    ],
    disclaimer: "AI Review vergleicht nur die bereitgestellten Antworten. Es sucht nicht im Web, verifiziert Fakten nicht extern und bestimmt keine richtige Antwort. Zufällige Reihenfolge reduziert eine Positionsquelle, beseitigt Einflüsse durch Position, Formulierung, Länge oder Stil aber nicht.",
    learnMore: "So funktioniert AI Review",
    tryReview: "Antworten in Tomverse vergleichen",
  },
  es: {
    eyebrow: "Tomverse AI Review",
    title: "Compara las respuestas y revisa lo que dejaron fuera.",
    description: "Tras dos o tres respuestas, AI Review organiza acuerdos, diferencias, contradicciones, omisiones y afirmaciones pendientes de verificar.",
    example: "Ejemplo ilustrativo",
    promptLabel: "Una pregunta",
    prompt: "¿Cómo debería un equipo pequeño lanzar un asistente de IA para clientes?",
    before: "Antes · tres respuestas separadas",
    answers: ["Lánzalo ya para todos y mejora con el feedback.", "Haz un piloto de dos semanas con el 10 % y define criterios de reversión.", "Espera hasta tener monitorización, responsable de soporte y revisión de privacidad."],
    after: "Después · revisión cruzada estructurada",
    findings: [
      { title: "Acuerdo", body: "Medir el feedback y monitorizar el despliegue." },
      { title: "Contradicción", body: "El lanzamiento inmediato choca con uno gradual o aplazado." },
      { title: "Omisión", body: "Ninguna respuesta define responsable de incidentes ni umbral de éxito." },
      { title: "Verificar", body: "Confirmar obligaciones de privacidad y límites del proveedor en fuentes primarias." },
    ],
    disclaimer: "AI Review compara las respuestas proporcionadas. No navega, no verifica hechos externamente ni decide la respuesta correcta. Aleatorizar el orden reduce una fuente de sesgo posicional, pero no elimina influencias de posición, redacción, longitud o estilo.",
    learnMore: "Cómo funciona AI Review",
    tryReview: "Comparar respuestas en Tomverse",
  },
  pt: {
    eyebrow: "Tomverse AI Review",
    title: "Compare as respostas e revise o que ficou de fora.",
    description: "Depois de duas ou três respostas, o AI Review organiza consensos, diferenças, contradições, omissões e alegações que ainda precisam de verificação.",
    example: "Exemplo ilustrativo",
    promptLabel: "Uma pergunta",
    prompt: "Como uma pequena equipe deve lançar um assistente de IA para clientes?",
    before: "Antes · três respostas separadas",
    answers: ["Lance para todos agora e melhore com o feedback.", "Faça um piloto de duas semanas com 10% dos usuários e defina critérios de reversão.", "Espere até monitoramento, suporte responsável e revisão de privacidade estarem prontos."],
    after: "Depois · revisão cruzada estruturada",
    findings: [
      { title: "Consenso", body: "Medir feedback e monitorar o lançamento." },
      { title: "Contradição", body: "Lançamento imediato conflita com implantação gradual ou adiada." },
      { title: "Omissão", body: "Nenhuma resposta define responsável por incidentes ou limite de sucesso." },
      { title: "Verificar", body: "Confirmar obrigações de privacidade e limites do provedor em fontes primárias." },
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
  const chatPath = `/chat?lang=${encodeURIComponent(lang)}`;

  return (
    <div className="overflow-hidden rounded-[2rem] border border-blue-200 bg-white shadow-xl shadow-blue-950/5 dark:border-blue-900/60 dark:bg-zinc-950">
      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-blue-100 bg-gradient-to-br from-blue-50 via-white to-violet-50 p-5 dark:border-blue-900/40 dark:from-blue-950/40 dark:via-zinc-950 dark:to-violet-950/30 sm:p-7 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-3 py-1 text-xs font-black text-white">
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
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
              {text.promptLabel}
            </p>
            <p className="mt-2 text-sm font-bold leading-6 text-zinc-800 dark:text-zinc-100">
              {text.prompt}
            </p>
          </div>

          <p className="mt-6 text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
            {text.before}
          </p>
          <div className="mt-3 grid gap-2">
            {text.answers.map((answer, index) => (
              <div
                key={answer}
                className="flex gap-3 rounded-xl border border-zinc-200 bg-white/80 p-3 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[10px] font-black text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {String.fromCharCode(65 + index)}
                </span>
                {answer}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-zinc-950 p-5 text-white sm:p-7">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-300">
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
                  <h3 className="mt-3 text-sm font-black">{finding.title}</h3>
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
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-black text-white transition hover:bg-zinc-900"
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
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500"
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
