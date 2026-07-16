"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Code2,
  FileText,
  PlayCircle,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";

type ProofMetrics = {
  periodDays: number;
  generatedAt: string;
  comparisons: number | null;
  fileWorkflows: number | null;
  minimumPublicCount: number;
};

type ProofCopy = {
  eyebrow: string;
  title: string;
  description: string;
  videoTitle: string;
  videoBody: string;
  videoDisclosure: string;
  steps: Array<{ title: string; description: string }>;
  comparisonMetric: string;
  fileMetric: string;
  metricPeriod: string;
  metricDisclosure: string;
  casesTitle: string;
  casesDescription: string;
  cases: Array<{ title: string; description: string; result: string; link: string }>;
  reviewBoundary: string;
};

const englishCopy: ProofCopy = {
  eyebrow: "How it works",
  title: "See the full workflow—not another feature list.",
  description:
    "The walkthrough follows one controlled task through the real Tomverse interface: a prompt, three model answers, AI Review, and the next action. It uses demo data rather than customer content.",
  videoTitle: "From one question to a clearer review in about 20 seconds",
  videoBody:
    "Watch the selected models answer in parallel, then see AI Review group their common ground, contradictions, missing points, and verification needs before a follow-up or share action.",
  videoDisclosure: "Real product UI · controlled demo data · no customer content · no provider endorsement",
  steps: [
    { title: "1. Ask once", description: "Choose up to three models and send one prompt or supported file." },
    { title: "2. Compare the answers", description: "Read different strengths side by side without copying between tabs." },
    { title: "3. Run AI Review", description: "Structure agreements, conflicts, omissions, and what to verify next." },
  ],
  comparisonMetric: "consented multi-model comparisons",
  fileMetric: "consented file workflows",
  metricPeriod: "Last 30 days",
  metricDisclosure: "Only privacy-safe counts above the public threshold are shown, rounded down to the nearest ten.",
  casesTitle: "Three jobs where a second perspective matters",
  casesDescription:
    "Each example starts with a concrete artifact and ends with something reviewable. These are controlled product examples, not invented customer testimonials.",
  cases: [
    { title: "Cross-review a decision", description: "Compare launch, policy, or planning advice from several models.", result: "Outcome: agreements, conflicts, missing risks, and verification tasks in one view.", link: "See AI answer review" },
    { title: "Analyze a PDF or document", description: "Turn an 18-page readiness brief into a source-linked checklist.", result: "Outcome: decisions, owners, dates, and unresolved items separated for review.", link: "Explore file analysis" },
    { title: "Review code or a plan", description: "Compare a minimal patch, trade-offs, failure paths, and missing tests.", result: "Outcome: an implementation plan that still makes clear what must be tested.", link: "Compare AI models" },
  ],
  reviewBoundary:
    "AI Review compares only the supplied answers. It does not browse the web, prove facts, or declare a correct winner. Important claims still need current primary sources, testing, or qualified professional review.",
};

const proofCopy: Record<Language, ProofCopy> = {
  en: englishCopy,
  ko: {
    ...englishCopy,
    eyebrow: "작동 방식",
    title: "기능 목록이 아니라 전체 작업 흐름을 확인하세요.",
    description: "통제된 하나의 작업을 실제 Tomverse 화면에서 질문, 3개 모델 답변, AI Review와 다음 작업까지 이어갑니다. 고객 콘텐츠가 아닌 데모 데이터를 사용합니다.",
    videoTitle: "약 20초 만에 하나의 질문에서 더 명확한 검토까지",
    videoBody: "선택한 모델이 동시에 답변한 뒤 AI Review가 공통점, 모순, 누락과 추가 검증 항목을 구조화하고 후속 질문 또는 공유로 이어지는 과정을 확인하세요.",
    videoDisclosure: "실제 제품 UI · 통제된 데모 데이터 · 고객 콘텐츠 없음 · 공급자 보증 아님",
    steps: [
      { title: "1. 한 번 질문", description: "최대 3개 모델을 선택하고 질문 또는 지원되는 파일을 보냅니다." },
      { title: "2. 답변 비교", description: "여러 탭에 복사하지 않고 모델별 강점을 나란히 읽습니다." },
      { title: "3. AI Review", description: "합의, 충돌, 누락과 다음 검증 항목을 구조화합니다." },
    ],
    comparisonMetric: "동의 기반 멀티모델 비교",
    fileMetric: "동의 기반 파일 작업",
    metricPeriod: "최근 30일",
    metricDisclosure: "공개 기준을 넘은 개인정보 보호 집계만 10단위로 내림해 표시합니다.",
    casesTitle: "두 번째 관점이 유용한 세 가지 작업",
    casesDescription: "각 예시는 구체적인 자료에서 시작해 검토 가능한 결과로 끝납니다. 꾸며낸 고객 후기가 아닌 통제된 제품 예시입니다.",
    cases: [
      { title: "의사결정 교차검토", description: "여러 모델의 출시, 정책 또는 기획 조언을 비교합니다.", result: "결과: 합의, 충돌, 누락된 위험과 검증 작업을 한 화면에 정리합니다.", link: "AI 답변 교차검토 보기" },
      { title: "PDF·문서 분석", description: "18페이지 준비 문서를 근거와 연결된 체크리스트로 바꿉니다.", result: "결과: 결정, 담당자, 날짜와 미해결 항목을 분리해 검토합니다.", link: "파일 분석 살펴보기" },
      { title: "코드·계획 검토", description: "최소 패치, 장단점, 실패 경로와 누락 테스트를 비교합니다.", result: "결과: 반드시 테스트할 부분이 분명한 구현 계획을 만듭니다.", link: "AI 모델 비교하기" },
    ],
    reviewBoundary: "AI Review는 제공된 답변끼리만 비교합니다. 웹 검색, 사실 판정 또는 정답 선택을 하지 않습니다. 중요한 주장은 최신 1차 출처, 테스트 또는 자격 있는 전문가를 통해 확인해야 합니다.",
  },
  zh: {
    ...englishCopy,
    eyebrow: "工作方式",
    title: "查看完整流程，而不是另一份功能清单。",
    description: "演示在真实 Tomverse 界面中完成一次受控任务：提问、三个模型回答、AI Review 与下一步操作。只使用演示数据。",
    videoTitle: "约 20 秒从一个问题到更清晰的审查",
    videoBody: "观看多个模型并行回答，再由 AI Review 整理共识、矛盾、遗漏和待核实项目。",
    videoDisclosure: "真实产品界面 · 受控演示数据 · 无客户内容 · 非供应商背书",
    steps: [
      { title: "1. 提问一次", description: "最多选择三个模型并发送问题或受支持的文件。" },
      { title: "2. 比较回答", description: "无需在多个标签页复制，即可并排阅读。" },
      { title: "3. 运行 AI Review", description: "整理一致、冲突、遗漏与下一步核实。" },
    ],
    comparisonMetric: "经同意的多模型比较",
    fileMetric: "经同意的文件工作流",
    metricPeriod: "最近 30 天",
    metricDisclosure: "仅显示超过公开阈值且向下取整到十位的隐私安全统计。",
    casesTitle: "三个值得获得第二视角的任务",
    casesDescription: "每个示例都从具体材料开始，以可审查结果结束；这是受控产品示例，不是虚构客户评价。",
    cases: [
      { title: "交叉审查决策", description: "比较多个模型对发布、政策或规划的建议。", result: "结果：在一处查看共识、冲突、遗漏风险和核实任务。", link: "查看 AI 回答审查" },
      { title: "分析 PDF 或文档", description: "把 18 页准备文档变成带依据的清单。", result: "结果：分离决策、负责人、日期和未解决事项。", link: "探索文件分析" },
      { title: "审查代码或计划", description: "比较最小补丁、取舍、失败路径和遗漏测试。", result: "结果：明确仍需测试内容的实施计划。", link: "比较 AI 模型" },
    ],
    reviewBoundary: "AI Review 只比较提供的回答，不浏览网页、不证明事实，也不选出唯一正确答案。重要说法仍需通过最新一手来源、测试或专业人员核实。",
  },
  fr: {
    ...englishCopy,
    eyebrow: "Fonctionnement",
    title: "Voyez le flux complet, pas une nouvelle liste de fonctions.",
    description: "La démonstration suit une tâche contrôlée dans la véritable interface Tomverse : question, trois réponses, AI Review et action suivante, sans contenu client.",
    videoTitle: "D’une question à une revue plus claire en environ 20 secondes",
    videoBody: "Les modèles répondent en parallèle, puis AI Review regroupe accords, contradictions, omissions et vérifications avant une relance ou un partage.",
    videoDisclosure: "Interface produit réelle · données de démonstration contrôlées · aucun contenu client",
    steps: [
      { title: "1. Une seule question", description: "Choisissez jusqu’à trois modèles et envoyez un prompt ou fichier pris en charge." },
      { title: "2. Comparez", description: "Lisez les forces de chaque réponse côte à côte." },
      { title: "3. Lancez AI Review", description: "Structurez accords, conflits, omissions et vérifications." },
    ],
    comparisonMetric: "comparaisons multi-modèles consenties",
    fileMetric: "flux fichiers consentis",
    metricPeriod: "30 derniers jours",
    metricDisclosure: "Seuls les comptes respectueux de la vie privée au-dessus du seuil public sont affichés.",
    casesTitle: "Trois tâches où un second point de vue compte",
    casesDescription: "Chaque exemple part d’un élément concret et produit un résultat vérifiable, sans faux témoignage client.",
    cases: [
      { title: "Revoir une décision", description: "Comparez les conseils de lancement, politique ou planification.", result: "Résultat : accords, conflits, risques oubliés et vérifications dans une seule vue.", link: "Voir la revue des réponses" },
      { title: "Analyser un PDF", description: "Transformez un dossier de 18 pages en liste reliée aux sources.", result: "Résultat : décisions, responsables, dates et questions ouvertes séparés.", link: "Explorer l’analyse de fichiers" },
      { title: "Revoir code ou plan", description: "Comparez correctif minimal, compromis, échecs et tests manquants.", result: "Résultat : un plan d’implémentation qui indique ce qui reste à tester.", link: "Comparer les modèles" },
    ],
    reviewBoundary: "AI Review compare uniquement les réponses fournies. Il ne navigue pas, ne prouve pas les faits et ne désigne pas de gagnant. Les enjeux importants exigent des sources primaires, des tests ou un avis qualifié.",
  },
  de: {
    ...englishCopy,
    eyebrow: "So funktioniert es",
    title: "Der ganze Ablauf statt einer weiteren Feature-Liste.",
    description: "Die Demo führt eine kontrollierte Aufgabe durch die echte Tomverse-Oberfläche: Frage, drei Antworten, AI Review und nächste Aktion – ohne Kundendaten.",
    videoTitle: "In etwa 20 Sekunden von einer Frage zur klareren Prüfung",
    videoBody: "Modelle antworten parallel; AI Review bündelt Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf vor Nachfrage oder Freigabe.",
    videoDisclosure: "Echte Produkt-UI · kontrollierte Demo-Daten · keine Kundeninhalte",
    steps: [
      { title: "1. Einmal fragen", description: "Bis zu drei Modelle wählen und Prompt oder unterstützte Datei senden." },
      { title: "2. Antworten vergleichen", description: "Stärken nebeneinander lesen, ohne Tabs zu kopieren." },
      { title: "3. AI Review starten", description: "Übereinstimmungen, Konflikte, Lücken und Prüfbedarf ordnen." },
    ],
    comparisonMetric: "eingewilligte Multi-Modell-Vergleiche",
    fileMetric: "eingewilligte Datei-Workflows",
    metricPeriod: "Letzte 30 Tage",
    metricDisclosure: "Nur datenschutzfreundliche Werte über dem öffentlichen Schwellenwert werden angezeigt.",
    casesTitle: "Drei Aufgaben, bei denen eine zweite Sicht hilft",
    casesDescription: "Jedes Beispiel beginnt mit einem konkreten Artefakt und endet prüfbar – ohne erfundene Kundenstimmen.",
    cases: [
      { title: "Entscheidung gegenprüfen", description: "Start-, Richtlinien- oder Planungsrat mehrerer Modelle vergleichen.", result: "Ergebnis: Gemeinsamkeiten, Konflikte, fehlende Risiken und Prüfaufgaben in einer Ansicht.", link: "KI-Antwortprüfung ansehen" },
      { title: "PDF oder Dokument analysieren", description: "18-seitiges Briefing in eine quellenbezogene Checkliste verwandeln.", result: "Ergebnis: Entscheidungen, Zuständige, Termine und offene Punkte getrennt.", link: "Dateianalyse entdecken" },
      { title: "Code oder Plan prüfen", description: "Minimalen Patch, Abwägungen, Fehlerpfade und fehlende Tests vergleichen.", result: "Ergebnis: Implementierungsplan mit klaren Testpflichten.", link: "KI-Modelle vergleichen" },
    ],
    reviewBoundary: "AI Review vergleicht nur gelieferte Antworten. Es durchsucht nicht das Web, beweist keine Fakten und bestimmt keinen Gewinner. Wichtige Aussagen brauchen Primärquellen, Tests oder qualifizierte Prüfung.",
  },
  es: {
    ...englishCopy,
    eyebrow: "Cómo funciona",
    title: "Mira el flujo completo, no otra lista de funciones.",
    description: "El recorrido lleva una tarea controlada por la interfaz real de Tomverse: pregunta, tres respuestas, AI Review y siguiente acción, sin contenido de clientes.",
    videoTitle: "De una pregunta a una revisión más clara en unos 20 segundos",
    videoBody: "Los modelos responden en paralelo y AI Review agrupa acuerdos, contradicciones, omisiones y verificaciones antes de continuar o compartir.",
    videoDisclosure: "Interfaz real · datos de demostración controlados · sin contenido de clientes",
    steps: [
      { title: "1. Pregunta una vez", description: "Elige hasta tres modelos y envía un prompt o archivo compatible." },
      { title: "2. Compara", description: "Lee las fortalezas de cada respuesta lado a lado." },
      { title: "3. Ejecuta AI Review", description: "Ordena acuerdos, conflictos, omisiones y verificaciones." },
    ],
    comparisonMetric: "comparaciones multimodelo consentidas",
    fileMetric: "flujos con archivos consentidos",
    metricPeriod: "Últimos 30 días",
    metricDisclosure: "Solo se muestran conteos privados por encima del umbral público.",
    casesTitle: "Tres tareas donde importa una segunda perspectiva",
    casesDescription: "Cada ejemplo parte de un material concreto y termina en un resultado revisable, sin testimonios inventados.",
    cases: [
      { title: "Revisar una decisión", description: "Compara consejos de lanzamiento, política o planificación.", result: "Resultado: acuerdos, conflictos, riesgos omitidos y tareas de verificación en una vista.", link: "Ver revisión de respuestas" },
      { title: "Analizar PDF o documento", description: "Convierte un informe de 18 páginas en una lista vinculada a fuentes.", result: "Resultado: decisiones, responsables, fechas y pendientes separados.", link: "Explorar análisis de archivos" },
      { title: "Revisar código o plan", description: "Compara parche mínimo, alternativas, fallos y pruebas ausentes.", result: "Resultado: un plan que deja claro qué debe probarse.", link: "Comparar modelos" },
    ],
    reviewBoundary: "AI Review solo compara las respuestas dadas. No navega, demuestra hechos ni elige un ganador. Las afirmaciones importantes requieren fuentes primarias, pruebas o revisión profesional.",
  },
  pt: {
    ...englishCopy,
    eyebrow: "Como funciona",
    title: "Veja o fluxo completo, não outra lista de recursos.",
    description: "O passo a passo leva uma tarefa controlada pela interface real do Tomverse: pergunta, três respostas, AI Review e próxima ação, sem conteúdo de clientes.",
    videoTitle: "De uma pergunta a uma revisão mais clara em cerca de 20 segundos",
    videoBody: "Os modelos respondem em paralelo e o AI Review agrupa consensos, contradições, omissões e verificações antes de continuar ou compartilhar.",
    videoDisclosure: "Interface real · dados de demonstração controlados · sem conteúdo de clientes",
    steps: [
      { title: "1. Pergunte uma vez", description: "Escolha até três modelos e envie um prompt ou arquivo compatível." },
      { title: "2. Compare", description: "Leia os pontos fortes de cada resposta lado a lado." },
      { title: "3. Execute AI Review", description: "Organize acordos, conflitos, omissões e verificações." },
    ],
    comparisonMetric: "comparações multimodelo consentidas",
    fileMetric: "fluxos com arquivos consentidos",
    metricPeriod: "Últimos 30 dias",
    metricDisclosure: "Somente contagens seguras acima do limite público são exibidas.",
    casesTitle: "Três tarefas em que uma segunda perspectiva importa",
    casesDescription: "Cada exemplo começa com um material concreto e termina com um resultado revisável, sem depoimentos inventados.",
    cases: [
      { title: "Revisar uma decisão", description: "Compare orientações de lançamento, política ou planejamento.", result: "Resultado: consensos, conflitos, riscos omitidos e verificações em uma tela.", link: "Ver revisão de respostas" },
      { title: "Analisar PDF ou documento", description: "Transforme um relatório de 18 páginas em checklist ligado às fontes.", result: "Resultado: decisões, responsáveis, datas e pendências separados.", link: "Explorar análise de arquivos" },
      { title: "Revisar código ou plano", description: "Compare patch mínimo, escolhas, falhas e testes ausentes.", result: "Resultado: um plano que deixa claro o que ainda precisa ser testado.", link: "Comparar modelos" },
    ],
    reviewBoundary: "AI Review compara apenas as respostas fornecidas. Não navega, prova fatos nem escolhe um vencedor. Afirmações importantes exigem fontes primárias, testes ou revisão profissional.",
  },
};

const casePaths = ["/ai-answer-review", "/ai-for-file-analysis", "/compare-ai-models"];
const caseIcons = [Scale, FileText, Code2];

function localizedPath(lang: Language, path: string) {
  return lang === "en" ? path : `/${lang}${path}`;
}

export function ProductProofSection() {
  const { lang } = useLanguage();
  const content = proofCopy[lang];
  const [metrics, setMetrics] = useState<ProofMetrics | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/public/proof-metrics", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ProofMetrics | null) => data && setMetrics(data))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const visibleMetrics = [
    typeof metrics?.comparisons === "number" ? { label: content.comparisonMetric, value: metrics.comparisons } : null,
    typeof metrics?.fileWorkflows === "number" ? { label: content.fileMetric, value: metrics.fileWorkflows } : null,
  ].filter((item): item is { label: string; value: number } => Boolean(item));

  return (
    <section id="how-it-works" className="py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h2 className="mt-3 text-3xl font-black sm:text-4xl">{content.title}</h2>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.description}</p>
        </div>

        <div className="mt-9 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <article className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-blue-950/20">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 text-white">
              <span className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-blue-300"><PlayCircle className="h-4 w-4" />Tomverse product walkthrough</span>
              <span className="text-[10px] font-bold text-zinc-500">20–25 sec</span>
            </div>
            <video
              src="/marketing-proof/tomverse-review-workflow.webm"
              poster="/marketing-proof/tomverse-review-workflow-poster.png"
              className="aspect-video w-full bg-black object-cover"
              autoPlay
              muted
              loop
              playsInline
              controls
              preload="metadata"
              aria-label={content.videoTitle}
            >
              {content.videoTitle}
            </video>
            <div className="p-5 text-white">
              <h3 className="text-xl font-black">{content.videoTitle}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-300">{content.videoBody}</p>
              <p className="mt-3 text-[10px] font-black uppercase tracking-wider text-zinc-500">{content.videoDisclosure}</p>
            </div>
          </article>

          <div className="space-y-3">
            {content.steps.map((step, index) => (
              <article key={step.title} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-xs font-black text-white">{index + 1}</span><div><h3 className="font-black">{step.title}</h3><p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{step.description}</p></div></div>
              </article>
            ))}
            {visibleMetrics.length > 0 && (
              <article className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-emerald-600 dark:text-emerald-400"><BarChart3 className="h-4 w-4" />{content.metricPeriod}</p>
                <div className="mt-3 space-y-2">{visibleMetrics.map((metric) => <p key={metric.label} className="text-sm"><strong className="text-lg font-black">{metric.value.toLocaleString()}+</strong> <span className="text-zinc-500">{metric.label}</span></p>)}</div>
                <p className="mt-3 text-[11px] leading-5 text-zinc-500">{content.metricDisclosure}</p>
              </article>
            )}
          </div>
        </div>

        <div className="mt-16 max-w-3xl"><h2 className="text-3xl font-black sm:text-4xl">{content.casesTitle}</h2><p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.casesDescription}</p></div>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {content.cases.map((item, index) => {
            const Icon = caseIcons[index];
            return (
              <article key={item.title} className="flex flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
                <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                <h3 className="mt-4 text-lg font-black">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.description}</p>
                <p className="mt-4 flex gap-2 text-sm font-bold leading-6"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-500" />{item.result}</p>
                <Link href={localizedPath(lang, casePaths[index])} className="mt-5 inline-flex items-center gap-2 text-sm font-black text-blue-600 hover:text-blue-500 dark:text-blue-400">{item.link}<ArrowRight className="h-4 w-4" /></Link>
              </article>
            );
          })}
        </div>

        <div className="mt-6 flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs leading-5 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{content.reviewBoundary}</p>
        </div>
      </div>
    </section>
  );
}
