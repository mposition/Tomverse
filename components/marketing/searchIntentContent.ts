import type { Language } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "./MarketingInfoPage";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

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

export const searchIntentPages: Record<SearchIntentSlug, Record<Language, SearchIntentCopy>> = {
  "compare-ai-models": {
    "en": {
      "metadataTitle": "Compare AI Models and Cross-Review Their Answers",
      "metadataDescription": "Compare leading AI models with one prompt, then use Tomverse AI Review to organize agreements, contradictions, omissions, and verification needs.",
      "eyebrow": "AI model comparison",
      "title": "Compare AI models, then cross-review their answers",
      "description": "The most useful model depends on the task, prompt, context, and current version. Tomverse sends one question to multiple models, then AI Review helps organize where their completed answers agree, conflict, omit details, or need verification.",
      "sections": [
        {
          "title": "Why compare more than one model?",
          "body": "AI models can differ in reasoning style, concision, coding approach, writing tone, and how they handle uncertainty. A side-by-side comparison makes those differences visible without repeatedly copying the same prompt between separate products."
        },
        {
          "title": "A repeatable comparison workflow",
          "body": "Check whether you can explain a learning answer in your own words, whether a message keeps your intent, and whether a document summary preserves dates, numbers and conditions. Use the same input and criteria for every model.",
          "bullets": [
            "Use the same instructions and context for every selected model.",
            "Check factual claims and important decisions against primary sources.",
            "Ask follow-up questions when an answer is unclear or incomplete."
          ]
        },
        {
          "title": "Go beyond side-by-side with AI Review",
          "body": "After the answers are complete, Tomverse AI Review can organize their common ground, important differences, contradictions, omissions, and claims that need external verification. It compares only the supplied answers: it does not browse, fact-check, or declare a correct winner.",
          "link": {
            "label": "See how AI answer cross-review works",
            "href": "/ai-answer-review"
          }
        },
        {
          "title": "Questions to compare in everyday life",
          "body": "Compare an explanation of a difficult concept, a kind but clear refusal to a friend, or dates and items to bring in a club notice. Check that your original conditions survive; then extend the same approach to drafts, work documents or code when needed."
        },
        {
          "title": "Privacy and cost awareness",
          "body": "Prompts and necessary context are sent to each selected AI provider. Avoid unnecessary sensitive data, review provider terms, and select only the number of models needed for the task."
        }
      ],
      "cta": {
        "label": "Start comparing",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=en`
      }
    },
    "ko": {
      "metadataTitle": "AI 모델 답변 비교와 교차검토",
      "metadataDescription": "같은 질문을 여러 AI 모델에 보내 답변을 비교하고 Tomverse AI Review로 합의점, 모순, 누락과 검증 필요 항목을 확인하세요.",
      "eyebrow": "AI 모델 비교",
      "title": "여러 AI 모델을 비교한 뒤 답변까지 교차검토하세요",
      "description": "가장 유용한 모델은 작업, 질문, 맥락과 현재 버전에 따라 달라집니다. Tomverse는 한 질문을 여러 모델에 보내고, AI Review로 완료된 답변의 합의점, 충돌, 누락과 검증 필요 항목을 구조화합니다.",
      "sections": [
        {
          "title": "왜 여러 모델을 비교하나요?",
          "body": "모델마다 추론 방식, 답변 길이, 코드 접근법, 문체와 불확실성을 표현하는 방식이 다를 수 있습니다. 나란히 비교하면 여러 서비스에 같은 질문을 반복해서 복사하지 않고 차이를 확인할 수 있습니다."
        },
        {
          "title": "재현 가능한 비교 방법",
          "body": "설명은 내가 이해하고 다시 말할 수 있는지, 메시지는 내 의도를 유지하는지, 문서 요약은 날짜·숫자·조건을 빠뜨리지 않는지 살펴보세요. 같은 입력과 기준을 모든 모델에 적용하면 비교가 쉬워집니다.",
          "bullets": [
            "모든 모델에 동일한 지시와 맥락을 제공합니다.",
            "중요한 사실과 결정은 1차 출처로 다시 확인합니다.",
            "불명확하거나 빠진 내용은 후속 질문으로 확인합니다."
          ]
        },
        {
          "title": "나란히 비교한 뒤 AI Review",
          "body": "답변이 완료되면 Tomverse AI Review가 합의점, 중요한 차이, 모순, 누락과 외부 검증이 필요한 주장을 구조화합니다. 제공된 답변끼리만 비교하며 웹 검색, 사실검증 또는 정답 판정을 수행하지 않습니다.",
          "link": {
            "label": "AI 답변 교차검토 방식 보기",
            "href": "/ko/ai-answer-review"
          }
        },
        {
          "title": "일상에서 비교해 볼 질문",
          "body": "어려운 개념을 쉽게 설명해 달라고 하거나, 친구의 부탁을 부드럽게 거절하는 메시지를 다듬거나, 동호회 공지에서 일정과 준비물을 찾아보세요. 답변에 원래 조건이 남아 있는지 먼저 확인하고, 필요할 때 글 초안·업무 자료·코드 검토로 넓힐 수 있습니다."
        },
        {
          "title": "개인정보와 비용",
          "body": "질문과 필요한 맥락은 선택한 각 AI 공급자에게 전송됩니다. 불필요한 민감정보를 제외하고 작업에 필요한 모델 수만 선택하세요."
        }
      ],
      "cta": {
        "label": "모델 비교 시작하기",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=ko`
      }
    },
    "zh": {
      "metadataTitle": "比较多个 AI 模型并交叉审查回答",
      "metadataDescription": "向多个 AI 模型发送同一问题，然后使用 Tomverse AI Review 整理共识、矛盾、遗漏和待核实项目。",
      "eyebrow": "AI 模型比较",
      "title": "比较多个 AI 模型，再交叉审查回答",
      "description": "最合适的模型取决于任务、提示词、上下文和当前版本。Tomverse 将同一问题发送给多个模型，并用 AI Review 整理回答的共识、冲突、遗漏和待核实项目。",
      "sections": [
        {
          "title": "为什么要比较模型？",
          "body": "不同模型在推理方式、篇幅、代码方案、写作风格和不确定性表达上可能不同。并排显示能减少在多个产品之间重复复制提示词。"
        },
        {
          "title": "可重复的比较流程",
          "body": "学习解释是否能让你用自己的话复述？消息是否保留你的意图？文档摘要是否保留日期、数字与条件？对所有模型使用相同输入和标准，更容易比较。",
          "bullets": [
            "向所有模型提供相同指令和上下文。",
            "用一手来源核实重要事实与决定。",
            "通过追问澄清遗漏或含糊之处。"
          ]
        },
        {
          "title": "从并排比较到 AI Review",
          "body": "回答完成后，Tomverse AI Review 可整理共识、重要差异、矛盾、遗漏和需要外部核实的说法。它只比较提供的回答，不浏览网页、不进行事实核验，也不判定唯一正确答案。",
          "link": {
            "label": "了解 AI 回答交叉审查",
            "href": "/zh/ai-answer-review"
          }
        },
        {
          "title": "日常可以比较的问题",
          "body": "可以比较难懂概念的通俗解释、温和而明确地拒绝朋友的消息，或社团通知中的日期与准备物品。先检查原有条件是否保留，再按需要用于草稿、工作资料或代码审查。"
        },
        {
          "title": "隐私与成本",
          "body": "提示词和必要上下文会发送给每个所选 AI 提供商。请避免不必要的敏感信息，并只选择任务所需的模型数量。"
        }
      ],
      "cta": {
        "label": "开始比较",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=zh`
      }
    },
    "fr": {
      "metadataTitle": "Comparer les modèles d’IA et revoir leurs réponses",
      "metadataDescription": "Envoyez la même demande à plusieurs modèles, puis utilisez Tomverse AI Review pour structurer accords, contradictions, omissions et vérifications.",
      "eyebrow": "Comparaison de modèles d’IA",
      "title": "Comparez les modèles d’IA puis examinez leurs réponses",
      "description": "Le modèle le plus utile dépend de la tâche, du prompt, du contexte et de sa version. Tomverse envoie la même question à plusieurs modèles puis structure avec AI Review leurs accords, conflits, omissions et vérifications.",
      "sections": [
        {
          "title": "Pourquoi comparer plusieurs modèles ?",
          "body": "Les modèles peuvent différer dans leur raisonnement, leur concision, leur approche du code, leur ton et leur gestion de l’incertitude. La vue côte à côte rend ces différences visibles sans copier le prompt entre plusieurs services."
        },
        {
          "title": "Une méthode reproductible",
          "body": "Vérifiez si une explication vous permet de reformuler l’idée, si un message respecte votre intention et si un résumé conserve dates, chiffres et conditions. Appliquez les mêmes entrées et critères à tous les modèles.",
          "bullets": [
            "Fournissez le même contexte à chaque modèle.",
            "Vérifiez les faits importants auprès de sources primaires.",
            "Posez des questions de suivi pour clarifier les lacunes."
          ]
        },
        {
          "title": "Au-delà du côte à côte avec AI Review",
          "body": "Une fois les réponses terminées, Tomverse AI Review structure accords, différences, contradictions, omissions et points à vérifier à l’extérieur. Il compare uniquement les réponses fournies : ce n’est ni une recherche Web, ni une vérification factuelle, ni un verdict.",
          "link": {
            "label": "Découvrir la revue croisée des réponses",
            "href": "/fr/ai-answer-review"
          }
        },
        {
          "title": "Des questions à comparer au quotidien",
          "body": "Comparez l’explication d’un concept difficile, un refus aimable mais clair à un ami ou les dates et objets à apporter d’une annonce de club. Vérifiez d’abord que vos conditions sont conservées, puis appliquez la méthode aux brouillons, documents professionnels ou au code."
        },
        {
          "title": "Confidentialité et coûts",
          "body": "Le prompt et le contexte nécessaire sont transmis à chaque fournisseur choisi. Évitez les données sensibles inutiles et limitez le nombre de modèles à ce dont vous avez besoin."
        }
      ],
      "cta": {
        "label": "Commencer la comparaison",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=fr`
      }
    },
    "de": {
      "metadataTitle": "KI-Modelle vergleichen und Antworten gegenprüfen",
      "metadataDescription": "Senden Sie dieselbe Frage an mehrere KI-Modelle und ordnen Sie mit Tomverse AI Review Gemeinsamkeiten, Widersprüche, Lücken und Prüfbedarf.",
      "eyebrow": "KI-Modellvergleich",
      "title": "KI-Modelle vergleichen und Antworten gegenprüfen",
      "description": "Welches Modell passt, hängt von Aufgabe, Prompt, Kontext und Version ab. Tomverse sendet eine Frage an mehrere Modelle und strukturiert mit AI Review Gemeinsamkeiten, Konflikte, Lücken und Prüfbedarf.",
      "sections": [
        {
          "title": "Warum mehrere Modelle vergleichen?",
          "body": "Modelle unterscheiden sich mitunter bei Argumentation, Kürze, Codeansatz, Schreibstil und Unsicherheit. Die parallele Ansicht zeigt diese Unterschiede, ohne Prompts zwischen Diensten zu kopieren."
        },
        {
          "title": "Ein wiederholbarer Ablauf",
          "body": "Prüfen Sie, ob Sie eine Erklärung selbst wiedergeben können, eine Nachricht Ihre Absicht bewahrt und eine Zusammenfassung Termine, Zahlen und Bedingungen enthält. Verwenden Sie für alle Modelle dieselben Eingaben und Kriterien.",
          "bullets": [
            "Geben Sie allen Modellen denselben Kontext.",
            "Prüfen Sie wichtige Aussagen anhand von Primärquellen.",
            "Klären Sie Lücken mit Folgefragen."
          ]
        },
        {
          "title": "Nach dem Vergleich: AI Review",
          "body": "Nach Abschluss der Antworten ordnet Tomverse AI Review Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken und extern zu prüfende Aussagen. Es vergleicht nur die gelieferten Antworten und ist weder Websuche noch Faktenprüfung oder endgültiges Urteil.",
          "link": {
            "label": "So funktioniert die Antwort-Gegenprüfung",
            "href": "/de/ai-answer-review"
          }
        },
        {
          "title": "Fragen aus dem Alltag vergleichen",
          "body": "Vergleichen Sie eine einfache Erklärung, eine freundliche und klare Absage oder Termine und Mitbringsel aus einer Vereinsnachricht. Prüfen Sie zuerst Ihre ursprünglichen Bedingungen und nutzen Sie das Vorgehen bei Bedarf auch für Entwürfe, Arbeitsunterlagen oder Code."
        },
        {
          "title": "Datenschutz und Kosten",
          "body": "Prompt und nötiger Kontext gehen an jeden gewählten Anbieter. Vermeiden Sie unnötige sensible Daten und wählen Sie nur benötigte Modelle."
        }
      ],
      "cta": {
        "label": "Vergleich starten",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=de`
      }
    },
    "es": {
      "metadataTitle": "Comparar modelos de IA y revisar sus respuestas",
      "metadataDescription": "Envía la misma pregunta a varios modelos y usa Tomverse AI Review para organizar acuerdos, contradicciones, omisiones y verificaciones.",
      "eyebrow": "Comparación de modelos de IA",
      "title": "Compara modelos de IA y revisa sus respuestas",
      "description": "El modelo más útil depende de la tarea, el prompt, el contexto y la versión. Tomverse envía una pregunta a varios modelos y AI Review estructura acuerdos, conflictos, omisiones y verificaciones.",
      "sections": [
        {
          "title": "¿Por qué comparar varios modelos?",
          "body": "Los modelos pueden diferir en razonamiento, concisión, enfoque de código, tono y manejo de la incertidumbre. La vista paralela muestra esas diferencias sin copiar el prompt entre productos."
        },
        {
          "title": "Un proceso repetible",
          "body": "Comprueba si puedes explicar una idea con tus palabras, si un mensaje conserva tu intención y si un resumen mantiene fechas, cifras y condiciones. Usa la misma entrada y los mismos criterios para todos los modelos.",
          "bullets": [
            "Proporciona el mismo contexto a cada modelo.",
            "Verifica afirmaciones importantes con fuentes primarias.",
            "Usa preguntas de seguimiento para aclarar vacíos."
          ]
        },
        {
          "title": "Más allá del paralelo con AI Review",
          "body": "Cuando terminan las respuestas, Tomverse AI Review organiza acuerdos, diferencias, contradicciones, omisiones y afirmaciones que requieren verificación externa. Solo compara lo proporcionado: no navega, no verifica hechos ni declara una respuesta correcta.",
          "link": {
            "label": "Ver cómo funciona la revisión cruzada",
            "href": "/es/ai-answer-review"
          }
        },
        {
          "title": "Preguntas cotidianas para comparar",
          "body": "Compara una explicación sencilla, una negativa amable y clara a un amigo o las fechas y qué llevar de un aviso del club. Revisa primero que se mantengan tus condiciones y amplía el método a borradores, documentos de trabajo o código cuando lo necesites."
        },
        {
          "title": "Privacidad y costes",
          "body": "El prompt y el contexto necesario se envían a cada proveedor elegido. Evita datos sensibles innecesarios y selecciona solo los modelos necesarios."
        }
      ],
      "cta": {
        "label": "Empezar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=es`
      }
    },
    "pt": {
      "metadataTitle": "Comparar modelos de IA e revisar suas respostas",
      "metadataDescription": "Envie a mesma pergunta a vários modelos e use o Tomverse AI Review para organizar consensos, contradições, omissões e verificações.",
      "eyebrow": "Comparação de modelos de IA",
      "title": "Compare modelos de IA e revise suas respostas",
      "description": "O modelo mais útil depende da tarefa, do prompt, do contexto e da versão. O Tomverse envia uma pergunta a vários modelos e o AI Review estrutura consensos, conflitos, omissões e verificações.",
      "sections": [
        {
          "title": "Por que comparar vários modelos?",
          "body": "Os modelos podem diferir em raciocínio, concisão, abordagem de código, tom e tratamento da incerteza. A visualização paralela mostra essas diferenças sem copiar o prompt entre serviços."
        },
        {
          "title": "Um processo repetível",
          "body": "Veja se consegue explicar uma ideia com suas palavras, se uma mensagem preserva sua intenção e se um resumo mantém datas, números e condições. Use a mesma entrada e os mesmos critérios em todos os modelos.",
          "bullets": [
            "Forneça o mesmo contexto a cada modelo.",
            "Verifique afirmações importantes em fontes primárias.",
            "Use perguntas de acompanhamento para esclarecer lacunas."
          ]
        },
        {
          "title": "Além da comparação com AI Review",
          "body": "Após as respostas, o Tomverse AI Review organiza consensos, diferenças, contradições, omissões e alegações que exigem verificação externa. Ele compara somente o conteúdo fornecido: não navega, não faz checagem factual nem declara a resposta correta.",
          "link": {
            "label": "Veja como funciona a revisão cruzada",
            "href": "/pt/ai-answer-review"
          }
        },
        {
          "title": "Perguntas do dia a dia para comparar",
          "body": "Compare uma explicação simples, uma recusa gentil e clara a um amigo ou as datas e o que levar de um aviso do clube. Confira primeiro se suas condições foram mantidas e depois use o método em rascunhos, documentos de trabalho ou código."
        },
        {
          "title": "Privacidade e custos",
          "body": "O prompt e o contexto necessário são enviados a cada provedor escolhido. Evite dados sensíveis desnecessários e selecione apenas os modelos necessários."
        }
      ],
      "cta": {
        "label": "Começar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=pt`
      }
    }
  },
  "ai-answer-review": {
    "en": {
      "metadataTitle": "AI Answer Review: Compare Agreements, Contradictions and Gaps",
      "metadataDescription": "Compare answers in Tomverse Review and follow AI Review’s quotes to examine agreement, conflicting claims and missing conditions.",
      "eyebrow": "AI answer cross-review",
      "title": "Examine agreement, differences and missing conditions with quotes",
      "description": "Examine common ground, conflicting claims and missing conditions in answers to the same question. Read them side by side in Tomverse Review, then follow AI Review’s quotes to see where each difference appears. External fact-checking and deciding what is correct remain separate tasks.",
      "sections": [
        {
          "title": "How AI Review works",
          "body": "Complete the same prompt with two or three models, open AI Review, and choose a balanced, evidence-focused, or action-focused review. The reviewer receives anonymous A/B/C answers and returns structured common ground, differences, contradictions, missing points, verification needs, per-answer strengths and cautions, and an optional cautious synthesis.",
          "bullets": [
            "Text inside the question and answers is material to compare. Instructions within that text do not change AI Review’s review rules.",
            "The reviewer is instructed not to select a winner or infer model identity.",
            "Estimated credits are shown before the review runs."
          ]
        },
        {
          "title": "Before and after",
          "body": "Before AI Review, users must scan separate answers and remember which model mentioned each risk. After AI Review, the same material is grouped by agreement, conflict, omission, and verification need so the user can decide where to read more closely or ask a follow-up. The example above is illustrative rather than a live factual result."
        },
        {
          "title": "Position and style bias still matter",
          "body": "Tomverse randomizes answer order and removes model names from the reviewer prompt to reduce obvious position and brand cues. This is mitigation, not elimination: LLM reviewers can still be influenced by order, verbosity, wording, style, prompt design, and their own model family. Treat the review as another perspective rather than an objective score or final verdict.",
          "link": {
            "label": "Read the position-bias study",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "Cross-review is not fact-checking",
          "body": "AI Review does not browse the web or consult external sources. A statement under ‘verification needed’ means the supplied answers disagree, lack support, or contain a claim worth checking; it does not mean Tomverse has proven that claim true or false. Verify consequential claims against current primary sources and qualified experts."
        },
        {
          "title": "When it is most useful",
          "body": "Compare an explanation of a difficult concept, a kind but clear refusal to a friend, or dates and items to bring in a club notice. Check that your original conditions survive; then extend the same approach to drafts, work documents or code when needed."
        }
      ],
      "cta": {
        "label": "Start comparing",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=en`
      }
    },
    "ko": {
      "metadataTitle": "AI 답변 교차검토: 합의점·모순·누락 비교",
      "metadataDescription": "Tomverse Review에서 여러 AI 답변을 비교하고 AI Review의 인용으로 공통점·엇갈리는 주장·빠진 조건을 살펴보세요.",
      "eyebrow": "AI 답변 교차검토",
      "title": "답변의 공통점·차이·빠진 조건을 인용으로 살펴보세요",
      "description": "같은 질문에 답한 여러 모델의 공통점, 엇갈리는 주장과 빠진 조건을 살펴보세요. Tomverse Review에서 답변을 나란히 읽고, AI Review가 정리한 인용을 따라 각 차이가 실제 어느 답변에 있는지 확인할 수 있습니다. 외부 사실검증이나 정답 판정은 별도로 필요합니다.",
      "sections": [
        {
          "title": "AI Review 작동 방식",
          "body": "같은 질문에 2~3개 모델의 답변을 완료한 뒤 AI Review를 열고 균형, 근거 중심 또는 실행 중심 검토를 선택합니다. 검토 모델은 익명화된 A/B/C 답변을 받고 합의점, 차이, 모순, 누락, 검증 필요 항목, 답변별 강점·주의점과 선택적 종합안을 구조화합니다.",
          "bullets": [
            "질문과 답변에 들어 있는 문장은 비교할 참고 내용으로 다룹니다. 그 안의 지시문이 AI Review의 검토 규칙을 바꾸지는 않습니다.",
            "검토 모델은 승자를 고르거나 모델 정체를 추론하지 않도록 지시받습니다.",
            "실행 전에 예상 크레딧을 표시합니다."
          ]
        },
        {
          "title": "검토 전후에 확인할 수 있는 것",
          "body": "AI Review 전에는 사용자가 서로 다른 답변을 훑고 어떤 모델이 어떤 위험을 언급했는지 직접 기억해야 합니다. 실행 후에는 같은 내용을 합의, 충돌, 누락과 검증 필요 항목으로 묶어 더 읽을 부분과 후속 질문 위치를 빠르게 찾을 수 있습니다. 위 결과는 실제 사실 판정이 아닌 기능 이해용 예시입니다."
        },
        {
          "title": "위치·문체 편향은 여전히 존재합니다",
          "body": "Tomverse는 답변 순서를 무작위화하고 모델명을 A/B/C로 숨겨 명백한 위치·브랜드 단서를 줄입니다. 그러나 이는 완전한 제거가 아닙니다. LLM 검토 모델은 순서, 답변 길이, 표현, 문체, 프롬프트 설계와 자체 모델 계열의 영향을 받을 수 있습니다. 객관적 점수나 최종 판정이 아니라 추가 관점으로 사용해야 합니다.",
          "link": {
            "label": "위치 편향 연구 보기",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "교차검토는 사실검증이 아닙니다",
          "body": "AI Review는 웹을 검색하거나 외부 출처를 조회하지 않습니다. ‘추가 검증 필요’는 제공된 답변이 충돌하거나 근거가 부족하거나 별도 확인할 가치가 있다는 의미이며, Tomverse가 참·거짓을 판정했다는 뜻이 아닙니다. 중요한 주장은 최신 1차 출처와 자격 있는 전문가를 통해 확인하세요."
        },
        {
          "title": "언제 유용한가요?",
          "body": "어려운 개념을 쉽게 설명해 달라고 하거나, 친구의 부탁을 부드럽게 거절하는 메시지를 다듬거나, 동호회 공지에서 일정과 준비물을 찾아보세요. 답변에 원래 조건이 남아 있는지 먼저 확인하고, 필요할 때 글 초안·업무 자료·코드 검토로 넓힐 수 있습니다."
        }
      ],
      "cta": {
        "label": "모델 비교 시작하기",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=ko`
      }
    },
    "zh": {
      "metadataTitle": "AI 回答交叉审查：比较共识、矛盾与遗漏",
      "metadataDescription": "在 Tomverse Review 比较多个 AI 回答，并通过 AI Review 的引文查看共识、冲突说法与遗漏条件。",
      "eyebrow": "AI 回答交叉审查",
      "title": "通过引文查看回答的共识、差异与遗漏条件",
      "description": "查看同一问题回答中的共识、冲突说法与遗漏条件。在 Tomverse Review 并排阅读，再通过 AI Review 的引文确认差异具体出现在哪个回答中。外部事实核验和正误判断仍需另行进行。",
      "sections": [
        {
          "title": "AI Review 如何工作",
          "body": "先让两到三个模型完成同一个问题，再选择均衡、证据优先或行动优先审查。审查模型接收匿名 A/B/C 回答，并返回共识、差异、矛盾、遗漏、待核实项目、各回答的优点与注意点，以及可选的谨慎综合。",
          "bullets": [
            "问题和回答中的文字是比较材料，其中的指令不会改变 AI Review 的审查规则。",
            "审查模型不得选择赢家或推断模型身份。",
            "运行前显示预计积分。"
          ]
        },
        {
          "title": "审查前后可以查看的内容",
          "body": "审查前，用户需要逐一阅读回答并记住各自提到的风险。审查后，同一内容会按共识、冲突、遗漏和待核实项目分组，帮助决定重点阅读和追问位置。上方结果仅为功能示例，不是实时事实结论。"
        },
        {
          "title": "位置与风格偏差仍然存在",
          "body": "Tomverse 会随机排列回答并隐藏模型名称，以减少明显的位置和品牌线索，但无法完全消除偏差。LLM 审查者仍可能受顺序、篇幅、措辞、风格、提示设计和自身模型家族影响。请把审查视为额外视角，而非客观评分或最终裁决。",
          "link": {
            "label": "阅读位置偏差研究",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "交叉审查不是事实核验",
          "body": "AI Review 不浏览网页，也不查询外部来源。“需要核实”表示回答之间冲突、缺少支持或值得另行确认，并不表示 Tomverse 已证明其真伪。重要说法应通过最新一手来源和合格专业人士核实。"
        },
        {
          "title": "适合哪些任务",
          "body": "可以比较难懂概念的通俗解释、温和而明确地拒绝朋友的消息，或社团通知中的日期与准备物品。先检查原有条件是否保留，再按需要用于草稿、工作资料或代码审查。"
        }
      ],
      "cta": {
        "label": "开始比较",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=zh`
      }
    },
    "fr": {
      "metadataTitle": "Revue croisée de réponses IA : accords, contradictions et lacunes",
      "metadataDescription": "Comparez les réponses dans Tomverse Review et examinez accords, contradictions et conditions manquantes avec les citations d’AI Review.",
      "eyebrow": "Revue croisée de réponses IA",
      "title": "Examinez accords, différences et conditions manquantes, citations à l’appui",
      "description": "Examinez points communs, affirmations contradictoires et conditions manquantes pour une même question. Lisez les réponses dans Tomverse Review, puis suivez les citations d’AI Review pour retrouver chaque différence. La vérification externe et le choix de ce qui est correct restent distincts.",
      "sections": [
        {
          "title": "Fonctionnement d’AI Review",
          "body": "Une fois deux ou trois réponses terminées, choisissez une revue équilibrée, centrée sur les preuves ou sur l’action. Le réviseur reçoit des réponses anonymes A/B/C et structure accords, différences, contradictions, omissions, vérifications, forces, réserves et synthèse optionnelle.",
          "bullets": [
            "Le texte des questions et réponses constitue le matériau à comparer. Ses instructions ne modifient pas les règles d’AI Review.",
            "Le réviseur ne doit ni choisir de gagnant ni déduire le modèle.",
            "Le coût estimé en crédits est affiché avant l’exécution."
          ]
        },
        {
          "title": "Avant et après",
          "body": "Avant, l’utilisateur doit parcourir chaque réponse et mémoriser ses risques. Après, le même contenu est regroupé par accord, conflit, omission et vérification afin de cibler lecture et relances. L’exemple ci-dessus illustre la fonction et ne constitue pas un résultat factuel en direct."
        },
        {
          "title": "Les biais de position et de style subsistent",
          "body": "Tomverse randomise l’ordre et masque les noms des modèles pour réduire les indices évidents. Cela n’élimine pas l’influence possible de l’ordre, de la longueur, de la formulation, du style, du prompt ou de la famille du réviseur. Utilisez la revue comme une perspective supplémentaire, pas comme un verdict objectif.",
          "link": {
            "label": "Lire l’étude sur le biais de position",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "La revue croisée n’est pas une vérification factuelle",
          "body": "AI Review ne navigue pas sur le Web et ne consulte aucune source externe. Un point à vérifier signale un conflit, un manque d’appui ou une affirmation à contrôler, sans prouver qu’elle est vraie ou fausse. Vérifiez les décisions importantes dans des sources primaires actuelles."
        },
        {
          "title": "Usages pertinents",
          "body": "Comparez l’explication d’un concept difficile, un refus aimable mais clair à un ami ou les dates et objets à apporter d’une annonce de club. Vérifiez d’abord que vos conditions sont conservées, puis appliquez la méthode aux brouillons, documents professionnels ou au code."
        }
      ],
      "cta": {
        "label": "Commencer la comparaison",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=fr`
      }
    },
    "de": {
      "metadataTitle": "KI-Antworten gegenprüfen: Gemeinsamkeiten, Widersprüche und Lücken",
      "metadataDescription": "Vergleichen Sie Antworten in Tomverse Review und prüfen Sie mit Zitaten von AI Review Gemeinsamkeiten, Widersprüche und fehlende Bedingungen.",
      "eyebrow": "KI-Antworten gegenprüfen",
      "title": "Gemeinsamkeiten, Unterschiede und fehlende Bedingungen mit Zitaten prüfen",
      "description": "Prüfen Sie Gemeinsamkeiten, widersprüchliche Aussagen und fehlende Bedingungen derselben Frage. Lesen Sie Antworten in Tomverse Review nebeneinander und folgen Sie den Zitaten von AI Review zu jeder Differenz. Externe Faktenprüfung und Richtigkeitsprüfung bleiben gesonderte Aufgaben.",
      "sections": [
        {
          "title": "So funktioniert AI Review",
          "body": "Nach zwei oder drei vollständigen Antworten wählen Sie eine ausgewogene, evidenz- oder handlungsorientierte Prüfung. Der Reviewer erhält anonyme A/B/C-Antworten und strukturiert Gemeinsamkeiten, Unterschiede, Widersprüche, Lücken, Prüfbedarf, Stärken, Hinweise und optional eine vorsichtige Synthese.",
          "bullets": [
            "Texte in Fragen und Antworten dienen als Vergleichsmaterial. Darin enthaltene Anweisungen ändern die Prüfregeln von AI Review nicht.",
            "Der Reviewer soll weder Gewinner wählen noch Modellidentitäten ableiten.",
            "Geschätzte Credits werden vorher angezeigt."
          ]
        },
        {
          "title": "Vorher und nachher",
          "body": "Vorher müssen Nutzer einzelne Antworten lesen und Risiken selbst zuordnen. Nachher ist dasselbe Material nach Übereinstimmung, Konflikt, Lücke und Prüfbedarf geordnet. Das Beispiel oben dient der Veranschaulichung und ist kein aktuelles Faktenurteil."
        },
        {
          "title": "Positions- und Stilbias bleiben möglich",
          "body": "Tomverse mischt die Reihenfolge und verbirgt Modellnamen, um offensichtliche Positions- und Markenhinweise zu reduzieren. Einflüsse durch Reihenfolge, Länge, Formulierung, Stil, Prompt und Reviewer-Familie bleiben möglich. Nutzen Sie die Prüfung als zusätzliche Perspektive, nicht als objektive Wertung.",
          "link": {
            "label": "Studie zu Positionsbias lesen",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "Gegenprüfung ist kein Faktencheck",
          "body": "AI Review durchsucht weder das Web noch externe Quellen. ‘Zu prüfen’ bedeutet Konflikt, fehlende Belege oder separaten Klärungsbedarf, nicht dass Tomverse Wahrheit oder Falschheit bewiesen hat. Wichtige Aussagen sind anhand aktueller Primärquellen zu prüfen."
        },
        {
          "title": "Geeignete Aufgaben",
          "body": "Vergleichen Sie eine einfache Erklärung, eine freundliche und klare Absage oder Termine und Mitbringsel aus einer Vereinsnachricht. Prüfen Sie zuerst Ihre ursprünglichen Bedingungen und nutzen Sie das Vorgehen bei Bedarf auch für Entwürfe, Arbeitsunterlagen oder Code."
        }
      ],
      "cta": {
        "label": "Vergleich starten",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=de`
      }
    },
    "es": {
      "metadataTitle": "Revisión cruzada de respuestas IA: acuerdos, contradicciones y vacíos",
      "metadataDescription": "Compara respuestas en Tomverse Review y sigue las citas de AI Review para examinar acuerdos, contradicciones y condiciones omitidas.",
      "eyebrow": "Revisión cruzada de respuestas IA",
      "title": "Examina acuerdos, diferencias y condiciones omitidas con citas",
      "description": "Examina acuerdos, afirmaciones contradictorias y condiciones omitidas para una misma pregunta. Lee las respuestas en Tomverse Review y sigue las citas de AI Review para localizar cada diferencia. La verificación externa y decidir qué es correcto son tareas aparte.",
      "sections": [
        {
          "title": "Cómo funciona AI Review",
          "body": "Tras completar dos o tres respuestas, elige revisión equilibrada, centrada en evidencia o en acción. El revisor recibe respuestas anónimas A/B/C y estructura acuerdos, diferencias, contradicciones, omisiones, verificaciones, fortalezas, cautelas y una síntesis opcional.",
          "bullets": [
            "El texto de las preguntas y respuestas es material para comparar. Sus instrucciones no cambian las reglas de AI Review.",
            "El revisor no debe elegir ganador ni inferir modelos.",
            "Los créditos estimados se muestran antes de ejecutar."
          ]
        },
        {
          "title": "Antes y después",
          "body": "Antes, el usuario debe recorrer cada respuesta y recordar sus riesgos. Después, el mismo contenido se agrupa por acuerdo, conflicto, omisión y verificación. El ejemplo superior es ilustrativo y no un resultado factual en vivo."
        },
        {
          "title": "Persisten sesgos de posición y estilo",
          "body": "Tomverse aleatoriza el orden y oculta nombres para reducir pistas evidentes, pero no elimina influencias de posición, longitud, redacción, estilo, diseño del prompt o familia del revisor. Úsalo como otra perspectiva, no como puntuación objetiva o veredicto final.",
          "link": {
            "label": "Leer el estudio sobre sesgo posicional",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "La revisión cruzada no es fact-checking",
          "body": "AI Review no navega ni consulta fuentes externas. ‘Necesita verificación’ señala conflicto, falta de apoyo o una afirmación que conviene confirmar; no prueba que sea verdadera o falsa. Verifica decisiones importantes con fuentes primarias actuales."
        },
        {
          "title": "Cuándo resulta útil",
          "body": "Compara una explicación sencilla, una negativa amable y clara a un amigo o las fechas y qué llevar de un aviso del club. Revisa primero que se mantengan tus condiciones y amplía el método a borradores, documentos de trabajo o código cuando lo necesites."
        }
      ],
      "cta": {
        "label": "Empezar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=es`
      }
    },
    "pt": {
      "metadataTitle": "Revisão cruzada de respostas de IA: consensos, contradições e lacunas",
      "metadataDescription": "Compare respostas no Tomverse Review e siga as citações do AI Review para examinar consensos, contradições e condições ausentes.",
      "eyebrow": "Revisão cruzada de respostas de IA",
      "title": "Veja consensos, diferenças e condições ausentes com citações",
      "description": "Examine consensos, afirmações conflitantes e condições ausentes para a mesma pergunta. Leia as respostas no Tomverse Review e siga as citações do AI Review para localizar cada diferença. Verificação externa e decidir o que está correto são tarefas separadas.",
      "sections": [
        {
          "title": "Como funciona o AI Review",
          "body": "Após duas ou três respostas completas, escolha revisão equilibrada, focada em evidências ou em ação. O revisor recebe respostas anônimas A/B/C e estrutura consensos, diferenças, contradições, omissões, verificações, pontos fortes, cautelas e síntese opcional.",
          "bullets": [
            "O texto das perguntas e respostas é material de comparação. Instruções dentro dele não alteram as regras do AI Review.",
            "O revisor não deve escolher vencedor nem inferir modelos.",
            "Os créditos estimados aparecem antes da execução."
          ]
        },
        {
          "title": "Antes e depois",
          "body": "Antes, o usuário precisa ler cada resposta e lembrar seus riscos. Depois, o mesmo conteúdo é agrupado por consenso, conflito, omissão e verificação. O exemplo acima é ilustrativo, não um resultado factual ao vivo."
        },
        {
          "title": "Vieses de posição e estilo continuam possíveis",
          "body": "O Tomverse randomiza a ordem e oculta nomes para reduzir pistas óbvias, mas não elimina influências de posição, tamanho, redação, estilo, prompt ou família do revisor. Use a revisão como perspectiva adicional, não como nota objetiva ou veredito final.",
          "link": {
            "label": "Ler o estudo sobre viés de posição",
            "href": "https://arxiv.org/abs/2406.07791",
            "external": true
          }
        },
        {
          "title": "Revisão cruzada não é checagem factual",
          "body": "O AI Review não navega nem consulta fontes externas. ‘Precisa de verificação’ indica conflito, falta de suporte ou algo a confirmar; não prova que a alegação é verdadeira ou falsa. Verifique decisões importantes em fontes primárias atuais."
        },
        {
          "title": "Quando é útil",
          "body": "Compare uma explicação simples, uma recusa gentil e clara a um amigo ou as datas e o que levar de um aviso do clube. Confira primeiro se suas condições foram mantidas e depois use o método em rascunhos, documentos de trabalho ou código."
        }
      ],
      "cta": {
        "label": "Começar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=pt`
      }
    }
  },
  "chatgpt-vs-claude": {
    "en": {
      "metadataTitle": "ChatGPT vs Claude (2026): Writing, Coding and Documents",
      "metadataDescription": "Compare GPT and Claude for writing, coding, long documents, summaries, and instruction following with prompts, methodology, FAQ, and a side-by-side Tomverse test.",
      "eyebrow": "Model comparison guide",
      "title": "ChatGPT vs Claude: compare the answer, not the brand",
      "description": "OpenAI GPT models and Anthropic Claude models are both broad AI assistants. Their results vary by model version, task, prompt, and context, so a direct test is more useful than a universal ranking.",
      "sections": [
        {
          "title": "What should you compare?",
          "body": "Check whether you can explain a learning answer in your own words, whether a message keeps your intent, and whether a document summary preserves dates, numbers and conditions. Use the same input and criteria for every model."
        },
        {
          "title": "Run a fair comparison",
          "body": "Use the same prompt, attachments, and constraints for both models, then review complete answers rather than judging the first sentence.",
          "bullets": [
            "Remove hints that favor a particular provider.",
            "Test representative tasks instead of one artificial prompt.",
            "Verify consequential outputs independently."
          ]
        },
        {
          "title": "Results change over time",
          "body": "Providers release new models and update availability, pricing, and behavior. Tomverse shows the model that was selected and provides a public status page, but it does not guarantee that past comparisons predict future results."
        },
        {
          "title": "Independent service notice",
          "body": "Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic. ChatGPT, GPT, Claude, OpenAI, and Anthropic are names or trademarks of their respective owners."
        }
      ],
      "cta": {
        "label": "Start comparing",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=en`
      }
    },
    "ko": {
      "metadataTitle": "ChatGPT vs Claude 2026: 글쓰기·코딩·긴 문서 비교",
      "metadataDescription": "글쓰기, 코딩, 긴 문서, 요약과 지시 이행을 기준으로 GPT와 Claude를 비교하고 프롬프트, 방법론, FAQ와 사전 선택 체험을 확인하세요.",
      "eyebrow": "모델 비교 가이드",
      "title": "ChatGPT vs Claude: 브랜드가 아닌 답변을 비교하세요",
      "description": "OpenAI GPT와 Anthropic Claude는 모두 범용 AI 모델이지만 결과는 모델 버전, 작업, 질문과 맥락에 따라 달라집니다. 보편적인 순위보다 같은 조건의 직접 비교가 더 유용합니다.",
      "sections": [
        {
          "title": "무엇을 비교해야 하나요?",
          "body": "설명은 내가 이해하고 다시 말할 수 있는지, 메시지는 내 의도를 유지하는지, 문서 요약은 날짜·숫자·조건을 빠뜨리지 않는지 살펴보세요. 같은 입력과 기준을 모든 모델에 적용하면 비교가 쉬워집니다."
        },
        {
          "title": "공정하게 비교하는 방법",
          "body": "두 모델에 같은 질문, 첨부파일과 제약조건을 제공하고 첫 문장이 아닌 전체 답변을 검토하세요.",
          "bullets": [
            "특정 공급자에 유리한 힌트를 제거합니다.",
            "하나의 인위적인 질문보다 실제 대표 작업을 테스트합니다.",
            "중요한 결과는 독립적으로 다시 검증합니다."
          ]
        },
        {
          "title": "결과는 달라질 수 있습니다",
          "body": "공급자는 새 모델을 출시하고 가용성, 가격과 동작을 변경합니다. Tomverse는 선택한 모델과 공개 상태를 표시하지만 과거 비교가 미래 결과를 보장하지는 않습니다."
        },
        {
          "title": "독립 서비스 안내",
          "body": "Tomverse는 OpenAI 또는 Anthropic과 제휴하거나 보증받은 서비스가 아닙니다. ChatGPT, GPT, Claude, OpenAI, Anthropic 명칭과 상표는 각 소유자에게 귀속됩니다."
        }
      ],
      "cta": {
        "label": "모델 비교 시작하기",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=ko`
      }
    },
    "zh": {
      "metadataTitle": "ChatGPT 与 Claude 回答直接比较",
      "metadataDescription": "在 Tomverse 中用相同提示词和评价标准直接比较可用的 OpenAI GPT 与 Anthropic Claude 模型回答。",
      "eyebrow": "模型比较指南",
      "title": "ChatGPT 与 Claude：比较回答，而不是品牌",
      "description": "OpenAI GPT 与 Anthropic Claude 都是通用 AI 助手。结果会随模型版本、任务、提示词和上下文变化，因此直接测试比固定排名更有意义。",
      "sections": [
        {
          "title": "应该比较什么？",
          "body": "学习解释是否能让你用自己的话复述？消息是否保留你的意图？文档摘要是否保留日期、数字与条件？对所有模型使用相同输入和标准，更容易比较。"
        },
        {
          "title": "进行公平比较",
          "body": "向两个模型提供相同提示词、附件和约束，并审阅完整回答。",
          "bullets": [
            "删除偏向某个提供商的暗示。",
            "测试有代表性的真实任务。",
            "独立核实影响重大的输出。"
          ]
        },
        {
          "title": "结果会随时间变化",
          "body": "提供商会发布新模型并调整可用性、价格与行为。Tomverse 显示所选模型和公开状态，但过去的比较不能保证未来结果。"
        },
        {
          "title": "独立服务说明",
          "body": "Tomverse 是独立的多模型工作区，未获得 OpenAI 或 Anthropic 的关联或背书。相关名称和商标归各自所有者。"
        }
      ],
      "cta": {
        "label": "开始比较",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=zh`
      }
    },
    "fr": {
      "metadataTitle": "ChatGPT vs Claude : comparer directement les réponses",
      "metadataDescription": "Comparez les réponses des modèles GPT d’OpenAI et Claude d’Anthropic disponibles avec le même prompt dans Tomverse.",
      "eyebrow": "Guide de comparaison",
      "title": "ChatGPT vs Claude : comparez la réponse, pas la marque",
      "description": "Les modèles GPT d’OpenAI et Claude d’Anthropic sont des assistants généralistes. Les résultats varient selon la version, la tâche, le prompt et le contexte : un test direct vaut mieux qu’un classement universel.",
      "sections": [
        {
          "title": "Que faut-il comparer ?",
          "body": "Vérifiez si une explication vous permet de reformuler l’idée, si un message respecte votre intention et si un résumé conserve dates, chiffres et conditions. Appliquez les mêmes entrées et critères à tous les modèles."
        },
        {
          "title": "Comparer équitablement",
          "body": "Donnez aux deux modèles le même prompt, les mêmes pièces jointes et contraintes, puis lisez les réponses complètes.",
          "bullets": [
            "Retirez les indices favorisant un fournisseur.",
            "Testez des tâches réelles représentatives.",
            "Vérifiez indépendamment les résultats importants."
          ]
        },
        {
          "title": "Les résultats évoluent",
          "body": "Les fournisseurs publient de nouveaux modèles et modifient disponibilité, prix et comportement. Une comparaison passée ne garantit pas un résultat futur."
        },
        {
          "title": "Service indépendant",
          "body": "Tomverse est un espace multi-modèle indépendant, sans affiliation ni approbation d’OpenAI ou d’Anthropic. Les noms et marques appartiennent à leurs propriétaires."
        }
      ],
      "cta": {
        "label": "Commencer la comparaison",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=fr`
      }
    },
    "de": {
      "metadataTitle": "ChatGPT vs Claude: Antworten direkt vergleichen",
      "metadataDescription": "Vergleichen Sie verfügbare OpenAI-GPT- und Anthropic-Claude-Antworten mit demselben Prompt in Tomverse.",
      "eyebrow": "Modellvergleich",
      "title": "ChatGPT vs Claude: die Antwort statt der Marke vergleichen",
      "description": "GPT-Modelle von OpenAI und Claude-Modelle von Anthropic sind vielseitige Assistenten. Ergebnisse hängen von Version, Aufgabe, Prompt und Kontext ab; ein direkter Test ist hilfreicher als ein pauschales Ranking.",
      "sections": [
        {
          "title": "Was sollte verglichen werden?",
          "body": "Prüfen Sie, ob Sie eine Erklärung selbst wiedergeben können, eine Nachricht Ihre Absicht bewahrt und eine Zusammenfassung Termine, Zahlen und Bedingungen enthält. Verwenden Sie für alle Modelle dieselben Eingaben und Kriterien."
        },
        {
          "title": "Fair vergleichen",
          "body": "Geben Sie beiden Modellen denselben Prompt, dieselben Anhänge und Einschränkungen und prüfen Sie die vollständigen Antworten.",
          "bullets": [
            "Entfernen Sie anbieterspezifische Hinweise.",
            "Testen Sie repräsentative echte Aufgaben.",
            "Prüfen Sie folgenreiche Ergebnisse unabhängig."
          ]
        },
        {
          "title": "Ergebnisse ändern sich",
          "body": "Anbieter veröffentlichen neue Modelle und ändern Verfügbarkeit, Preise und Verhalten. Frühere Vergleiche garantieren keine zukünftigen Ergebnisse."
        },
        {
          "title": "Unabhängiger Dienst",
          "body": "Tomverse ist ein unabhängiger Multi-Modell-Workspace und nicht mit OpenAI oder Anthropic verbunden. Namen und Marken gehören ihren jeweiligen Inhabern."
        }
      ],
      "cta": {
        "label": "Vergleich starten",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=de`
      }
    },
    "es": {
      "metadataTitle": "ChatGPT vs Claude: comparar respuestas directamente",
      "metadataDescription": "Compara respuestas de modelos GPT de OpenAI y Claude de Anthropic disponibles con el mismo prompt en Tomverse.",
      "eyebrow": "Guía de comparación",
      "title": "ChatGPT vs Claude: compara la respuesta, no la marca",
      "description": "Los modelos GPT de OpenAI y Claude de Anthropic son asistentes generales. Los resultados varían por versión, tarea, prompt y contexto, por lo que una prueba directa es más útil que una clasificación universal.",
      "sections": [
        {
          "title": "¿Qué deberías comparar?",
          "body": "Comprueba si puedes explicar una idea con tus palabras, si un mensaje conserva tu intención y si un resumen mantiene fechas, cifras y condiciones. Usa la misma entrada y los mismos criterios para todos los modelos."
        },
        {
          "title": "Haz una comparación justa",
          "body": "Usa el mismo prompt, adjuntos y restricciones para ambos modelos y revisa las respuestas completas.",
          "bullets": [
            "Elimina pistas que favorezcan a un proveedor.",
            "Prueba tareas reales representativas.",
            "Verifica de forma independiente los resultados importantes."
          ]
        },
        {
          "title": "Los resultados cambian",
          "body": "Los proveedores publican modelos y modifican disponibilidad, precios y comportamiento. Una comparación anterior no garantiza resultados futuros."
        },
        {
          "title": "Servicio independiente",
          "body": "Tomverse es un espacio multimodelo independiente y no está afiliado ni respaldado por OpenAI o Anthropic. Los nombres y marcas pertenecen a sus propietarios."
        }
      ],
      "cta": {
        "label": "Empezar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=es`
      }
    },
    "pt": {
      "metadataTitle": "ChatGPT vs Claude: comparar respostas diretamente",
      "metadataDescription": "Compare respostas de modelos GPT da OpenAI e Claude da Anthropic disponíveis com o mesmo prompt no Tomverse.",
      "eyebrow": "Guia de comparação",
      "title": "ChatGPT vs Claude: compare a resposta, não a marca",
      "description": "Modelos GPT da OpenAI e Claude da Anthropic são assistentes gerais. Os resultados variam por versão, tarefa, prompt e contexto; um teste direto é mais útil do que um ranking universal.",
      "sections": [
        {
          "title": "O que comparar?",
          "body": "Veja se consegue explicar uma ideia com suas palavras, se uma mensagem preserva sua intenção e se um resumo mantém datas, números e condições. Use a mesma entrada e os mesmos critérios em todos os modelos."
        },
        {
          "title": "Faça uma comparação justa",
          "body": "Use o mesmo prompt, anexos e restrições para ambos os modelos e analise as respostas completas.",
          "bullets": [
            "Remova pistas que favoreçam um provedor.",
            "Teste tarefas reais representativas.",
            "Verifique resultados importantes de forma independente."
          ]
        },
        {
          "title": "Os resultados mudam",
          "body": "Provedores lançam modelos e alteram disponibilidade, preços e comportamento. Uma comparação anterior não garante resultados futuros."
        },
        {
          "title": "Serviço independente",
          "body": "O Tomverse é um workspace multimodelo independente e não é afiliado nem endossado pela OpenAI ou Anthropic. Nomes e marcas pertencem aos respectivos titulares."
        }
      ],
      "cta": {
        "label": "Começar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=pt`
      }
    }
  },
  "ai-for-file-analysis": {
    "en": {
      "metadataTitle": "AI File Analysis for PDFs, Office Files and Images",
      "metadataDescription": "Use multiple AI models to summarize and analyze supported PDFs, Office documents, text files, and images in Tomverse.",
      "eyebrow": "AI document workflow",
      "title": "Analyze files with multiple AI models",
      "description": "Extract the meeting date, what to bring and the reply deadline from a club notice. Ask for an undecided venue to stay marked as undecided, with a supporting sentence for each item. Readable PDFs, Office documents, supported text and images can be used; interpretation depends on the file and model.",
      "sections": [
        {
          "title": "Supported analysis workflows",
          "body": "Extract the meeting date, what to bring and the reply deadline from a club notice. Ask for an undecided venue to stay marked as undecided, with a supporting sentence for each item. Readable PDFs, Office documents, supported text and images can be used; interpretation depends on the file and model.",
          "bullets": [
            "Extract dates, items to bring and reply deadlines",
            "Compare whether a summary keeps the original dates and conditions",
            "Mark information absent from the material as unknown"
          ]
        },
        {
          "title": "Prepare files for better results",
          "body": "Use clear, non-corrupted files and ask a specific question. Password-protected, scanned, malformed, or very large documents may not contain extractable text. Check important numbers, citations, formulas, and conclusions against the original file."
        },
        {
          "title": "Security boundaries",
          "body": "Where guest attachments are offered, you can send one supported image or readable document up to 5 MiB. Signed-in accounts with attachment access can send up to five files per message, 10 MiB each and 25 MiB combined. Google Drive requires sign-in. The selected AI providers process the required file content; upload only material you are allowed to use."
        },
        {
          "title": "Retention and provider processing",
          "body": "Attachments sent from a signed-in account are kept with the conversation and scheduled for deletion when that conversation or account is deleted. Guest files are temporary, scoped to the session and removed automatically; they are not included in saved conversations, shares or exports. Provider-side processing follows each provider’s terms."
        }
      ],
      "cta": {
        "label": "Start comparing",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=en`
      }
    },
    "ko": {
      "metadataTitle": "PDF·Office·이미지 AI 파일 분석",
      "metadataDescription": "Tomverse에서 여러 AI 모델을 이용해 지원되는 PDF, Office 문서, 텍스트 파일과 이미지를 요약하고 분석하세요.",
      "eyebrow": "AI 문서 워크플로",
      "title": "여러 AI 모델로 파일을 분석하세요",
      "description": "동호회 공지에서 모임 날짜·준비물·회신 기한을 찾아보세요. 자료에 없는 장소는 미정이라고 표시하도록 요청하고, 각 항목의 근거 문장도 함께 받아 원문과 대조할 수 있습니다. 읽을 수 있는 PDF, Office 문서, 지원 텍스트와 이미지를 사용할 수 있으며 해석은 파일 내용과 모델에 따라 달라집니다.",
      "sections": [
        {
          "title": "지원되는 분석 작업",
          "body": "동호회 공지에서 모임 날짜·준비물·회신 기한을 찾아보세요. 자료에 없는 장소는 미정이라고 표시하도록 요청하고, 각 항목의 근거 문장도 함께 받아 원문과 대조할 수 있습니다. 읽을 수 있는 PDF, Office 문서, 지원 텍스트와 이미지를 사용할 수 있으며 해석은 파일 내용과 모델에 따라 달라집니다.",
          "bullets": [
            "공지의 일정·준비물·회신 기한 추출",
            "요약에 원문 날짜와 조건이 남았는지 비교",
            "자료에 없는 정보는 모름으로 표시"
          ]
        },
        {
          "title": "더 좋은 결과를 위한 준비",
          "body": "손상되지 않은 명확한 파일과 구체적인 질문을 사용하세요. 암호화, 스캔, 손상 또는 지나치게 큰 문서는 텍스트를 추출하지 못할 수 있습니다. 중요한 숫자, 출처, 수식과 결론은 원본에서 확인해야 합니다."
        },
        {
          "title": "보안 경계",
          "body": "첨부가 제공되는 게스트 체험에서는 지원 이미지·읽을 수 있는 문서 1개를 최대 5MiB까지 보낼 수 있습니다. 첨부 권한이 있는 로그인 계정은 메시지당 최대 5개, 각 10MiB, 합계 25MiB까지 사용할 수 있습니다. Google Drive 연결에는 로그인이 필요합니다. 필요한 파일 내용은 선택한 AI 제공자가 처리하므로 업로드 권한이 있는 자료만 사용하세요."
        },
        {
          "title": "보관과 공급자 처리",
          "body": "로그인 계정에서 전송한 첨부파일은 대화와 함께 보관되며 대화 또는 계정을 삭제하면 삭제 처리 대상이 됩니다. 게스트 파일은 해당 세션의 임시 자료로 자동 삭제되며 저장 대화·공유·내보내기에 포함되지 않습니다. AI 제공자 측 처리는 각 제공자의 약관을 따릅니다."
        }
      ],
      "cta": {
        "label": "모델 비교 시작하기",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=ko`
      }
    },
    "zh": {
      "metadataTitle": "使用 AI 分析 PDF、Office 文件和图片",
      "metadataDescription": "在 Tomverse 中使用多个 AI 模型总结和分析支持的 PDF、Office 文档、文本文件与图片。",
      "eyebrow": "AI 文档工作流",
      "title": "使用多个 AI 模型分析文件",
      "description": "从社团通知中找出活动日期、准备物品和回复截止时间。要求把未确定的地点标为待定，并为每项附上依据句子。可使用可读 PDF、Office 文档、支持的文本和图片；解读取决于文件与模型。",
      "sections": [
        {
          "title": "支持的分析流程",
          "body": "从社团通知中找出活动日期、准备物品和回复截止时间。要求把未确定的地点标为待定，并为每项附上依据句子。可使用可读 PDF、Office 文档、支持的文本和图片；解读取决于文件与模型。",
          "bullets": [
            "提取日期、准备物品与回复期限",
            "比较摘要是否保留原文日期与条件",
            "将资料中没有的信息标为未知"
          ]
        },
        {
          "title": "为更好结果准备文件",
          "body": "请使用清晰、未损坏的文件并提出具体问题。加密、扫描、异常或过大的文档可能无法提取文字。重要数字、引用、公式和结论应对照原文件核实。"
        },
        {
          "title": "安全边界",
          "body": "在提供访客附件的体验中，可发送一个不超过 5 MiB 的支持图片或可读文档。拥有附件权限的登录账户每条消息最多五个文件，每个 10 MiB，总计 25 MiB。连接 Google Drive 需要登录。所选 AI 提供商会处理必要文件内容，请只上传有权使用的资料。"
        },
        {
          "title": "保留与提供商处理",
          "body": "登录账户发送的附件随对话保存，删除对话或账户时会进入删除处理。访客文件是限定于当前会话的临时资料，会自动删除，不包含在保存的对话、分享或导出中。提供商侧处理遵循各自条款。"
        }
      ],
      "cta": {
        "label": "开始比较",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=zh`
      }
    },
    "fr": {
      "metadataTitle": "Analyse IA de PDF, fichiers Office et images",
      "metadataDescription": "Utilisez plusieurs modèles d’IA pour résumer et analyser les PDF, documents Office, textes et images pris en charge dans Tomverse.",
      "eyebrow": "Flux documentaire IA",
      "title": "Analysez des fichiers avec plusieurs modèles d’IA",
      "description": "Retrouvez la date, les objets à apporter et le délai de réponse dans une annonce de club. Demandez de laisser un lieu non fixé comme indéterminé et de citer une phrase pour chaque élément. Les PDF lisibles, documents Office, textes et images pris en charge conviennent ; l’interprétation dépend du fichier et du modèle.",
      "sections": [
        {
          "title": "Flux d’analyse pris en charge",
          "body": "Retrouvez la date, les objets à apporter et le délai de réponse dans une annonce de club. Demandez de laisser un lieu non fixé comme indéterminé et de citer une phrase pour chaque élément. Les PDF lisibles, documents Office, textes et images pris en charge conviennent ; l’interprétation dépend du fichier et du modèle.",
          "bullets": [
            "Extraire dates, objets à apporter et délais",
            "Vérifier les dates et conditions conservées",
            "Signaler comme inconnues les informations absentes"
          ]
        },
        {
          "title": "Préparer les fichiers",
          "body": "Utilisez un fichier clair et non corrompu avec une question précise. Les documents protégés, scannés, malformés ou trop volumineux peuvent être illisibles. Vérifiez chiffres, sources, formules et conclusions dans l’original."
        },
        {
          "title": "Limites de sécurité",
          "body": "Lorsque les pièces jointes sont proposées aux visiteurs, vous pouvez envoyer une image prise en charge ou un document lisible de 5 Mio maximum. Les comptes connectés autorisés peuvent envoyer cinq fichiers par message, 10 Mio chacun et 25 Mio au total. Google Drive nécessite une connexion. Les fournisseurs d’IA choisis traitent le contenu nécessaire ; utilisez uniquement des documents que vous êtes autorisé à transmettre."
        },
        {
          "title": "Conservation",
          "body": "Les pièces jointes envoyées depuis un compte connecté sont conservées avec la conversation et leur suppression est programmée quand celle-ci ou le compte est supprimé. Les fichiers visiteurs sont temporaires, limités à la session et supprimés automatiquement ; ils ne figurent pas dans les conversations enregistrées, partages ou exports. Le traitement par les fournisseurs suit leurs conditions."
        }
      ],
      "cta": {
        "label": "Commencer la comparaison",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=fr`
      }
    },
    "de": {
      "metadataTitle": "KI-Dateianalyse für PDFs, Office-Dateien und Bilder",
      "metadataDescription": "Fassen Sie unterstützte PDFs, Office-Dokumente, Textdateien und Bilder mit mehreren KI-Modellen in Tomverse zusammen und analysieren Sie sie.",
      "eyebrow": "KI-Dokumentenworkflow",
      "title": "Dateien mit mehreren KI-Modellen analysieren",
      "description": "Ermitteln Sie Termin, Mitbringsel und Antwortfrist aus einer Vereinsnachricht. Lassen Sie einen offenen Ort als offen markieren und zu jedem Punkt einen Belegsatz angeben. Lesbare PDFs, Office-Dokumente sowie unterstützte Texte und Bilder sind möglich; die Auswertung hängt von Datei und Modell ab.",
      "sections": [
        {
          "title": "Unterstützte Abläufe",
          "body": "Ermitteln Sie Termin, Mitbringsel und Antwortfrist aus einer Vereinsnachricht. Lassen Sie einen offenen Ort als offen markieren und zu jedem Punkt einen Belegsatz angeben. Lesbare PDFs, Office-Dokumente sowie unterstützte Texte und Bilder sind möglich; die Auswertung hängt von Datei und Modell ab.",
          "bullets": [
            "Termine, Mitbringsel und Fristen ermitteln",
            "Erhalt von Daten und Bedingungen vergleichen",
            "Fehlende Angaben als unbekannt markieren"
          ]
        },
        {
          "title": "Dateien vorbereiten",
          "body": "Nutzen Sie klare, unbeschädigte Dateien und konkrete Fragen. Geschützte, gescannte, fehlerhafte oder sehr große Dokumente können unlesbar sein. Prüfen Sie Zahlen, Quellen, Formeln und Schlussfolgerungen im Original."
        },
        {
          "title": "Sicherheitsgrenzen",
          "body": "Wenn Gastanhänge angeboten werden, ist ein unterstütztes Bild oder lesbares Dokument bis 5 MiB möglich. Angemeldete Konten mit Anhangzugriff können fünf Dateien pro Nachricht senden, je 10 MiB und insgesamt 25 MiB. Google Drive erfordert eine Anmeldung. Die gewählten KI-Anbieter verarbeiten nötige Dateiinhalte; laden Sie nur erlaubte Materialien hoch."
        },
        {
          "title": "Aufbewahrung",
          "body": "Anhänge angemeldeter Konten bleiben beim Gespräch und werden zur Löschung vorgesehen, wenn Gespräch oder Konto gelöscht werden. Gastdateien sind vorübergehend, auf die Sitzung begrenzt und werden automatisch entfernt; sie erscheinen nicht in gespeicherten Gesprächen, Freigaben oder Exporten. Für die Verarbeitung beim Anbieter gelten dessen Bedingungen."
        }
      ],
      "cta": {
        "label": "Vergleich starten",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=de`
      }
    },
    "es": {
      "metadataTitle": "Análisis de archivos PDF, Office e imágenes con IA",
      "metadataDescription": "Usa varios modelos de IA para resumir y analizar PDF, documentos Office, archivos de texto e imágenes compatibles en Tomverse.",
      "eyebrow": "Flujo documental con IA",
      "title": "Analiza archivos con varios modelos de IA",
      "description": "Extrae la fecha, qué llevar y el plazo de respuesta de un aviso del club. Pide que un lugar pendiente siga marcado como pendiente y que cada punto incluya una frase de apoyo. Puedes usar PDF legibles, documentos Office, textos e imágenes compatibles; la interpretación depende del archivo y del modelo.",
      "sections": [
        {
          "title": "Flujos compatibles",
          "body": "Extrae la fecha, qué llevar y el plazo de respuesta de un aviso del club. Pide que un lugar pendiente siga marcado como pendiente y que cada punto incluya una frase de apoyo. Puedes usar PDF legibles, documentos Office, textos e imágenes compatibles; la interpretación depende del archivo y del modelo.",
          "bullets": [
            "Extraer fechas, qué llevar y plazos",
            "Comprobar fechas y condiciones conservadas",
            "Marcar como desconocidos los datos ausentes"
          ]
        },
        {
          "title": "Prepara los archivos",
          "body": "Usa archivos claros y no dañados con una pregunta concreta. Los documentos protegidos, escaneados, malformados o muy grandes pueden no ser legibles. Verifica cifras, citas, fórmulas y conclusiones con el original."
        },
        {
          "title": "Límites de seguridad",
          "body": "Cuando se ofrecen adjuntos a visitantes, puedes enviar una imagen compatible o un documento legible de hasta 5 MiB. Las cuentas con sesión y permiso para adjuntar pueden enviar cinco archivos por mensaje, de 10 MiB cada uno y 25 MiB en total. Google Drive requiere iniciar sesión. Los proveedores elegidos procesan el contenido necesario; sube solo material que tengas permiso para usar."
        },
        {
          "title": "Retención",
          "body": "Los adjuntos enviados desde una cuenta se conservan con la conversación y se programan para su eliminación al borrar la conversación o la cuenta. Los archivos de visitantes son temporales, propios de la sesión y se eliminan automáticamente; no forman parte de conversaciones guardadas, enlaces compartidos ni exportaciones. El tratamiento del proveedor sigue sus condiciones."
        }
      ],
      "cta": {
        "label": "Empezar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=es`
      }
    },
    "pt": {
      "metadataTitle": "Análise de PDFs, arquivos Office e imagens com IA",
      "metadataDescription": "Use vários modelos de IA para resumir e analisar PDFs, documentos Office, textos e imagens compatíveis no Tomverse.",
      "eyebrow": "Fluxo de documentos com IA",
      "title": "Analise arquivos com vários modelos de IA",
      "description": "Extraia a data, o que levar e o prazo de resposta de um aviso do clube. Peça para marcar um local indefinido como indefinido e citar uma frase para cada item. PDFs legíveis, documentos Office, textos e imagens compatíveis podem ser usados; a interpretação depende do arquivo e do modelo.",
      "sections": [
        {
          "title": "Fluxos compatíveis",
          "body": "Extraia a data, o que levar e o prazo de resposta de um aviso do clube. Peça para marcar um local indefinido como indefinido e citar uma frase para cada item. PDFs legíveis, documentos Office, textos e imagens compatíveis podem ser usados; a interpretação depende do arquivo e do modelo.",
          "bullets": [
            "Extrair datas, o que levar e prazos",
            "Comparar datas e condições preservadas",
            "Marcar informações ausentes como desconhecidas"
          ]
        },
        {
          "title": "Prepare os arquivos",
          "body": "Use arquivos claros e não corrompidos com uma pergunta específica. Documentos protegidos, digitalizados, malformados ou muito grandes podem não ser legíveis. Confira números, citações, fórmulas e conclusões no original."
        },
        {
          "title": "Limites de segurança",
          "body": "Quando anexos são oferecidos a visitantes, você pode enviar uma imagem compatível ou um documento legível de até 5 MiB. Contas conectadas com acesso a anexos podem enviar cinco arquivos por mensagem, 10 MiB por arquivo e 25 MiB no total. O Google Drive exige login. Os provedores de IA escolhidos processam o conteúdo necessário; envie apenas materiais que você tem permissão para usar."
        },
        {
          "title": "Retenção",
          "body": "Anexos enviados por uma conta conectada ficam com a conversa e entram no processo de exclusão quando a conversa ou a conta é excluída. Arquivos de visitantes são temporários, restritos à sessão e removidos automaticamente; não entram em conversas salvas, compartilhamentos ou exportações. O processamento pelos provedores segue os termos de cada um."
        }
      ],
      "cta": {
        "label": "Começar a comparar",
        "href": `${REVIEW_WORKSPACE_PATH}?lang=pt`
      }
    }
  }
};
