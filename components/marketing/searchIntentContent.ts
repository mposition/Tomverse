import type { Language } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "./MarketingInfoPage";

export const SEARCH_INTENT_SLUGS = [
  "compare-ai-models",
  "ai-answer-review",
  "chatgpt-vs-claude",
  "ai-for-file-analysis",
] as const;

export type SearchIntentSlug = (typeof SEARCH_INTENT_SLUGS)[number];

export const isSearchIntentSlug = (
  value: string
): value is SearchIntentSlug =>
  SEARCH_INTENT_SLUGS.includes(value as SearchIntentSlug);

type SearchIntentCopy = MarketingInfoCopy & {
  metadataTitle: string;
  metadataDescription: string;
};

const ctaLabels: Record<Language, string> = {
  en: "Start comparing",
  ko: "모델 비교 시작하기",
  zh: "开始比较",
  fr: "Commencer la comparaison",
  de: "Vergleich starten",
  es: "Empezar a comparar",
  pt: "Começar a comparar",
};

const withCta = (
  locale: Language,
  copy: Omit<SearchIntentCopy, "cta">
): SearchIntentCopy => ({
  ...copy,
  cta: { label: ctaLabels[locale], href: `/chat?lang=${locale}` },
});

export const searchIntentPages: Record<
  SearchIntentSlug,
  Record<Language, SearchIntentCopy>
> = {
  "compare-ai-models": {
    en: withCta("en", {
      metadataTitle: "Compare AI Models and Cross-Review Their Answers",
      metadataDescription:
        "Compare leading AI models with one prompt, then use Tomverse AI Review to organize agreements, contradictions, omissions, and verification needs.",
      eyebrow: "AI model comparison",
      title: "Compare AI models, then cross-review their answers",
      description:
        "The most useful model depends on the task, prompt, context, and current version. Tomverse sends one question to multiple models, then AI Review helps organize where their completed answers agree, conflict, omit details, or need verification.",
      sections: [
        {
          title: "Why compare more than one model?",
          body: "AI models can differ in reasoning style, concision, coding approach, writing tone, and how they handle uncertainty. A side-by-side comparison makes those differences visible without repeatedly copying the same prompt between separate products.",
        },
        {
          title: "A repeatable comparison workflow",
          body: "Choose two or three available models, submit the same prompt, and judge each response against criteria you define before testing.",
          bullets: [
            "Use the same instructions and context for every selected model.",
            "Check factual claims and important decisions against primary sources.",
            "Ask follow-up questions when an answer is unclear or incomplete.",
          ],
        },
        {
          title: "Go beyond side-by-side with AI Review",
          body: "After the answers are complete, Tomverse AI Review can organize their common ground, important differences, contradictions, omissions, and claims that need external verification. It compares only the supplied answers: it does not browse, fact-check, or declare a correct winner.",
          link: { label: "See how AI answer cross-review works", href: "/ai-answer-review" },
        },
        {
          title: "Designed for practical work",
          body: "Use comparisons for research outlines, code reviews, drafts, summaries, brainstorming, and document questions. Availability, limits, latency, and provider behavior can change, so Tomverse reports service status separately and does not declare one permanent winner.",
        },
        {
          title: "Privacy and cost awareness",
          body: "Prompts and necessary context are sent to each selected AI provider. Avoid unnecessary sensitive data, review provider terms, and select only the number of models needed for the task.",
        },
      ],
    }),
    ko: withCta("ko", {
      metadataTitle: "AI 모델 답변 비교와 교차검토",
      metadataDescription:
        "같은 질문을 여러 AI 모델에 보내 답변을 비교하고 Tomverse AI Review로 합의점, 모순, 누락과 검증 필요 항목을 확인하세요.",
      eyebrow: "AI 모델 비교",
      title: "여러 AI 모델을 비교한 뒤 답변까지 교차검토하세요",
      description:
        "가장 유용한 모델은 작업, 질문, 맥락과 현재 버전에 따라 달라집니다. Tomverse는 한 질문을 여러 모델에 보내고, AI Review로 완료된 답변의 합의점, 충돌, 누락과 검증 필요 항목을 구조화합니다.",
      sections: [
        { title: "왜 여러 모델을 비교하나요?", body: "모델마다 추론 방식, 답변 길이, 코드 접근법, 문체와 불확실성을 표현하는 방식이 다를 수 있습니다. 나란히 비교하면 여러 서비스에 같은 질문을 반복해서 복사하지 않고 차이를 확인할 수 있습니다." },
        { title: "재현 가능한 비교 방법", body: "2~3개 모델을 선택하고 같은 질문을 보낸 뒤, 미리 정한 기준으로 각 답변을 평가하세요.", bullets: ["모든 모델에 동일한 지시와 맥락을 제공합니다.", "중요한 사실과 결정은 1차 출처로 다시 확인합니다.", "불명확하거나 빠진 내용은 후속 질문으로 확인합니다."] },
        { title: "나란히 비교한 뒤 AI Review", body: "답변이 완료되면 Tomverse AI Review가 합의점, 중요한 차이, 모순, 누락과 외부 검증이 필요한 주장을 구조화합니다. 제공된 답변끼리만 비교하며 웹 검색, 사실검증 또는 정답 판정을 수행하지 않습니다.", link: { label: "AI 답변 교차검토 방식 보기", href: "/ko/ai-answer-review" } },
        { title: "실제 업무에 활용", body: "리서치 개요, 코드 검토, 글 초안, 요약, 아이디어 발굴과 문서 질의에 활용할 수 있습니다. 모델 가용성과 공급자 동작은 바뀔 수 있으므로 Tomverse는 영구적인 우승 모델을 선언하지 않습니다." },
        { title: "개인정보와 비용", body: "질문과 필요한 맥락은 선택한 각 AI 공급자에게 전송됩니다. 불필요한 민감정보를 제외하고 작업에 필요한 모델 수만 선택하세요." },
      ],
    }),
    zh: withCta("zh", {
      metadataTitle: "比较多个 AI 模型并交叉审查回答",
      metadataDescription: "向多个 AI 模型发送同一问题，然后使用 Tomverse AI Review 整理共识、矛盾、遗漏和待核实项目。",
      eyebrow: "AI 模型比较",
      title: "比较多个 AI 模型，再交叉审查回答",
      description: "最合适的模型取决于任务、提示词、上下文和当前版本。Tomverse 将同一问题发送给多个模型，并用 AI Review 整理回答的共识、冲突、遗漏和待核实项目。",
      sections: [
        { title: "为什么要比较模型？", body: "不同模型在推理方式、篇幅、代码方案、写作风格和不确定性表达上可能不同。并排显示能减少在多个产品之间重复复制提示词。" },
        { title: "可重复的比较流程", body: "选择两到三个模型，发送相同问题，并按照预先确定的标准评估回答。", bullets: ["向所有模型提供相同指令和上下文。", "用一手来源核实重要事实与决定。", "通过追问澄清遗漏或含糊之处。"] },
        { title: "从并排比较到 AI Review", body: "回答完成后，Tomverse AI Review 可整理共识、重要差异、矛盾、遗漏和需要外部核实的说法。它只比较提供的回答，不浏览网页、不进行事实核验，也不判定唯一正确答案。", link: { label: "了解 AI 回答交叉审查", href: "/zh/ai-answer-review" } },
        { title: "面向实际工作", body: "可用于研究提纲、代码审查、草稿、总结、头脑风暴和文档问答。可用性与模型行为会变化，因此 Tomverse 不宣称存在永久最佳模型。" },
        { title: "隐私与成本", body: "提示词和必要上下文会发送给每个所选 AI 提供商。请避免不必要的敏感信息，并只选择任务所需的模型数量。" },
      ],
    }),
    fr: withCta("fr", {
      metadataTitle: "Comparer les modèles d’IA et revoir leurs réponses",
      metadataDescription: "Envoyez la même demande à plusieurs modèles, puis utilisez Tomverse AI Review pour structurer accords, contradictions, omissions et vérifications.",
      eyebrow: "Comparaison de modèles d’IA",
      title: "Comparez les modèles d’IA puis examinez leurs réponses",
      description: "Le modèle le plus utile dépend de la tâche, du prompt, du contexte et de sa version. Tomverse envoie la même question à plusieurs modèles puis structure avec AI Review leurs accords, conflits, omissions et vérifications.",
      sections: [
        { title: "Pourquoi comparer plusieurs modèles ?", body: "Les modèles peuvent différer dans leur raisonnement, leur concision, leur approche du code, leur ton et leur gestion de l’incertitude. La vue côte à côte rend ces différences visibles sans copier le prompt entre plusieurs services." },
        { title: "Une méthode reproductible", body: "Choisissez deux ou trois modèles, envoyez les mêmes instructions et évaluez les réponses selon des critères définis à l’avance.", bullets: ["Fournissez le même contexte à chaque modèle.", "Vérifiez les faits importants auprès de sources primaires.", "Posez des questions de suivi pour clarifier les lacunes."] },
        { title: "Au-delà du côte à côte avec AI Review", body: "Une fois les réponses terminées, Tomverse AI Review structure accords, différences, contradictions, omissions et points à vérifier à l’extérieur. Il compare uniquement les réponses fournies : ce n’est ni une recherche Web, ni une vérification factuelle, ni un verdict.", link: { label: "Découvrir la revue croisée des réponses", href: "/fr/ai-answer-review" } },
        { title: "Pour le travail réel", body: "Comparez des plans de recherche, revues de code, brouillons, résumés et analyses de documents. La disponibilité et le comportement évoluent : Tomverse ne désigne pas de vainqueur permanent." },
        { title: "Confidentialité et coûts", body: "Le prompt et le contexte nécessaire sont transmis à chaque fournisseur choisi. Évitez les données sensibles inutiles et limitez le nombre de modèles à ce dont vous avez besoin." },
      ],
    }),
    de: withCta("de", {
      metadataTitle: "KI-Modelle vergleichen und Antworten gegenprüfen",
      metadataDescription: "Senden Sie dieselbe Frage an mehrere KI-Modelle und ordnen Sie mit Tomverse AI Review Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf.",
      eyebrow: "KI-Modellvergleich",
      title: "KI-Modelle vergleichen und Antworten gegenprüfen",
      description: "Welches Modell passt, hängt von Aufgabe, Prompt, Kontext und Version ab. Tomverse sendet eine Frage an mehrere Modelle und strukturiert mit AI Review Gemeinsamkeiten, Konflikte, Lücken und Prüfbedarf.",
      sections: [
        { title: "Warum mehrere Modelle vergleichen?", body: "Modelle unterscheiden sich mitunter bei Argumentation, Kürze, Codeansatz, Schreibstil und Unsicherheit. Die parallele Ansicht zeigt diese Unterschiede, ohne Prompts zwischen Diensten zu kopieren." },
        { title: "Ein wiederholbarer Ablauf", body: "Wählen Sie zwei oder drei Modelle, senden Sie identische Anweisungen und bewerten Sie die Antworten anhand vorher festgelegter Kriterien.", bullets: ["Geben Sie allen Modellen denselben Kontext.", "Prüfen Sie wichtige Aussagen anhand von Primärquellen.", "Klären Sie Lücken mit Folgefragen."] },
        { title: "Nach dem Vergleich: AI Review", body: "Nach Abschluss der Antworten ordnet Tomverse AI Review Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken und extern zu prüfende Aussagen. Es vergleicht nur die gelieferten Antworten und ist weder Websuche noch Faktenprüfung oder endgültiges Urteil.", link: { label: "So funktioniert die Antwort-Gegenprüfung", href: "/de/ai-answer-review" } },
        { title: "Für praktische Aufgaben", body: "Vergleichen Sie Recherchepläne, Code-Reviews, Entwürfe, Zusammenfassungen und Dokumentanalysen. Verfügbarkeit und Verhalten ändern sich; Tomverse erklärt kein Modell zum dauerhaften Sieger." },
        { title: "Datenschutz und Kosten", body: "Prompt und nötiger Kontext gehen an jeden gewählten Anbieter. Vermeiden Sie unnötige sensible Daten und wählen Sie nur benötigte Modelle." },
      ],
    }),
    es: withCta("es", {
      metadataTitle: "Comparar modelos de IA y revisar sus respuestas",
      metadataDescription: "Envía la misma pregunta a varios modelos y usa Tomverse AI Review para organizar acuerdos, contradicciones, omisiones y verificaciones.",
      eyebrow: "Comparación de modelos de IA",
      title: "Compara modelos de IA y revisa sus respuestas",
      description: "El modelo más útil depende de la tarea, el prompt, el contexto y la versión. Tomverse envía una pregunta a varios modelos y AI Review estructura acuerdos, conflictos, omisiones y verificaciones.",
      sections: [
        { title: "¿Por qué comparar varios modelos?", body: "Los modelos pueden diferir en razonamiento, concisión, enfoque de código, tono y manejo de la incertidumbre. La vista paralela muestra esas diferencias sin copiar el prompt entre productos." },
        { title: "Un proceso repetible", body: "Elige dos o tres modelos, envía las mismas instrucciones y evalúa las respuestas con criterios definidos de antemano.", bullets: ["Proporciona el mismo contexto a cada modelo.", "Verifica afirmaciones importantes con fuentes primarias.", "Usa preguntas de seguimiento para aclarar vacíos."] },
        { title: "Más allá del paralelo con AI Review", body: "Cuando terminan las respuestas, Tomverse AI Review organiza acuerdos, diferencias, contradicciones, omisiones y afirmaciones que requieren verificación externa. Solo compara lo proporcionado: no navega, no verifica hechos ni declara una respuesta correcta.", link: { label: "Ver cómo funciona la revisión cruzada", href: "/es/ai-answer-review" } },
        { title: "Para trabajo práctico", body: "Compara esquemas de investigación, revisiones de código, borradores, resúmenes y análisis de documentos. La disponibilidad y el comportamiento cambian; Tomverse no declara un ganador permanente." },
        { title: "Privacidad y costes", body: "El prompt y el contexto necesario se envían a cada proveedor elegido. Evita datos sensibles innecesarios y selecciona solo los modelos necesarios." },
      ],
    }),
    pt: withCta("pt", {
      metadataTitle: "Comparar modelos de IA e revisar suas respostas",
      metadataDescription: "Envie a mesma pergunta a vários modelos e use o Tomverse AI Review para organizar consensos, contradições, omissões e verificações.",
      eyebrow: "Comparação de modelos de IA",
      title: "Compare modelos de IA e revise suas respostas",
      description: "O modelo mais útil depende da tarefa, do prompt, do contexto e da versão. O Tomverse envia uma pergunta a vários modelos e o AI Review estrutura consensos, conflitos, omissões e verificações.",
      sections: [
        { title: "Por que comparar vários modelos?", body: "Os modelos podem diferir em raciocínio, concisão, abordagem de código, tom e tratamento da incerteza. A visualização paralela mostra essas diferenças sem copiar o prompt entre serviços." },
        { title: "Um processo repetível", body: "Escolha dois ou três modelos, envie as mesmas instruções e avalie as respostas com critérios definidos antes do teste.", bullets: ["Forneça o mesmo contexto a cada modelo.", "Verifique afirmações importantes em fontes primárias.", "Use perguntas de acompanhamento para esclarecer lacunas."] },
        { title: "Além da comparação com AI Review", body: "Após as respostas, o Tomverse AI Review organiza consensos, diferenças, contradições, omissões e alegações que exigem verificação externa. Ele compara somente o conteúdo fornecido: não navega, não faz checagem factual nem declara a resposta correta.", link: { label: "Veja como funciona a revisão cruzada", href: "/pt/ai-answer-review" } },
        { title: "Para trabalho prático", body: "Compare planos de pesquisa, revisões de código, rascunhos, resumos e análises de documentos. Disponibilidade e comportamento mudam; o Tomverse não declara um vencedor permanente." },
        { title: "Privacidade e custos", body: "O prompt e o contexto necessário são enviados a cada provedor escolhido. Evite dados sensíveis desnecessários e selecione apenas os modelos necessários." },
      ],
    }),
  },
  "ai-answer-review": {
    en: withCta("en", {
      metadataTitle: "AI Answer Review: Compare Agreements, Contradictions and Gaps",
      metadataDescription: "Use Tomverse AI Review to cross-review two or three AI answers for common ground, contradictions, missing points, and claims that need verification.",
      eyebrow: "AI answer cross-review",
      title: "Review multiple AI answers, not just their layout",
      description: "Side-by-side answers show that models differ. Tomverse AI Review adds a structured second reading that identifies what the supplied answers agree on, where they conflict, what they omit, and what still requires independent verification.",
      updated: "Reviewed 15 July 2026",
      sections: [
        { title: "How AI Review works", body: "Complete the same prompt with two or three models, open AI Review, and choose a balanced, evidence-focused, or action-focused review. The reviewer receives anonymous A/B/C answers and returns structured common ground, differences, contradictions, missing points, verification needs, per-answer strengths and cautions, and an optional cautious synthesis.", bullets: ["The original question and completed answers are treated as untrusted data.", "The reviewer is instructed not to select a winner or infer model identity.", "Estimated credits are shown before the review runs."] },
        { title: "Before and after", body: "Before AI Review, users must scan separate answers and remember which model mentioned each risk. After AI Review, the same material is grouped by agreement, conflict, omission, and verification need so the user can decide where to read more closely or ask a follow-up. The example above is illustrative rather than a live factual result." },
        { title: "Position and style bias still matter", body: "Tomverse randomizes answer order and removes model names from the reviewer prompt to reduce obvious position and brand cues. This is mitigation, not elimination: LLM reviewers can still be influenced by order, verbosity, wording, style, prompt design, and their own model family. Treat the review as another perspective rather than an objective score or final verdict.", link: { label: "Read the position-bias study", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "Cross-review is not fact-checking", body: "AI Review does not browse the web or consult external sources. A statement under ‘verification needed’ means the supplied answers disagree, lack support, or contain a claim worth checking; it does not mean Tomverse has proven that claim true or false. Verify consequential claims against current primary sources and qualified experts." },
        { title: "When it is most useful", body: "Use AI Review when answers are long, trade-offs matter, or omissions are easy to miss: launch plans, code approaches, document summaries, business drafts, research outlines, and other decisions that benefit from a structured second pass. It is not a substitute for testing code, reading the source document, or professional review." },
      ],
    }),
    ko: withCta("ko", {
      metadataTitle: "AI 답변 교차검토: 합의점·모순·누락 비교",
      metadataDescription: "Tomverse AI Review로 2~3개 AI 답변의 합의점, 모순, 누락과 추가 검증이 필요한 주장을 구조화해 비교하세요.",
      eyebrow: "AI 답변 교차검토",
      title: "답변 배치가 아니라 답변 내용까지 다시 검토하세요",
      description: "나란히 보기는 모델별 차이를 보여줍니다. Tomverse AI Review는 제공된 답변의 합의점, 충돌, 누락과 독립 검증이 필요한 항목을 구조화해 한 번 더 읽어줍니다.",
      updated: "2026년 7월 15일 검토",
      sections: [
        { title: "AI Review 작동 방식", body: "같은 질문에 2~3개 모델의 답변을 완료한 뒤 AI Review를 열고 균형, 근거 중심 또는 실행 중심 검토를 선택합니다. 검토 모델은 익명화된 A/B/C 답변을 받고 합의점, 차이, 모순, 누락, 검증 필요 항목, 답변별 강점·주의점과 선택적 종합안을 구조화합니다.", bullets: ["원 질문과 답변은 신뢰하지 않는 데이터로 처리합니다.", "검토 모델은 승자를 고르거나 모델 정체를 추론하지 않도록 지시받습니다.", "실행 전에 예상 크레딧을 표시합니다."] },
        { title: "Before와 After", body: "AI Review 전에는 사용자가 서로 다른 답변을 훑고 어떤 모델이 어떤 위험을 언급했는지 직접 기억해야 합니다. 실행 후에는 같은 내용을 합의, 충돌, 누락과 검증 필요 항목으로 묶어 더 읽을 부분과 후속 질문 위치를 빠르게 찾을 수 있습니다. 위 결과는 실제 사실 판정이 아닌 기능 이해용 예시입니다." },
        { title: "위치·문체 편향은 여전히 존재합니다", body: "Tomverse는 답변 순서를 무작위화하고 모델명을 A/B/C로 숨겨 명백한 위치·브랜드 단서를 줄입니다. 그러나 이는 완전한 제거가 아닙니다. LLM 검토 모델은 순서, 답변 길이, 표현, 문체, 프롬프트 설계와 자체 모델 계열의 영향을 받을 수 있습니다. 객관적 점수나 최종 판정이 아니라 추가 관점으로 사용해야 합니다.", link: { label: "위치 편향 연구 보기", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "교차검토는 사실검증이 아닙니다", body: "AI Review는 웹을 검색하거나 외부 출처를 조회하지 않습니다. ‘추가 검증 필요’는 제공된 답변이 충돌하거나 근거가 부족하거나 별도 확인할 가치가 있다는 의미이며, Tomverse가 참·거짓을 판정했다는 뜻이 아닙니다. 중요한 주장은 최신 1차 출처와 자격 있는 전문가를 통해 확인하세요." },
        { title: "언제 유용한가요?", body: "답변이 길거나 선택의 장단점이 중요하고 누락을 놓치기 쉬운 출시 계획, 코드 접근법, 문서 요약, 업무 초안, 리서치 개요에 활용하세요. 코드 테스트, 원문 확인 또는 전문 검토를 대체하지 않습니다." },
      ],
    }),
    zh: withCta("zh", {
      metadataTitle: "AI 回答交叉审查：比较共识、矛盾与遗漏",
      metadataDescription: "使用 Tomverse AI Review 交叉审查两到三个 AI 回答，整理共识、矛盾、遗漏和待核实说法。",
      eyebrow: "AI 回答交叉审查",
      title: "不只并排显示，还要重新审查回答内容",
      description: "并排回答能显示模型差异。Tomverse AI Review 进一步整理回答之间的共识、冲突、遗漏和需要独立核实的项目。",
      updated: "2026 年 7 月 15 日审阅",
      sections: [
        { title: "AI Review 如何工作", body: "先让两到三个模型完成同一个问题，再选择均衡、证据优先或行动优先审查。审查模型接收匿名 A/B/C 回答，并返回共识、差异、矛盾、遗漏、待核实项目、各回答的优点与注意点，以及可选的谨慎综合。", bullets: ["原问题和回答按不可信数据处理。", "审查模型不得选择赢家或推断模型身份。", "运行前显示预计积分。"] },
        { title: "Before 与 After", body: "审查前，用户需要逐一阅读回答并记住各自提到的风险。审查后，同一内容会按共识、冲突、遗漏和待核实项目分组，帮助决定重点阅读和追问位置。上方结果仅为功能示例，不是实时事实结论。" },
        { title: "位置与风格偏差仍然存在", body: "Tomverse 会随机排列回答并隐藏模型名称，以减少明显的位置和品牌线索，但无法完全消除偏差。LLM 审查者仍可能受顺序、篇幅、措辞、风格、提示设计和自身模型家族影响。请把审查视为额外视角，而非客观评分或最终裁决。", link: { label: "阅读位置偏差研究", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "交叉审查不是事实核验", body: "AI Review 不浏览网页，也不查询外部来源。“需要核实”表示回答之间冲突、缺少支持或值得另行确认，并不表示 Tomverse 已证明其真伪。重要说法应通过最新一手来源和合格专业人士核实。" },
        { title: "适合哪些任务", body: "当回答较长、取舍重要或容易遗漏时，可用于发布计划、代码方案、文档总结、商务草稿和研究提纲。它不能代替代码测试、阅读原文或专业审查。" },
      ],
    }),
    fr: withCta("fr", {
      metadataTitle: "Revue croisée de réponses IA : accords, contradictions et lacunes",
      metadataDescription: "Utilisez Tomverse AI Review pour comparer deux ou trois réponses IA et structurer accords, contradictions, omissions et points à vérifier.",
      eyebrow: "Revue croisée de réponses IA",
      title: "Analysez le contenu des réponses, pas seulement leur disposition",
      description: "L’affichage côte à côte montre les différences. Tomverse AI Review ajoute une seconde lecture structurée des accords, conflits, omissions et points à vérifier indépendamment.",
      updated: "Révisé le 15 juillet 2026",
      sections: [
        { title: "Fonctionnement d’AI Review", body: "Une fois deux ou trois réponses terminées, choisissez une revue équilibrée, centrée sur les preuves ou sur l’action. Le réviseur reçoit des réponses anonymes A/B/C et structure accords, différences, contradictions, omissions, vérifications, forces, réserves et synthèse optionnelle.", bullets: ["Question et réponses sont traitées comme des données non fiables.", "Le réviseur ne doit ni choisir de gagnant ni déduire le modèle.", "Le coût estimé en crédits est affiché avant l’exécution."] },
        { title: "Avant et après", body: "Avant, l’utilisateur doit parcourir chaque réponse et mémoriser ses risques. Après, le même contenu est regroupé par accord, conflit, omission et vérification afin de cibler lecture et relances. L’exemple ci-dessus illustre la fonction et ne constitue pas un résultat factuel en direct." },
        { title: "Les biais de position et de style subsistent", body: "Tomverse randomise l’ordre et masque les noms des modèles pour réduire les indices évidents. Cela n’élimine pas l’influence possible de l’ordre, de la longueur, de la formulation, du style, du prompt ou de la famille du réviseur. Utilisez la revue comme une perspective supplémentaire, pas comme un verdict objectif.", link: { label: "Lire l’étude sur le biais de position", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "La revue croisée n’est pas une vérification factuelle", body: "AI Review ne navigue pas sur le Web et ne consulte aucune source externe. Un point à vérifier signale un conflit, un manque d’appui ou une affirmation à contrôler, sans prouver qu’elle est vraie ou fausse. Vérifiez les décisions importantes dans des sources primaires actuelles." },
        { title: "Usages pertinents", body: "Utilisez-la pour les plans de lancement, approches de code, résumés de documents, brouillons professionnels et plans de recherche. Elle ne remplace ni les tests, ni la lecture du document source, ni une revue professionnelle." },
      ],
    }),
    de: withCta("de", {
      metadataTitle: "KI-Antworten gegenprüfen: Gemeinsamkeiten, Widersprüche und Lücken",
      metadataDescription: "Mit Tomverse AI Review zwei oder drei KI-Antworten auf Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf untersuchen.",
      eyebrow: "KI-Antworten gegenprüfen",
      title: "Nicht nur nebeneinander anzeigen, sondern Inhalte gegenprüfen",
      description: "Die parallele Ansicht zeigt Unterschiede. Tomverse AI Review ergänzt eine strukturierte zweite Lesart von Gemeinsamkeiten, Konflikten, Lücken und externem Prüfbedarf.",
      updated: "Geprüft am 15. Juli 2026",
      sections: [
        { title: "So funktioniert AI Review", body: "Nach zwei oder drei vollständigen Antworten wählen Sie eine ausgewogene, evidenz- oder handlungsorientierte Prüfung. Der Reviewer erhält anonyme A/B/C-Antworten und strukturiert Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken, Prüfbedarf, Stärken, Hinweise und optional eine vorsichtige Synthese.", bullets: ["Frage und Antworten gelten als nicht vertrauenswürdige Daten.", "Der Reviewer soll weder Gewinner wählen noch Modellidentitäten ableiten.", "Geschätzte Credits werden vorher angezeigt."] },
        { title: "Vorher und nachher", body: "Vorher müssen Nutzer einzelne Antworten lesen und Risiken selbst zuordnen. Nachher ist dasselbe Material nach Übereinstimmung, Konflikt, Lücke und Prüfbedarf geordnet. Das Beispiel oben dient der Veranschaulichung und ist kein aktuelles Faktenurteil." },
        { title: "Positions- und Stilbias bleiben möglich", body: "Tomverse mischt die Reihenfolge und verbirgt Modellnamen, um offensichtliche Positions- und Markenhinweise zu reduzieren. Einflüsse durch Reihenfolge, Länge, Formulierung, Stil, Prompt und Reviewer-Familie bleiben möglich. Nutzen Sie die Prüfung als zusätzliche Perspektive, nicht als objektive Wertung.", link: { label: "Studie zu Positionsbias lesen", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "Gegenprüfung ist kein Faktencheck", body: "AI Review durchsucht weder das Web noch externe Quellen. ‘Zu prüfen’ bedeutet Konflikt, fehlende Belege oder separaten Klärungsbedarf, nicht dass Tomverse Wahrheit oder Falschheit bewiesen hat. Wichtige Aussagen sind anhand aktueller Primärquellen zu prüfen." },
        { title: "Geeignete Aufgaben", body: "Geeignet für Einführungspläne, Codeansätze, Dokumentzusammenfassungen, Geschäftsentwürfe und Recherchepläne. Tests, Originaldokumente oder professionelle Prüfung ersetzt die Funktion nicht." },
      ],
    }),
    es: withCta("es", {
      metadataTitle: "Revisión cruzada de respuestas IA: acuerdos, contradicciones y vacíos",
      metadataDescription: "Usa Tomverse AI Review para revisar dos o tres respuestas de IA, sus acuerdos, contradicciones, omisiones y puntos por verificar.",
      eyebrow: "Revisión cruzada de respuestas IA",
      title: "Revisa el contenido, no solo la vista en paralelo",
      description: "La comparación paralela muestra diferencias. Tomverse AI Review añade una segunda lectura estructurada de acuerdos, conflictos, omisiones y verificaciones pendientes.",
      updated: "Revisado el 15 de julio de 2026",
      sections: [
        { title: "Cómo funciona AI Review", body: "Tras completar dos o tres respuestas, elige revisión equilibrada, centrada en evidencia o en acción. El revisor recibe respuestas anónimas A/B/C y estructura acuerdos, diferencias, contradicciones, omisiones, verificaciones, fortalezas, cautelas y una síntesis opcional.", bullets: ["La pregunta y las respuestas se tratan como datos no confiables.", "El revisor no debe elegir ganador ni inferir modelos.", "Los créditos estimados se muestran antes de ejecutar."] },
        { title: "Antes y después", body: "Antes, el usuario debe recorrer cada respuesta y recordar sus riesgos. Después, el mismo contenido se agrupa por acuerdo, conflicto, omisión y verificación. El ejemplo superior es ilustrativo y no un resultado factual en vivo." },
        { title: "Persisten sesgos de posición y estilo", body: "Tomverse aleatoriza el orden y oculta nombres para reducir pistas evidentes, pero no elimina influencias de posición, longitud, redacción, estilo, diseño del prompt o familia del revisor. Úsalo como otra perspectiva, no como puntuación objetiva o veredicto final.", link: { label: "Leer el estudio sobre sesgo posicional", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "La revisión cruzada no es fact-checking", body: "AI Review no navega ni consulta fuentes externas. ‘Necesita verificación’ señala conflicto, falta de apoyo o una afirmación que conviene confirmar; no prueba que sea verdadera o falsa. Verifica decisiones importantes con fuentes primarias actuales." },
        { title: "Cuándo resulta útil", body: "Úsalo para planes de lanzamiento, enfoques de código, resúmenes de documentos, borradores de negocio y esquemas de investigación. No sustituye pruebas, lectura del original ni revisión profesional." },
      ],
    }),
    pt: withCta("pt", {
      metadataTitle: "Revisão cruzada de respostas de IA: consensos, contradições e lacunas",
      metadataDescription: "Use o Tomverse AI Review para revisar duas ou três respostas de IA, seus consensos, contradições, omissões e pontos a verificar.",
      eyebrow: "Revisão cruzada de respostas de IA",
      title: "Revise o conteúdo, não apenas a visualização lado a lado",
      description: "A comparação lado a lado mostra diferenças. O Tomverse AI Review adiciona uma segunda leitura estruturada de consensos, conflitos, omissões e verificações pendentes.",
      updated: "Revisado em 15 de julho de 2026",
      sections: [
        { title: "Como funciona o AI Review", body: "Após duas ou três respostas completas, escolha revisão equilibrada, focada em evidências ou em ação. O revisor recebe respostas anônimas A/B/C e estrutura consensos, diferenças, contradições, omissões, verificações, pontos fortes, cautelas e síntese opcional.", bullets: ["Pergunta e respostas são tratadas como dados não confiáveis.", "O revisor não deve escolher vencedor nem inferir modelos.", "Os créditos estimados aparecem antes da execução."] },
        { title: "Antes e depois", body: "Antes, o usuário precisa ler cada resposta e lembrar seus riscos. Depois, o mesmo conteúdo é agrupado por consenso, conflito, omissão e verificação. O exemplo acima é ilustrativo, não um resultado factual ao vivo." },
        { title: "Vieses de posição e estilo continuam possíveis", body: "O Tomverse randomiza a ordem e oculta nomes para reduzir pistas óbvias, mas não elimina influências de posição, tamanho, redação, estilo, prompt ou família do revisor. Use a revisão como perspectiva adicional, não como nota objetiva ou veredito final.", link: { label: "Ler o estudo sobre viés de posição", href: "https://arxiv.org/abs/2406.07791", external: true } },
        { title: "Revisão cruzada não é checagem factual", body: "O AI Review não navega nem consulta fontes externas. ‘Precisa de verificação’ indica conflito, falta de suporte ou algo a confirmar; não prova que a alegação é verdadeira ou falsa. Verifique decisões importantes em fontes primárias atuais." },
        { title: "Quando é útil", body: "Use em planos de lançamento, abordagens de código, resumos de documentos, rascunhos comerciais e planos de pesquisa. Não substitui testes, leitura do original ou revisão profissional." },
      ],
    }),
  },
  "chatgpt-vs-claude": {
    en: withCta("en", {
      metadataTitle: "ChatGPT vs Claude (2026): Writing, Coding and Documents",
      metadataDescription: "Compare GPT and Claude for writing, coding, long documents, summaries, and instruction following with prompts, methodology, FAQ, and a side-by-side Tomverse test.",
      eyebrow: "Model comparison guide",
      title: "ChatGPT vs Claude: compare the answer, not the brand",
      description: "OpenAI GPT models and Anthropic Claude models are both broad AI assistants. Their results vary by model version, task, prompt, and context, so a direct test is more useful than a universal ranking.",
      updated: "Reviewed 14 July 2026 · GPT-5.4 mini and Claude Haiku 4.5",
      sections: [
        { title: "What should you compare?", body: "Define what a good answer means before you run the test: factual accuracy, reasoning clarity, instruction following, writing quality, code correctness, citation quality, or appropriate uncertainty." },
        { title: "Run a fair comparison", body: "Use the same prompt, attachments, and constraints for both models, then review complete answers rather than judging the first sentence.", bullets: ["Remove hints that favor a particular provider.", "Test representative tasks instead of one artificial prompt.", "Verify consequential outputs independently."] },
        { title: "Results change over time", body: "Providers release new models and update availability, pricing, and behavior. Tomverse shows the model that was selected and provides a public status page, but it does not guarantee that past comparisons predict future results." },
        { title: "Independent service notice", body: "Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic. ChatGPT, GPT, Claude, OpenAI, and Anthropic are names or trademarks of their respective owners." },
      ],
    }),
    ko: withCta("ko", {
      metadataTitle: "ChatGPT vs Claude 2026: 글쓰기·코딩·긴 문서 비교",
      metadataDescription: "글쓰기, 코딩, 긴 문서, 요약과 지시 이행을 기준으로 GPT와 Claude를 비교하고 프롬프트, 방법론, FAQ와 사전 선택 체험을 확인하세요.",
      eyebrow: "모델 비교 가이드",
      title: "ChatGPT vs Claude: 브랜드가 아닌 답변을 비교하세요",
      description: "OpenAI GPT와 Anthropic Claude는 모두 범용 AI 모델이지만 결과는 모델 버전, 작업, 질문과 맥락에 따라 달라집니다. 보편적인 순위보다 같은 조건의 직접 비교가 더 유용합니다.",
      updated: "2026년 7월 14일 검토 · GPT-5.4 mini 및 Claude Haiku 4.5",
      sections: [
        { title: "무엇을 비교해야 하나요?", body: "테스트 전에 좋은 답변의 기준을 정하세요. 사실 정확성, 추론의 명확성, 지시 이행, 글 품질, 코드 정확성, 출처와 적절한 불확실성 표현 등을 비교할 수 있습니다." },
        { title: "공정하게 비교하는 방법", body: "두 모델에 같은 질문, 첨부파일과 제약조건을 제공하고 첫 문장이 아닌 전체 답변을 검토하세요.", bullets: ["특정 공급자에 유리한 힌트를 제거합니다.", "하나의 인위적인 질문보다 실제 대표 작업을 테스트합니다.", "중요한 결과는 독립적으로 다시 검증합니다."] },
        { title: "결과는 달라질 수 있습니다", body: "공급자는 새 모델을 출시하고 가용성, 가격과 동작을 변경합니다. Tomverse는 선택한 모델과 공개 상태를 표시하지만 과거 비교가 미래 결과를 보장하지는 않습니다." },
        { title: "독립 서비스 안내", body: "Tomverse는 OpenAI 또는 Anthropic과 제휴하거나 보증받은 서비스가 아닙니다. ChatGPT, GPT, Claude, OpenAI, Anthropic 명칭과 상표는 각 소유자에게 귀속됩니다." },
      ],
    }),
    zh: withCta("zh", {
      metadataTitle: "ChatGPT 与 Claude 回答直接比较",
      metadataDescription: "在 Tomverse AI 中用相同提示词和评价标准直接比较可用的 OpenAI GPT 与 Anthropic Claude 模型回答。",
      eyebrow: "模型比较指南",
      title: "ChatGPT 与 Claude：比较回答，而不是品牌",
      description: "OpenAI GPT 与 Anthropic Claude 都是通用 AI 助手。结果会随模型版本、任务、提示词和上下文变化，因此直接测试比固定排名更有意义。",
      sections: [
        { title: "应该比较什么？", body: "测试前先定义优质回答的标准，例如事实准确性、推理清晰度、指令遵循、写作质量、代码正确性、引用质量和对不确定性的表达。" },
        { title: "进行公平比较", body: "向两个模型提供相同提示词、附件和约束，并审阅完整回答。", bullets: ["删除偏向某个提供商的暗示。", "测试有代表性的真实任务。", "独立核实影响重大的输出。"] },
        { title: "结果会随时间变化", body: "提供商会发布新模型并调整可用性、价格与行为。Tomverse 显示所选模型和公开状态，但过去的比较不能保证未来结果。" },
        { title: "独立服务说明", body: "Tomverse 是独立的多模型工作区，未获得 OpenAI 或 Anthropic 的关联或背书。相关名称和商标归各自所有者。" },
      ],
    }),
    fr: withCta("fr", {
      metadataTitle: "ChatGPT vs Claude : comparer directement les réponses",
      metadataDescription: "Comparez les réponses des modèles GPT d’OpenAI et Claude d’Anthropic disponibles avec le même prompt dans Tomverse AI.",
      eyebrow: "Guide de comparaison",
      title: "ChatGPT vs Claude : comparez la réponse, pas la marque",
      description: "Les modèles GPT d’OpenAI et Claude d’Anthropic sont des assistants généralistes. Les résultats varient selon la version, la tâche, le prompt et le contexte : un test direct vaut mieux qu’un classement universel.",
      sections: [
        { title: "Que faut-il comparer ?", body: "Définissez d’abord vos critères : exactitude, clarté du raisonnement, respect des consignes, qualité rédactionnelle, code, sources et expression de l’incertitude." },
        { title: "Comparer équitablement", body: "Donnez aux deux modèles le même prompt, les mêmes pièces jointes et contraintes, puis lisez les réponses complètes.", bullets: ["Retirez les indices favorisant un fournisseur.", "Testez des tâches réelles représentatives.", "Vérifiez indépendamment les résultats importants."] },
        { title: "Les résultats évoluent", body: "Les fournisseurs publient de nouveaux modèles et modifient disponibilité, prix et comportement. Une comparaison passée ne garantit pas un résultat futur." },
        { title: "Service indépendant", body: "Tomverse est un espace multi-modèle indépendant, sans affiliation ni approbation d’OpenAI ou d’Anthropic. Les noms et marques appartiennent à leurs propriétaires." },
      ],
    }),
    de: withCta("de", {
      metadataTitle: "ChatGPT vs Claude: Antworten direkt vergleichen",
      metadataDescription: "Vergleichen Sie verfügbare OpenAI-GPT- und Anthropic-Claude-Antworten mit demselben Prompt in Tomverse AI.",
      eyebrow: "Modellvergleich",
      title: "ChatGPT vs Claude: die Antwort statt der Marke vergleichen",
      description: "GPT-Modelle von OpenAI und Claude-Modelle von Anthropic sind vielseitige Assistenten. Ergebnisse hängen von Version, Aufgabe, Prompt und Kontext ab; ein direkter Test ist hilfreicher als ein pauschales Ranking.",
      sections: [
        { title: "Was sollte verglichen werden?", body: "Legen Sie Kriterien wie Faktenrichtigkeit, Klarheit, Anweisungsbefolgung, Schreibqualität, korrekten Code, Quellen und angemessene Unsicherheit vorab fest." },
        { title: "Fair vergleichen", body: "Geben Sie beiden Modellen denselben Prompt, dieselben Anhänge und Einschränkungen und prüfen Sie die vollständigen Antworten.", bullets: ["Entfernen Sie anbieterspezifische Hinweise.", "Testen Sie repräsentative echte Aufgaben.", "Prüfen Sie folgenreiche Ergebnisse unabhängig."] },
        { title: "Ergebnisse ändern sich", body: "Anbieter veröffentlichen neue Modelle und ändern Verfügbarkeit, Preise und Verhalten. Frühere Vergleiche garantieren keine zukünftigen Ergebnisse." },
        { title: "Unabhängiger Dienst", body: "Tomverse ist ein unabhängiger Multi-Modell-Workspace und nicht mit OpenAI oder Anthropic verbunden. Namen und Marken gehören ihren jeweiligen Inhabern." },
      ],
    }),
    es: withCta("es", {
      metadataTitle: "ChatGPT vs Claude: comparar respuestas directamente",
      metadataDescription: "Compara respuestas de modelos GPT de OpenAI y Claude de Anthropic disponibles con el mismo prompt en Tomverse AI.",
      eyebrow: "Guía de comparación",
      title: "ChatGPT vs Claude: compara la respuesta, no la marca",
      description: "Los modelos GPT de OpenAI y Claude de Anthropic son asistentes generales. Los resultados varían por versión, tarea, prompt y contexto, por lo que una prueba directa es más útil que una clasificación universal.",
      sections: [
        { title: "¿Qué deberías comparar?", body: "Define criterios como precisión factual, claridad, seguimiento de instrucciones, calidad de escritura, código correcto, fuentes y expresión adecuada de incertidumbre." },
        { title: "Haz una comparación justa", body: "Usa el mismo prompt, adjuntos y restricciones para ambos modelos y revisa las respuestas completas.", bullets: ["Elimina pistas que favorezcan a un proveedor.", "Prueba tareas reales representativas.", "Verifica de forma independiente los resultados importantes."] },
        { title: "Los resultados cambian", body: "Los proveedores publican modelos y modifican disponibilidad, precios y comportamiento. Una comparación anterior no garantiza resultados futuros." },
        { title: "Servicio independiente", body: "Tomverse es un espacio multimodelo independiente y no está afiliado ni respaldado por OpenAI o Anthropic. Los nombres y marcas pertenecen a sus propietarios." },
      ],
    }),
    pt: withCta("pt", {
      metadataTitle: "ChatGPT vs Claude: comparar respostas diretamente",
      metadataDescription: "Compare respostas de modelos GPT da OpenAI e Claude da Anthropic disponíveis com o mesmo prompt no Tomverse AI.",
      eyebrow: "Guia de comparação",
      title: "ChatGPT vs Claude: compare a resposta, não a marca",
      description: "Modelos GPT da OpenAI e Claude da Anthropic são assistentes gerais. Os resultados variam por versão, tarefa, prompt e contexto; um teste direto é mais útil do que um ranking universal.",
      sections: [
        { title: "O que comparar?", body: "Defina critérios como precisão factual, clareza, cumprimento de instruções, qualidade da escrita, código correto, fontes e expressão adequada de incerteza." },
        { title: "Faça uma comparação justa", body: "Use o mesmo prompt, anexos e restrições para ambos os modelos e analise as respostas completas.", bullets: ["Remova pistas que favoreçam um provedor.", "Teste tarefas reais representativas.", "Verifique resultados importantes de forma independente."] },
        { title: "Os resultados mudam", body: "Provedores lançam modelos e alteram disponibilidade, preços e comportamento. Uma comparação anterior não garante resultados futuros." },
        { title: "Serviço independente", body: "O Tomverse é um workspace multimodelo independente e não é afiliado nem endossado pela OpenAI ou Anthropic. Nomes e marcas pertencem aos respectivos titulares." },
      ],
    }),
  },
  "ai-for-file-analysis": {
    en: withCta("en", {
      metadataTitle: "AI File Analysis for PDFs, Office Files and Images",
      metadataDescription: "Use multiple AI models to summarize and analyze supported PDFs, Office documents, text files, and images in Tomverse AI.",
      eyebrow: "AI document workflow",
      title: "Analyze files with multiple AI models",
      description: "Tomverse lets signed-in users attach supported files and ask selected AI models to summarize, compare, explain, or extract useful context. File handling is bounded for security, reliability, and cost control.",
      sections: [
        { title: "Supported analysis workflows", body: "Use readable PDFs, DOCX, XLSX, PPTX, supported text files, and PNG, JPEG, or WebP images. Actual interpretation depends on the selected model and whether the document contains extractable content.", bullets: ["Summarize a report or presentation.", "Compare explanations from two or three models.", "Ask focused questions about tables, text, code, or an image."] },
        { title: "Prepare files for better results", body: "Use clear, non-corrupted files and ask a specific question. Password-protected, scanned, malformed, or very large documents may not contain extractable text. Check important numbers, citations, formulas, and conclusions against the original file." },
        { title: "Security boundaries", body: "Attachments require sign-in, are limited by type, count, and size, and are temporarily processed through private object storage. Files and extracted text are sent only to the selected model providers needed to answer the request. Do not upload content you lack permission to process." },
        { title: "Retention and provider processing", body: "Temporary attachment objects are removed by lifecycle and maintenance controls, currently after approximately one day. Provider-side processing is governed by each provider’s terms." },
      ],
    }),
    ko: withCta("ko", {
      metadataTitle: "PDF·Office·이미지 AI 파일 분석",
      metadataDescription: "Tomverse AI에서 여러 AI 모델을 이용해 지원되는 PDF, Office 문서, 텍스트 파일과 이미지를 요약하고 분석하세요.",
      eyebrow: "AI 문서 워크플로",
      title: "여러 AI 모델로 파일을 분석하세요",
      description: "로그인 사용자는 지원되는 파일을 첨부하고 선택한 AI 모델에 요약, 비교, 설명 또는 필요한 맥락 추출을 요청할 수 있습니다. 파일 처리는 보안, 안정성과 비용 통제를 위해 제한됩니다.",
      sections: [
        { title: "지원되는 분석 작업", body: "읽을 수 있는 PDF, DOCX, XLSX, PPTX, 지원 텍스트 파일과 PNG·JPEG·WebP 이미지를 사용할 수 있습니다. 실제 해석 범위는 선택한 모델과 문서에서 추출 가능한 내용에 따라 달라집니다.", bullets: ["보고서나 발표자료를 요약합니다.", "2~3개 모델의 설명을 비교합니다.", "표, 텍스트, 코드 또는 이미지에 대해 구체적으로 질문합니다."] },
        { title: "더 좋은 결과를 위한 준비", body: "손상되지 않은 명확한 파일과 구체적인 질문을 사용하세요. 암호화, 스캔, 손상 또는 지나치게 큰 문서는 텍스트를 추출하지 못할 수 있습니다. 중요한 숫자, 출처, 수식과 결론은 원본에서 확인해야 합니다." },
        { title: "보안 경계", body: "첨부파일은 로그인이 필요하며 형식, 개수와 크기가 제한됩니다. 비공개 객체 저장소를 통해 임시 처리되고, 답변에 필요한 선택 모델 공급자에게만 파일 또는 추출 텍스트가 전송됩니다. 처리 권한이 없는 자료는 업로드하면 안 됩니다." },
        { title: "보관과 공급자 처리", body: "임시 첨부 객체는 현재 약 하루 뒤 수명 주기와 유지관리 정책으로 삭제됩니다. 공급자 측 처리는 각 공급자의 약관을 따릅니다." },
      ],
    }),
    zh: withCta("zh", {
      metadataTitle: "使用 AI 分析 PDF、Office 文件和图片",
      metadataDescription: "在 Tomverse AI 中使用多个 AI 模型总结和分析支持的 PDF、Office 文档、文本文件与图片。",
      eyebrow: "AI 文档工作流",
      title: "使用多个 AI 模型分析文件",
      description: "登录用户可以附加支持的文件，并让所选模型进行总结、比较、解释或提取上下文。文件处理会受到安全、可靠性和成本限制。",
      sections: [
        { title: "支持的分析流程", body: "可使用可读取的 PDF、DOCX、XLSX、PPTX、支持的文本文件以及 PNG、JPEG、WebP 图片。实际理解能力取决于所选模型和可提取内容。", bullets: ["总结报告或演示文稿。", "比较两到三个模型的解释。", "针对表格、文本、代码或图片提问。"] },
        { title: "为更好结果准备文件", body: "请使用清晰、未损坏的文件并提出具体问题。加密、扫描、异常或过大的文档可能无法提取文字。重要数字、引用、公式和结论应对照原文件核实。" },
        { title: "安全边界", body: "附件需要登录，并受到类型、数量和大小限制。文件通过私有对象存储临时处理，仅发送给回答所需的所选模型提供商。请勿上传无权处理的内容。" },
        { title: "保留与提供商处理", body: "临时附件目前会在约一天后通过生命周期和维护策略删除。提供商侧处理受其条款约束。" },
      ],
    }),
    fr: withCta("fr", {
      metadataTitle: "Analyse IA de PDF, fichiers Office et images",
      metadataDescription: "Utilisez plusieurs modèles d’IA pour résumer et analyser les PDF, documents Office, textes et images pris en charge dans Tomverse AI.",
      eyebrow: "Flux documentaire IA",
      title: "Analysez des fichiers avec plusieurs modèles d’IA",
      description: "Les utilisateurs connectés peuvent joindre des fichiers pris en charge et demander aux modèles sélectionnés de résumer, comparer, expliquer ou extraire un contexte utile. Le traitement est limité pour la sécurité et la fiabilité.",
      sections: [
        { title: "Flux d’analyse pris en charge", body: "Utilisez des PDF lisibles, DOCX, XLSX, PPTX, fichiers texte pris en charge et images PNG, JPEG ou WebP. L’interprétation dépend du modèle et du contenu extractible.", bullets: ["Résumer un rapport ou une présentation.", "Comparer deux ou trois explications.", "Interroger un tableau, du texte, du code ou une image."] },
        { title: "Préparer les fichiers", body: "Utilisez un fichier clair et non corrompu avec une question précise. Les documents protégés, scannés, malformés ou trop volumineux peuvent être illisibles. Vérifiez chiffres, sources, formules et conclusions dans l’original." },
        { title: "Limites de sécurité", body: "Les pièces jointes exigent une connexion et sont limitées par type, nombre et taille. Elles sont traitées temporairement dans un stockage objet privé et transmises uniquement aux fournisseurs sélectionnés nécessaires." },
        { title: "Conservation", body: "Les objets temporaires sont actuellement supprimés après environ un jour. Le traitement côté fournisseur suit ses propres conditions." },
      ],
    }),
    de: withCta("de", {
      metadataTitle: "KI-Dateianalyse für PDFs, Office-Dateien und Bilder",
      metadataDescription: "Fassen Sie unterstützte PDFs, Office-Dokumente, Textdateien und Bilder mit mehreren KI-Modellen in Tomverse AI zusammen und analysieren Sie sie.",
      eyebrow: "KI-Dokumentenworkflow",
      title: "Dateien mit mehreren KI-Modellen analysieren",
      description: "Angemeldete Nutzer können unterstützte Dateien anhängen und ausgewählte Modelle um Zusammenfassung, Vergleich, Erklärung oder Kontextextraktion bitten. Sicherheits-, Zuverlässigkeits- und Kostenlimits gelten.",
      sections: [
        { title: "Unterstützte Abläufe", body: "Verwenden Sie lesbare PDFs, DOCX, XLSX, PPTX, unterstützte Textdateien sowie PNG-, JPEG- oder WebP-Bilder. Die Interpretation hängt vom Modell und extrahierbaren Inhalt ab.", bullets: ["Berichte oder Präsentationen zusammenfassen.", "Erklärungen von zwei oder drei Modellen vergleichen.", "Gezielt nach Tabellen, Text, Code oder Bildern fragen."] },
        { title: "Dateien vorbereiten", body: "Nutzen Sie klare, unbeschädigte Dateien und konkrete Fragen. Geschützte, gescannte, fehlerhafte oder sehr große Dokumente können unlesbar sein. Prüfen Sie Zahlen, Quellen, Formeln und Schlussfolgerungen im Original." },
        { title: "Sicherheitsgrenzen", body: "Anhänge erfordern eine Anmeldung und sind nach Typ, Anzahl und Größe begrenzt. Sie werden temporär im privaten Objektspeicher verarbeitet und nur an benötigte ausgewählte Anbieter gesendet." },
        { title: "Aufbewahrung", body: "Temporäre Anhänge werden derzeit nach etwa einem Tag entfernt. Die Verarbeitung beim Anbieter folgt dessen Bedingungen." },
      ],
    }),
    es: withCta("es", {
      metadataTitle: "Análisis de archivos PDF, Office e imágenes con IA",
      metadataDescription: "Usa varios modelos de IA para resumir y analizar PDF, documentos Office, archivos de texto e imágenes compatibles en Tomverse AI.",
      eyebrow: "Flujo documental con IA",
      title: "Analiza archivos con varios modelos de IA",
      description: "Los usuarios con sesión pueden adjuntar archivos compatibles y pedir a los modelos seleccionados que resuman, comparen, expliquen o extraigan contexto. El procesamiento tiene límites de seguridad y fiabilidad.",
      sections: [
        { title: "Flujos compatibles", body: "Usa PDF legibles, DOCX, XLSX, PPTX, archivos de texto compatibles e imágenes PNG, JPEG o WebP. La interpretación depende del modelo y del contenido extraíble.", bullets: ["Resume un informe o presentación.", "Compara explicaciones de dos o tres modelos.", "Pregunta por tablas, texto, código o imágenes."] },
        { title: "Prepara los archivos", body: "Usa archivos claros y no dañados con una pregunta concreta. Los documentos protegidos, escaneados, malformados o muy grandes pueden no ser legibles. Verifica cifras, citas, fórmulas y conclusiones con el original." },
        { title: "Límites de seguridad", body: "Los adjuntos requieren inicio de sesión y se limitan por tipo, cantidad y tamaño. Se procesan temporalmente en almacenamiento privado y solo se envían a los proveedores seleccionados necesarios." },
        { title: "Retención", body: "Los objetos temporales se eliminan actualmente tras aproximadamente un día. El tratamiento del proveedor se rige por sus condiciones." },
      ],
    }),
    pt: withCta("pt", {
      metadataTitle: "Análise de PDFs, arquivos Office e imagens com IA",
      metadataDescription: "Use vários modelos de IA para resumir e analisar PDFs, documentos Office, textos e imagens compatíveis no Tomverse AI.",
      eyebrow: "Fluxo de documentos com IA",
      title: "Analise arquivos com vários modelos de IA",
      description: "Usuários conectados podem anexar arquivos compatíveis e pedir aos modelos selecionados que resumam, comparem, expliquem ou extraiam contexto. O processamento tem limites de segurança e confiabilidade.",
      sections: [
        { title: "Fluxos compatíveis", body: "Use PDFs legíveis, DOCX, XLSX, PPTX, arquivos de texto compatíveis e imagens PNG, JPEG ou WebP. A interpretação depende do modelo e do conteúdo extraível.", bullets: ["Resuma um relatório ou apresentação.", "Compare explicações de dois ou três modelos.", "Pergunte sobre tabelas, texto, código ou imagens."] },
        { title: "Prepare os arquivos", body: "Use arquivos claros e não corrompidos com uma pergunta específica. Documentos protegidos, digitalizados, malformados ou muito grandes podem não ser legíveis. Confira números, citações, fórmulas e conclusões no original." },
        { title: "Limites de segurança", body: "Anexos exigem login e são limitados por tipo, quantidade e tamanho. São processados temporariamente em armazenamento privado e enviados apenas aos provedores selecionados necessários." },
        { title: "Retenção", body: "Objetos temporários são atualmente removidos após cerca de um dia. O processamento do provedor segue seus termos." },
      ],
    }),
  },
};
