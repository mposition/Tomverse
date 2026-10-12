import type { Language } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "./MarketingInfoPage";

export const infoPages = {
  faq: {
  "ko": {
    "eyebrow": "FAQ",
    "title": "자주 묻는 질문",
    "description": "Chat과 Review의 차이, 무료 시작, 모델 선택과 크레딧 등 사용 전 궁금한 점을 확인하세요.",
    "sections": [
      {
        "title": "Chat과 Review는 언제 쓰면 좋나요?",
        "body": "한 모델과 질문을 이어가거나 모델 선택의 도움을 받고 싶을 때는 Chat을 사용하세요. 같은 질문에 대한 여러 모델의 답변을 읽고 차이와 놓친 조건을 살펴보고 싶을 때는 Review가 맞습니다."
      },
      {
        "title": "가입 없이 무엇을 해볼 수 있나요?",
        "body": "Review는 가입 없이 먼저 체험할 수 있습니다. Chat의 비회원 체험은 제공되는 환경에서 이용할 수 있습니다. 비회원에게 제공되는 모델과 사용량에는 제한이 있으며 저장·공유·파일 기능의 조건은 화면의 안내를 확인하세요."
      },
      {
        "title": "Smart Adaptive를 써도 모델을 직접 고를 수 있나요?",
        "body": "직접 모델을 선택하는 방식도 사용할 수 있습니다. Smart Adaptive는 질문과 필요한 기능, 모델의 비용·품질을 고려한 선택을 돕는 방식입니다. 실제 이용 가능 모델은 계정과 플랜에 따라 달라집니다."
      },
      {
        "title": "질문 다듬기 제안은 자동으로 적용되나요?",
        "body": "제안이 제공되면 내용을 확인한 뒤 채택할 수 있습니다. 원하는 뜻이나 조건과 다른 제안은 적용하지 않아도 됩니다. 원래 질문에 없는 정보가 필요한 경우에는 직접 보완해 주세요."
      },
      {
        "title": "AI Review가 정답을 골라주나요?",
        "body": "AI Review는 제공된 답변의 공통점, 차이, 충돌과 누락을 비교합니다. 답변을 독립적으로 사실검증하거나 정답을 보장하지 않습니다. 추가 확인이 필요한 항목은 원문과 출처를 직접 확인하는 데 활용하세요."
      },
      {
        "title": "모델을 여러 개 쓰면 크레딧도 늘어나나요?",
        "body": "선택한 모델의 사용량이 각각 반영됩니다. 모델별 기본 크레딧과 긴 문맥·파일에 따른 적용 범위를 확인하고, 필요한 모델 수만 선택하세요. AI Review는 실행 전에 별도 예상 크레딧을 확인할 수 있습니다."
      },
      {
        "title": "파일을 첨부하면 어디에서 처리하나요?",
        "body": "선택한 AI 제공자는 답변에 필요한 파일 또는 발췌 내용을 처리합니다. 잠금과 비공개 저장은 접근 제어에 관한 기능이며 공급자 처리를 없애는 기능은 아닙니다. 최신 보관·삭제 범위는 안전 안내와 개인정보 처리방침에서 확인하세요."
      },
      {
        "title": "무료 AI 하나를 쓰고 있는데, Tomverse가 필요한가요?",
        "body": "간단한 질문만 한다면 지금 쓰는 도구로 충분할 수도 있습니다. 모델을 바꿔가며 쓰거나 같은 질문의 답변을 비교하고, 자료와 대화를 다시 활용하고 싶을 때 Tomverse의 가치가 커집니다. 먼저 체험한 뒤 필요한 사용량과 기능에 맞춰 선택하세요."
      },
      {
        "title": "Review에서 몇 개 모델을 비교할 수 있나요?",
        "body": "같은 질문에 최대 3개 모델의 답변을 나란히 읽을 수 있습니다. 비교할 모델은 이용 가능한 목록에서 직접 선택하며, 선택한 각 모델의 사용량이 반영됩니다."
      },
      {
        "title": "대화를 저장하거나 다른 사람에게 공유할 수 있나요?",
        "body": "로그인하면 대화를 저장하고 지원되는 공유·다운로드 기능을 사용할 수 있습니다. 공유 링크에는 공유 당시의 내용이 읽기 전용으로 표시되며 이후 메시지는 자동으로 추가되지 않습니다. 잠긴 대화는 공유 전에 잠금 해제 확인이 필요합니다."
      }
    ],
    "cta": {
      "label": "처음 시작하기",
      "href": "/support/help-centre"
    }
  },
  "en": {
    "eyebrow": "FAQ",
    "title": "Frequently asked questions",
    "description": "Find answers about Chat and Review, getting started free, model selection and credits.",
    "sections": [
      {
        "title": "When should I use Chat or Review?",
        "body": "Use Chat to continue a conversation with one model or get help choosing one. Use Review to compare answers to the same question and examine differences and missing conditions."
      },
      {
        "title": "What can I try without an account?",
        "body": "Try Review without an account. Guest Chat is available where the product is offered. Guest models and usage have limits; check the on-screen requirements for saving, sharing and files."
      },
      {
        "title": "Can I choose a model myself with Smart Adaptive?",
        "body": "You can also select a model yourself. Smart Adaptive helps with selection based on your question, required capabilities, cost and quality. Available models depend on your account and plan."
      },
      {
        "title": "Are question-refinement suggestions applied automatically?",
        "body": "When suggestions are offered, you can review them and choose whether to apply them. You can leave suggestions unused if they change your meaning or conditions, and add missing information yourself."
      },
      {
        "title": "Does AI Review choose the correct answer?",
        "body": "AI Review compares agreements, differences, conflicts and omissions in the supplied answers. It does not independently fact-check them or guarantee a correct answer. Use the flagged points to guide your own source checks."
      },
      {
        "title": "Does using more models use more credits?",
        "body": "Usage from each selected model is counted. Check base credits and how long context or files can affect usage, and select the models you need. AI Review shows a separate estimate before it runs."
      },
      {
        "title": "Where are attached files processed?",
        "body": "The selected AI provider processes the file or excerpts needed to answer. Locks and private storage control access; they do not remove provider processing. See the safety information and privacy policy for current retention and deletion details."
      },
      {
        "title": "I already use a free AI. Why try Tomverse?",
        "body": "Your current tool may be enough for simple questions. Tomverse is useful when you want to switch models, compare answers to the same question or reuse your material and conversations. Try it first and choose based on your needs."
      },
      {
        "title": "How many models can I compare in Review?",
        "body": "Read up to three model answers to the same question side by side. Choose from the models available to you; usage from each selected model is counted."
      },
      {
        "title": "Can I save or share a conversation?",
        "body": "Sign in to save conversations and use supported sharing and download features. A share link shows a read-only snapshot from the time of sharing; later messages are not added automatically. Locked conversations require verification before sharing."
      }
    ],
    "cta": {
      "label": "Getting started",
      "href": "/support/help-centre"
    }
  },
  "zh": {
    "eyebrow": "FAQ",
    "title": "常见问题",
    "description": "了解 Chat 与 Review 的区别、免费体验、模型选择与积分。",
    "sections": [
      {
        "title": "什么时候用 Chat，什么时候用 Review？",
        "body": "想与一个模型持续对话或获得选择帮助时用 Chat。想比较同一问题的多个回答、查看差异与遗漏条件时用 Review。"
      },
      {
        "title": "无需注册可以体验什么？",
        "body": "Review 可无需注册先体验。Chat 在提供访客体验的环境中可使用。访客模型与用量有限制，保存、分享及文件条件请查看屏幕说明。"
      },
      {
        "title": "使用 Smart Adaptive 时还能手动选模型吗？",
        "body": "也可以手动选择模型。Smart Adaptive 根据问题、所需功能、费用与质量帮助选择。可用模型取决于账户与套餐。"
      },
      {
        "title": "提问优化建议会自动应用吗？",
        "body": "提供建议时，你可以查看后决定是否采用。与原意或条件不符的建议可以不应用；缺少的信息可自行补充。"
      },
      {
        "title": "AI Review 会选出正确答案吗？",
        "body": "AI Review 比较所提供回答的共识、差异、冲突与遗漏，不进行独立事实核验，也不保证正确答案。可根据待核实项自行查看原文与来源。"
      },
      {
        "title": "使用多个模型会消耗更多积分吗？",
        "body": "每个所选模型的用量都会计算。请查看基础积分及长上下文、文件的影响，只选择所需模型。AI Review 运行前会显示单独预估。"
      },
      {
        "title": "附加文件会在哪里处理？",
        "body": "所选 AI 提供商会处理回答所需的文件或摘录。锁定与私有存储用于访问控制，不代表没有供应商处理。当前保留与删除范围请查看安全说明及隐私政策。"
      },
      {
        "title": "我已经在用免费 AI，为什么还要试 Tomverse？",
        "body": "如果只问简单问题，现有工具可能已经够用。需要切换模型、比较同一问题的回答，或再次使用资料与对话时，Tomverse 更有帮助。先体验，再按需要选择。"
      },
      {
        "title": "Review 可以比较多少个模型？",
        "body": "可以并排阅读最多三个模型对同一问题的回答。请从可用列表选择模型，每个所选模型的用量都会计算。"
      },
      {
        "title": "可以保存或分享对话吗？",
        "body": "登录后可以保存对话并使用支持的分享和下载功能。链接显示分享时的只读快照，后续消息不会自动加入。锁定对话在分享前需要验证解锁。"
      }
    ],
    "cta": {
      "label": "开始使用",
      "href": "/support/help-centre"
    }
  },
  "fr": {
    "eyebrow": "FAQ",
    "title": "Questions fréquentes",
    "description": "Découvrez les réponses sur Chat et Review, le démarrage gratuit, le choix des modèles et les crédits.",
    "sections": [
      {
        "title": "Quand utiliser Chat ou Review ?",
        "body": "Utilisez Chat pour dialoguer avec un modèle ou être aidé dans le choix. Utilisez Review pour comparer les réponses à une même question et examiner différences et conditions oubliées."
      },
      {
        "title": "Que puis-je essayer sans compte ?",
        "body": "Essayez Review sans compte. Chat en mode invité est accessible lorsqu’il est proposé. Les modèles et l’usage invité ont des limites ; consultez les conditions affichées pour les fichiers, l’enregistrement et le partage."
      },
      {
        "title": "Puis-je choisir moi-même le modèle ?",
        "body": "Vous pouvez aussi choisir un modèle vous-même. Smart Adaptive tient compte de la question, des fonctions, du coût et de la qualité. Les modèles accessibles dépendent du compte et de l’offre."
      },
      {
        "title": "Les reformulations s’appliquent-elles automatiquement ?",
        "body": "Lorsqu’une suggestion est proposée, vous décidez de l’appliquer après lecture. Vous pouvez l’ignorer si elle change votre intention ou vos conditions, et compléter vous-même les informations manquantes."
      },
      {
        "title": "AI Review choisit-il la bonne réponse ?",
        "body": "AI Review compare accords, différences, conflits et omissions dans les réponses fournies. Il ne vérifie pas indépendamment les faits et ne garantit pas la bonne réponse. Utilisez les points signalés pour consulter les sources."
      },
      {
        "title": "Plusieurs modèles consomment-ils plus de crédits ?",
        "body": "L’usage de chaque modèle sélectionné est compté. Consultez les crédits de base et l’effet des fichiers ou longs contextes, puis choisissez les modèles nécessaires. AI Review affiche une estimation distincte avant exécution."
      },
      {
        "title": "Où sont traités les fichiers joints ?",
        "body": "Le fournisseur choisi traite le fichier ou les extraits nécessaires. Verrouillage et stockage privé contrôlent l’accès, sans supprimer le traitement par le fournisseur. Consultez les informations de sécurité et de confidentialité pour la conservation et la suppression."
      },
      {
        "title": "J’utilise déjà une IA gratuite. Pourquoi essayer Tomverse ?",
        "body": "Votre outil actuel peut suffire pour les questions simples. Tomverse est utile pour changer de modèle, comparer les réponses ou réutiliser documents et conversations. Essayez avant de choisir selon vos besoins."
      },
      {
        "title": "Combien de modèles puis-je comparer dans Review ?",
        "body": "Lisez jusqu’à trois réponses à une même question côte à côte. Choisissez parmi les modèles accessibles ; l’usage de chaque modèle est compté."
      },
      {
        "title": "Puis-je enregistrer ou partager une conversation ?",
        "body": "Connectez-vous pour enregistrer et utiliser les fonctions de partage et de téléchargement disponibles. Le lien montre un instantané en lecture seule ; les messages ultérieurs ne s’y ajoutent pas. Une conversation verrouillée doit être déverrouillée avant partage."
      }
    ],
    "cta": {
      "label": "Bien commencer",
      "href": "/support/help-centre"
    }
  },
  "de": {
    "eyebrow": "FAQ",
    "title": "Häufige Fragen",
    "description": "Antworten zu Chat und Review, kostenlosem Einstieg, Modellwahl und Credits.",
    "sections": [
      {
        "title": "Wann nutze ich Chat oder Review?",
        "body": "Nutzen Sie Chat für ein Gespräch mit einem Modell oder Auswahlhilfe. Review hilft beim Vergleich derselben Frage und beim Prüfen von Unterschieden und fehlenden Bedingungen."
      },
      {
        "title": "Was kann ich ohne Konto ausprobieren?",
        "body": "Testen Sie Review ohne Konto. Gast-Chat ist dort verfügbar, wo er angeboten wird. Modell- und Nutzungslimits gelten; beachten Sie die Hinweise zu Speichern, Teilen und Dateien."
      },
      {
        "title": "Kann ich das Modell selbst wählen?",
        "body": "Sie können ein Modell selbst wählen. Smart Adaptive berücksichtigt Frage, Funktionen, Kosten und Qualität. Verfügbare Modelle hängen von Konto und Tarif ab."
      },
      {
        "title": "Werden Vorschläge zur Frage automatisch übernommen?",
        "body": "Sie prüfen angebotene Vorschläge und entscheiden selbst. Vorschläge, die Ihre Absicht oder Bedingungen ändern, müssen Sie nicht übernehmen. Fehlende Informationen können Sie ergänzen."
      },
      {
        "title": "Wählt AI Review die richtige Antwort?",
        "body": "AI Review vergleicht Gemeinsamkeiten, Unterschiede, Konflikte und Lücken der Antworten. Es prüft Fakten nicht unabhängig und garantiert keine richtige Antwort. Nutzen Sie die Hinweise für eigene Quellenprüfungen."
      },
      {
        "title": "Verbrauchen mehrere Modelle mehr Credits?",
        "body": "Der Verbrauch jedes gewählten Modells wird berücksichtigt. Prüfen Sie Basis-Credits sowie Datei- und Langkontexteffekte und wählen Sie benötigte Modelle. AI Review zeigt vorab eine separate Schätzung."
      },
      {
        "title": "Wo werden Anhänge verarbeitet?",
        "body": "Der gewählte Anbieter verarbeitet nötige Dateien oder Auszüge. Sperren und private Speicherung steuern den Zugriff, verhindern aber nicht die Anbieter-Verarbeitung. Aktuelle Aufbewahrungs- und Löschdetails stehen in den Sicherheits- und Datenschutzinformationen."
      },
      {
        "title": "Ich nutze schon eine kostenlose KI. Warum Tomverse testen?",
        "body": "Für einfache Fragen kann Ihr bisheriges Werkzeug ausreichen. Tomverse hilft beim Modellwechsel, Antwortvergleich und Wiederverwenden von Material und Gesprächen. Testen Sie es und wählen Sie nach Bedarf."
      },
      {
        "title": "Wie viele Modelle kann ich in Review vergleichen?",
        "body": "Lesen Sie bis zu drei Antworten auf dieselbe Frage nebeneinander. Wählen Sie aus den verfügbaren Modellen; der Verbrauch jedes Modells wird berücksichtigt."
      },
      {
        "title": "Kann ich Gespräche speichern oder teilen?",
        "body": "Melden Sie sich an, um Gespräche zu speichern und unterstützte Freigabe- und Downloadfunktionen zu nutzen. Der Link zeigt den damaligen Inhalt schreibgeschützt; spätere Nachrichten werden nicht ergänzt. Gesperrte Gespräche erfordern vorherige Entsperrung."
      }
    ],
    "cta": {
      "label": "Erste Schritte",
      "href": "/support/help-centre"
    }
  },
  "es": {
    "eyebrow": "FAQ",
    "title": "Preguntas frecuentes",
    "description": "Resuelve tus dudas sobre Chat y Review, cómo empezar gratis, elegir modelos y usar créditos.",
    "sections": [
      {
        "title": "¿Cuándo uso Chat o Review?",
        "body": "Usa Chat para conversar con un modelo o recibir ayuda para elegirlo. Usa Review para comparar respuestas a la misma pregunta y examinar diferencias y condiciones omitidas."
      },
      {
        "title": "¿Qué puedo probar sin crear una cuenta?",
        "body": "Prueba Review sin cuenta. Chat como invitado está disponible donde se ofrece. Hay límites de modelos y uso; consulta los requisitos en pantalla para guardar, compartir y adjuntar archivos."
      },
      {
        "title": "¿Puedo elegir el modelo por mi cuenta?",
        "body": "También puedes seleccionar un modelo. Smart Adaptive considera la pregunta, las funciones necesarias, el coste y la calidad. Los modelos disponibles dependen de tu cuenta y plan."
      },
      {
        "title": "¿Las sugerencias se aplican automáticamente?",
        "body": "Revisa las sugerencias y decide si las aplicas. Puedes ignorarlas si cambian tu intención o condiciones y añadir tú mismo la información que falta."
      },
      {
        "title": "¿AI Review elige la respuesta correcta?",
        "body": "AI Review compara coincidencias, diferencias, conflictos y omisiones de las respuestas. No verifica los hechos de forma independiente ni garantiza una respuesta correcta. Usa los puntos señalados para revisar las fuentes."
      },
      {
        "title": "¿Usar más modelos consume más créditos?",
        "body": "Se cuenta el uso de cada modelo. Consulta los créditos base y el efecto de archivos o contextos largos y elige los modelos que necesitas. AI Review muestra una estimación separada antes de ejecutarse."
      },
      {
        "title": "¿Dónde se procesan los archivos adjuntos?",
        "body": "El proveedor elegido procesa el archivo o los extractos necesarios. El bloqueo y almacenamiento privado controlan el acceso, pero no eliminan el procesamiento del proveedor. Consulta seguridad y privacidad para retención y borrado."
      },
      {
        "title": "Ya uso una IA gratuita. ¿Por qué probar Tomverse?",
        "body": "Tu herramienta puede bastar para preguntas sencillas. Tomverse resulta útil para cambiar modelos, comparar respuestas o reutilizar material y conversaciones. Pruébalo y elige según lo que necesites."
      },
      {
        "title": "¿Cuántos modelos puedo comparar en Review?",
        "body": "Lee hasta tres respuestas a la misma pregunta en paralelo. Elige los modelos disponibles para ti; se cuenta el uso de cada uno."
      },
      {
        "title": "¿Puedo guardar o compartir una conversación?",
        "body": "Inicia sesión para guardar y usar las funciones compatibles de compartir y descargar. El enlace muestra una instantánea de solo lectura; los mensajes posteriores no se añaden. Las conversaciones bloqueadas requieren verificación antes de compartir."
      }
    ],
    "cta": {
      "label": "Primeros pasos",
      "href": "/support/help-centre"
    }
  },
  "pt": {
    "eyebrow": "FAQ",
    "title": "Perguntas frequentes",
    "description": "Tire dúvidas sobre Chat e Review, como começar grátis, escolher modelos e usar créditos.",
    "sections": [
      {
        "title": "Quando usar Chat ou Review?",
        "body": "Use Chat para conversar com um modelo ou receber ajuda na escolha. Use Review para comparar respostas à mesma pergunta e examinar diferenças e condições omitidas."
      },
      {
        "title": "O que posso experimentar sem criar uma conta?",
        "body": "Experimente o Review sem conta. O Chat como visitante está disponível onde é oferecido. Há limites de modelos e uso; veja na tela os requisitos para salvar, compartilhar e anexar arquivos."
      },
      {
        "title": "Posso escolher o modelo por conta própria?",
        "body": "Você também pode selecionar um modelo. O Smart Adaptive considera a pergunta, os recursos necessários, o custo e a qualidade. Os modelos disponíveis dependem da conta e do plano."
      },
      {
        "title": "As sugestões são aplicadas automaticamente?",
        "body": "Analise as sugestões e decida se as aplica. Você pode ignorá-las se mudarem sua intenção ou condições e acrescentar as informações que faltam."
      },
      {
        "title": "O AI Review escolhe a resposta correta?",
        "body": "O AI Review compara consensos, diferenças, conflitos e lacunas das respostas. Não verifica fatos de forma independente nem garante uma resposta correta. Use os pontos destacados para consultar as fontes."
      },
      {
        "title": "Usar mais modelos consome mais créditos?",
        "body": "O uso de cada modelo é contado. Confira créditos-base e efeitos de arquivos ou contextos longos e escolha os modelos necessários. O AI Review mostra uma estimativa separada antes da execução."
      },
      {
        "title": "Onde os anexos são processados?",
        "body": "O provedor escolhido processa o arquivo ou os trechos necessários. Bloqueio e armazenamento privado controlam o acesso, mas não eliminam o processamento do provedor. Veja segurança e privacidade para retenção e exclusão."
      },
      {
        "title": "Já uso uma IA gratuita. Por que experimentar o Tomverse?",
        "body": "Sua ferramenta pode bastar para perguntas simples. O Tomverse ajuda a trocar modelos, comparar respostas ou reutilizar materiais e conversas. Experimente e escolha conforme suas necessidades."
      },
      {
        "title": "Quantos modelos posso comparar no Review?",
        "body": "Leia até três respostas à mesma pergunta lado a lado. Escolha os modelos disponíveis para você; o uso de cada um é contado."
      },
      {
        "title": "Posso salvar ou compartilhar uma conversa?",
        "body": "Entre na conta para salvar e usar os recursos compatíveis de compartilhamento e download. O link mostra uma cópia somente leitura daquele momento; novas mensagens não entram automaticamente. Conversas bloqueadas exigem verificação antes de compartilhar."
      }
    ],
    "cta": {
      "label": "Primeiros passos",
      "href": "/support/help-centre"
    }
  }
},
  terms: {
    en: {
      eyebrow: "Legal",
      title: "Terms and Conditions",
      description: "These terms govern free and paid use of Tomverse, including accounts, AI providers, subscriptions, monthly and additional credits, cancellation, and disputes.",
      updated: "Last updated: November 16, 2026",
      sections: [
        {
          title: "Agreement, operator, and contact",
          body: "Tomverse is the service and operating name used for tomverse.app (\"we\", \"us\"), which hosts Tomverse Review and other Tomverse products. The legal seller or contracting operator for a paid transaction is the entity identified on the Stripe Checkout page, receipt, or invoice for that transaction. Billing and legal notices can be sent to support@tomverse.app or through the support form at tomverse.app/support.",
        },
        {
          title: "Accounts and use of the service",
          body: "You must provide accurate account information, protect access to your account, and take responsibility for account activity, prompts, uploaded files, and content you use or share. We may reasonably limit, suspend, or terminate access where necessary to address abuse, security risk, non-payment, legal requirements, or a material breach of these terms.",
        },
        {
          title: "Marketing email consent",
          body: "Your consent stays in effect until you withdraw it. There is no fixed expiry. You can withdraw it at any time in your email settings or with the unsubscribe link in any marketing message, without signing in. Withdrawing does not stop sign-in codes, billing receipts or service notices.",
        },
        {
          title: "Third-party AI providers and outputs",
          body: "Tomverse routes prompts and selected context to third-party AI providers and displays their responses. AI outputs can be inaccurate, incomplete, outdated, unsafe, or unsuitable and are not professional legal, medical, financial, safety, or other advice. Verify important outputs and obtain qualified advice before making high-impact decisions.",
        },
        {
          title: "Plans, AI credits, and fair use",
          body: "Free, Pro, and Max provide the features and monthly AI-credit allowances shown on the pricing and account pages. Credit use varies by model, reasoning mode, and input size. Monthly credits reset at the beginning of each calendar month in UTC, do not roll over, are not transferable, and have no cash value. Fair-use, abuse-prevention, model, provider-cost, file, and context limits continue to apply.",
        },
        {
          title: "Additional credit packs",
          body: "An additional credit pack is a one-time purchase that is separate from a subscription and its monthly credits. Additional credits expire 12 months (365 days) after purchase, are not transferable, and cannot be redeemed for cash. Tomverse deducts available monthly plan credits first and then additional-credit lots in order of earliest expiry. A pack increases only the credit balance available for usage: it does not upgrade the plan or increase model access, features, daily limits, plan-specific higher-cost model limits, fair-use limits, or other safeguards.",
        },
        {
          title: "Monthly and annual subscriptions; automatic renewal",
          body: "Pro and Max are recurring subscriptions processed by Stripe. Monthly subscriptions are charged in advance and renew each month. Annual subscriptions are charged in advance for the year and renew each year. Unless you cancel before the next renewal, you authorise Stripe to charge the payment method on file for the amount and currency shown at checkout. We will give reasonable notice of a material price change where required and you may cancel before it takes effect.",
        },
        {
          title: "Promotions and annual discounts",
          body: "A promotion applies only to the plan, billing interval, duration, redemption limit, and expiry disclosed for that code. Promotions do not combine with the annual-plan discount unless the specific promotion expressly permits stacking. When a limited promotion ends, the subscription renews at the then-disclosed regular price unless cancelled. A discount has no separate cash value.",
        },
        {
          title: "Cancellation and end of paid access",
          body: "You can schedule cancellation from the account billing controls. Cancellation stops the next automatic renewal; it does not normally end access immediately. Paid features remain available until the current monthly or annual period ends, after which the account moves to the available Free plan. There is no early-termination fee and cancellation alone does not create an automatic prorated refund. An approved refund or a termination for cause may end paid access earlier. Cancelling or downgrading a subscription does not by itself remove valid additional credits: they remain available until their stated expiry, but can be used only with the model access, features, daily limits, and safeguards of the account's then-current plan.",
        },
        {
          title: "Refunds and provider failures",
          body: "Subscription and additional-credit refund requests are governed by the Refund Policy at tomverse.app/refund and any rights that cannot be excluded by law. A failed or empty provider response normally releases reserved AI credits automatically; a user-cancelled response that already produced usable output may consume a proportionate amount. An approved full or partial additional-credit refund, or a chargeback, reverses the corresponding credit entitlement. Available credits are revoked first; any corresponding entitlement already used may be recorded as credit debt and offset against future monthly or additional-credit grants, and access may be temporarily limited while a payment dispute remains unresolved. If an incident appears to have consumed credits incorrectly, contact support with the trace ID so we can review the logs.",
        },
        {
          title: "Currency, taxes, and payment processing",
          body: "Local-currency estimates shown before checkout are informational. The amount, billing interval, currency, and any applicable tax shown by Stripe Checkout before confirmation control the transaction. Your bank, card issuer, wallet, or payment provider may apply its own exchange rate or fee. Tomverse does not store complete payment-card details.",
        },
        {
          title: "Acceptable use and rights in content",
          body: "Do not use Tomverse to violate law, infringe rights, abuse providers, bypass limits, upload malicious material, or process content you are not entitled to use. You retain rights you hold in your input. You grant Tomverse the limited rights necessary to process that input, operate requested features, and send relevant context to the AI providers you select.",
        },
        {
          title: "Consumer rights, governing law, and disputes",
          body: "Nothing in these terms excludes guarantees, remedies, or other rights that cannot lawfully be excluded, including rights that may apply under the Australian Consumer Law. To the extent permitted by law, these terms are governed by the laws of Queensland, Australia. Please contact support first so we can try to resolve a dispute; this does not restrict your right to contact a regulator, tribunal, or court with jurisdiction.",
        },
      ],
      cta: { label: "Contact support", href: "/support" },
    },
    ko: {
      eyebrow: "법적 고지",
      title: "이용약관",
      description: "계정, AI 제공자, 구독, 월 크레딧과 추가 크레딧, 취소 및 분쟁을 포함한 Tomverse의 무료·유료 서비스 이용 조건입니다.",
      updated: "최종 업데이트: 2026년 11월 16일",
      sections: [
        {
          title: "약관 동의, 운영 주체 및 연락처",
          body: "Tomverse는 tomverse.app에서 제공되는 서비스 및 운영 명칭입니다(이하 ‘당사’), Tomverse Review를 비롯한 Tomverse의 제품들을 운영합니다. 유료 거래의 법적 판매자 또는 계약 운영 주체는 해당 Stripe 결제 화면, 영수증 또는 인보이스에 표시된 사업자입니다. 결제·법률 관련 문의는 support@tomverse.app 또는 tomverse.app/support의 지원 폼으로 접수할 수 있습니다.",
        },
        {
          title: "계정 및 서비스 이용",
          body: "사용자는 정확한 계정 정보를 제공하고 계정 접근을 보호해야 하며, 계정 활동, 프롬프트, 업로드 파일, 사용하거나 공유하는 콘텐츠에 책임을 집니다. 남용, 보안 위험, 미결제, 법적 의무 또는 중대한 약관 위반에 대응하기 위해 합리적으로 필요한 범위에서 접근을 제한·정지·종료할 수 있습니다.",
        },
        {
          title: "광고성 이메일 수신동의",
          body: "수신동의는 철회하실 때까지 유효하며 별도의 만료 기간을 두지 않습니다. 이메일 설정 또는 광고성 메일에 포함된 수신거부 링크에서 로그인 없이 언제든 철회하실 수 있습니다. 철회하셔도 로그인 코드, 결제 영수증, 서비스 공지는 계속 발송됩니다.",
        },
        {
          title: "제3자 AI 제공자와 출력",
          body: "Tomverse는 프롬프트와 선택된 맥락을 제3자 AI 제공자에게 전송하고 그 응답을 표시합니다. AI 출력은 부정확·불완전·오래되었거나 상황에 부적합할 수 있으며 법률, 의료, 금융, 안전 등 전문적인 조언이 아닙니다. 중요한 결정 전에는 결과를 독립적으로 확인하고 자격 있는 전문가의 조언을 받아야 합니다.",
        },
        {
          title: "플랜, AI 크레딧 및 공정사용",
          body: "Free, Pro, Max에는 요금 및 계정 페이지에 표시된 기능과 월 AI 크레딧 한도가 적용됩니다. 크레딧 사용량은 모델, 추론 방식, 입력 크기에 따라 달라집니다. 월 크레딧은 매월 1일 00:00 UTC에 초기화되며 이월·양도할 수 없고 현금 가치가 없습니다. 공정사용, 남용 방지, 모델, 제공자 비용, 파일 및 맥락 한도는 계속 적용됩니다.",
        },
        {
          title: "추가 크레딧 팩",
          body: "추가 크레딧 팩은 구독 및 구독에 포함된 월 크레딧과 분리된 일회성 구매 상품입니다. 추가 크레딧은 구매일로부터 12개월(365일) 후 만료되며 양도하거나 현금으로 교환할 수 없습니다. Tomverse는 사용 가능한 월 플랜 크레딧을 먼저 차감한 뒤 만료일이 빠른 추가 크레딧 묶음부터 차감합니다. 추가 크레딧은 사용 가능한 크레딧 잔액만 늘리며, 플랜을 업그레이드하거나 모델 접근권한, 기능, 일일 제한, 플랜별 고비용 모델 제한, 공정사용 한도 또는 기타 안전장치를 늘리지 않습니다.",
        },
        {
          title: "월간·연간 구독과 자동 갱신",
          body: "Pro와 Max는 Stripe가 처리하는 정기 구독입니다. 월간 구독은 매월 선결제 후 매월 자동 갱신되고, 연간 구독은 1년분을 선결제한 후 매년 자동 갱신됩니다. 다음 갱신 전에 취소하지 않으면 결제 화면에 표시된 금액과 통화로 저장된 결제수단에 청구하는 데 동의한 것으로 봅니다. 중대한 가격 변경은 법이 요구하는 경우 합리적인 기간 전에 안내하며, 적용 전에 취소할 수 있습니다.",
        },
        {
          title: "프로모션과 연간 할인",
          body: "프로모션은 해당 코드에 표시된 플랜, 결제 주기, 적용 기간, 최대 사용 횟수 및 종료일에만 적용됩니다. 특정 프로모션에서 중복 적용을 명시적으로 허용하지 않는 한 연간 플랜 할인과 중복되지 않습니다. 기간 한정 프로모션이 끝나면 취소하지 않는 한 안내된 정가로 갱신됩니다. 할인 금액 자체에는 별도의 현금 가치가 없습니다.",
        },
        {
          title: "구독 취소와 유료 서비스 종료 시점",
          body: "계정의 결제 관리 영역에서 구독 취소를 예약할 수 있습니다. 취소는 다음 자동 갱신을 중단하며 일반적으로 유료 접근을 즉시 종료하지 않습니다. 현재 월간 또는 연간 결제 기간이 끝날 때까지 유료 기능을 사용할 수 있고, 이후 사용 가능한 Free 플랜으로 전환됩니다. 중도 해지 수수료는 없으며 단순 취소만으로 자동 일할 환불이 발생하지 않습니다. 환불 승인 또는 중대한 위반에 따른 종료 시에는 유료 접근이 더 일찍 끝날 수 있습니다. 구독을 취소하거나 하위 플랜으로 변경해도 유효한 추가 크레딧은 그 자체로 소멸하지 않고 표시된 만료일까지 유지되지만, 변경 후 현재 플랜의 모델 접근권한, 기능, 일일 제한 및 안전장치 안에서만 사용할 수 있습니다.",
        },
        {
          title: "환불과 제공자 장애",
          body: "구독 및 추가 크레딧 환불 요청에는 tomverse.app/refund의 환불 정책과 법률상 배제할 수 없는 권리가 적용됩니다. AI 제공자 요청이 실패하거나 빈 응답으로 끝나면 예약된 크레딧은 일반적으로 자동 복원됩니다. 사용자가 취소하기 전에 사용 가능한 출력이 이미 생성된 경우에는 실제 생성량에 비례한 크레딧이 차감될 수 있습니다. 추가 크레딧의 전액·부분 환불이 승인되거나 차지백이 발생하면 해당 비율의 크레딧 권리가 취소됩니다. 남은 크레딧을 먼저 회수하고 이미 사용되어 회수할 수 없는 부분은 크레딧 부채로 기록해 이후 월 크레딧 또는 추가 크레딧 지급분에서 우선 상계할 수 있으며, 결제 분쟁이 해결될 때까지 사용을 임시 제한할 수 있습니다. 장애로 크레딧이 잘못 차감된 것으로 보이면 추적 ID와 함께 지원팀에 문의해주세요.",
        },
        {
          title: "세금, 환율 및 결제 통화",
          body: "결제 전 표시되는 현지 통화 금액은 참고용 환산값입니다. 최종 확인 전 Stripe 결제 화면에 표시된 금액, 결제 주기, 통화 및 적용 세금이 실제 거래 기준입니다. 은행, 카드사, 지갑 또는 결제 제공자가 자체 환율이나 수수료를 적용할 수 있습니다. Tomverse는 전체 카드 정보를 직접 저장하지 않습니다.",
        },
        {
          title: "허용되는 사용과 콘텐츠 권리",
          body: "법 위반, 권리 침해, 제공자 남용, 한도 우회, 악성 콘텐츠 업로드 또는 권한 없는 데이터 처리를 위해 Tomverse를 사용해서는 안 됩니다. 사용자는 자신이 보유한 입력 콘텐츠의 권리를 유지하며, 요청한 기능 수행과 선택한 AI 제공자에게 필요한 맥락을 전송하는 데 필요한 제한적 처리 권한을 Tomverse에 부여합니다.",
        },
        {
          title: "소비자 권리, 준거법 및 분쟁 처리",
          body: "본 약관은 호주 소비자법을 포함해 법률상 배제할 수 없는 보증, 구제수단 또는 권리를 제한하지 않습니다. 법이 허용하는 범위에서 본 약관에는 호주 퀸즐랜드주 법률이 적용됩니다. 분쟁이 발생하면 먼저 지원팀에 문의해 해결을 시도할 수 있으며, 이는 관할 규제기관, 재판소 또는 법원에 문제를 제기할 권리를 제한하지 않습니다.",
        },
      ],
      cta: { label: "지원팀에 문의", href: "/support" },
    },
    zh: {
      eyebrow: "法律",
      title: "条款与条件",
      description: "这些条款适用于 Tomverse 的免费和付费服务，包括账户、AI 提供商、订阅、月度积分、附加积分、取消和争议。",
      updated: "最后更新：2026 年 11 月 16 日",
      sections: [
        { title: "协议、运营方和联系方式", body: "Tomverse 是 tomverse.app 使用的服务和运营名称（‘我们’），旗下运营 Tomverse Review 等 Tomverse 产品。付费交易的法定销售方或合同运营方，是相应 Stripe 结账页、收据或发票上标明的实体。账单和法律通知可发送至 support@tomverse.app，或通过 tomverse.app/support 的支持表单提交。" },
        { title: "账户和服务使用", body: "你必须提供准确的账户信息、保护账户访问，并对账户活动、提示词、上传文件以及使用或分享的内容负责。为处理滥用、安全风险、未付款、法律要求或重大违约，我们可在合理必要范围内限制、暂停或终止访问。" },
        { title: "营销邮件同意", body: "您的同意在您撤回之前一直有效，没有固定的到期时间。您可以随时在邮件设置中，或通过任何营销邮件中的退订链接撤回同意，无需登录。撤回同意不会停止登录验证码、账单收据或服务通知的发送。" },
        { title: "第三方 AI 提供商和输出", body: "Tomverse 会把提示词和所选上下文发送给第三方 AI 提供商并显示其响应。AI 输出可能不准确、不完整、过时、不安全或不适合你的情况，也不构成法律、医疗、金融、安全或其他专业建议。" },
        { title: "方案、AI 积分和公平使用", body: "Free、Pro 和 Max 适用价格页及账户页显示的功能和月度积分额度。积分消耗因模型、推理方式和输入规模而异。月度积分在每个自然月开始时按 UTC 重置，不结转、不可转让且无现金价值。公平使用、防滥用、模型、提供商成本、文件和上下文限制仍然适用。" },
        { title: "附加积分包", body: "附加积分包是与订阅及其月度积分分开的单次购买。附加积分自购买之日起 12 个月（365 天）后到期，不可转让，也不可兑换现金。Tomverse 先扣除可用的月度方案积分，再按最早到期顺序扣除附加积分。积分包只增加可用积分余额，不会升级方案，也不会增加模型访问、功能、每日限制、方案特定的高成本模型限制、公平使用限制或其他保障。" },
        { title: "月付、年付和自动续订", body: "Pro 和 Max 是由 Stripe 处理的定期订阅。月付按月预付并每月续订；年付按年预付并每年续订。除非你在下次续订前取消，否则即授权 Stripe 按结账时显示的金额和币种向已保存的付款方式收费。" },
        { title: "促销和年付折扣", body: "促销仅适用于该代码披露的方案、计费周期、期限、兑换上限和到期日。除非特定促销明确允许，否则不与年付折扣叠加。限时促销结束后，订阅会按已披露的常规价格续订，除非取消。折扣本身没有现金价值。" },
        { title: "取消和付费访问结束", body: "你可以在账户的账单控制中安排取消。取消会停止下一次自动续订，通常不会立即终止访问。付费功能持续到当前月度或年度周期结束，之后账户转为可用的 Free 方案。没有提前解约费，单纯取消不会自动产生按比例退款。取消或降级订阅本身不会删除仍有效的附加积分；积分保留至标示的到期日，但只能在账户届时方案的模型访问、功能、每日限制和保障范围内使用。" },
        { title: "退款和提供商故障", body: "订阅和附加积分退款请求适用 tomverse.app/refund 的退款政策及法律不得排除的权利。提供商请求失败或返回空响应时，预留积分通常会自动释放；如果用户取消前已生成可用输出，可能按实际生成量扣除积分。附加积分的全部或部分退款获批，或发生拒付时，相应比例的积分权益会被撤销。系统先收回可用积分；已使用而无法收回的部分可记为积分债务，并从未来月度积分或附加积分发放中优先抵扣，付款争议未解决期间也可临时限制访问。若故障似乎错误消耗了积分，请附上 trace ID 联系支持。" },
        { title: "币种、税费和付款处理", body: "结账前显示的本地币种换算仅供参考。Stripe 最终确认页显示的金额、计费周期、币种和适用税费是交易依据。银行、发卡机构、钱包或付款服务商可能使用自己的汇率或收取费用。Tomverse 不直接存储完整银行卡信息。" },
        { title: "消费者权利、适用法律和争议", body: "本条款不排除法律不得排除的保证、救济或其他权利，包括可能适用的澳大利亚消费者法权利。在法律允许的范围内，本条款受澳大利亚昆士兰州法律管辖。请先联系支持尝试解决争议；这不限制你联系有管辖权的监管机构、仲裁庭或法院。" },
      ],
      cta: { label: "联系支持", href: "/support" },
    },
  },
  refund: {
    en: {
      eyebrow: "Billing",
      title: "Refund Policy",
      description: "Refund, billing correction, cancellation, subscription-credit, additional-credit, promotion, and provider-incident rules for Tomverse purchases.",
      updated: "Last updated: July 15, 2026",
      sections: [
        {
          title: "Scope and non-excludable consumer rights",
          body: "This policy applies to Pro and Max subscriptions and to one-time additional credit packs purchased through Tomverse and processed by Stripe, including a Starter Credit Pack purchased by a Free-plan user. It does not exclude remedies or guarantees that cannot be excluded by law. Where the Australian Consumer Law applies, you may be entitled to cancellation, a refund for an unused portion, correction, or compensation for a major service failure or another failure that is not remedied within a reasonable time.",
        },
        {
          title: "When a refund or billing correction may be available",
          body: "We will review requests involving duplicate, unauthorised, or incorrect charges; a paid plan or purchased credit pack that was not delivered; a material service failure; or another circumstance where a refund is required by law. We may also approve a discretionary full or partial refund after considering when the charge occurred, the billing interval or pack, how much paid entitlement was used, and the facts supplied.",
          bullets: ["Duplicate, unauthorised, or incorrect charge", "Paid access or purchased credits not delivered, or a material service failure", "A remedy required by applicable consumer law"],
        },
        {
          title: "When a refund is generally not available",
          body: "Except where required by law, refunds are generally not provided for a change of mind, forgetting to cancel before renewal, dissatisfaction with the style or content of a valid AI response, unused time after a normal cancellation, unused monthly credits, or merely leaving purchased additional credits unused after they were correctly issued. Submitting a request does not guarantee approval and does not itself cancel a subscription or credit-pack entitlement.",
        },
        {
          title: "Monthly and annual cancellation",
          body: "Cancellation from the account area stops the next renewal. A monthly subscription normally remains active through the current paid month; an annual subscription normally remains active through the current paid year. Cancellation alone does not produce an automatic prorated refund. If a refund is approved, the current implementation cancels the paid subscription and moves the account to Free when the approval is processed.",
        },
        {
          title: "Monthly credits and additional credits",
          body: "AI credits are a service allowance, not stored money. Monthly plan credits reset each calendar month in UTC, do not roll over, and remain tied to the applicable plan period. Additional credits are a separate one-time purchase, expire 12 months (365 days) after purchase, and do not reset with the monthly allowance. Both balances are non-transferable and cannot be redeemed for cash. Tomverse deducts available monthly plan credits first and then additional-credit lots in order of earliest expiry.",
        },
        {
          title: "Plan cancellation and additional-credit access",
          body: "Cancelling or downgrading Pro or Max does not by itself remove valid additional credits. They remain on the account until their stated expiry, including after the account moves to Free. Additional credits increase usage capacity only: they do not unlock a higher plan, models, files or other features, and they do not increase daily limits, plan-specific higher-cost model limits, fair-use limits, or other safeguards. They can be used only within the permissions and limits of the account's current plan.",
        },
        {
          title: "Additional-credit refunds, partial refunds, and chargebacks",
          body: "If a full or partial refund is approved, Tomverse reverses the corresponding proportion of the purchased additional-credit entitlement. Available additional credits from the purchase are revoked first. If some of that entitlement has already been used and cannot be recovered, the unrecovered credits and associated funded usage allowance may be recorded as credit debt and offset before future monthly credits or additional-credit purchases are made available. A chargeback or payment dispute may trigger the same provisional reversal and a temporary restriction on AI use while the dispute is unresolved. If the dispute is resolved in the purchaser's favour, the related provisional revocation and debt are restored or cleared to the extent recorded by the system. These rules do not limit rights or remedies that cannot be excluded by law.",
        },
        {
          title: "Promotional purchases",
          body: "Any approved refund is limited to the amount actually paid after the promotion; the undiscounted price and the discount itself are not refundable. A zero-dollar promotion has no cash refund value. Unless required by law or caused by a Tomverse billing error, a used or refunded promotion code is not guaranteed to be reissued. Promotion and annual-plan discounts stack only when the specific promotion expressly allows it.",
        },
        {
          title: "Provider incidents and credit restoration",
          body: "When an AI provider request fails before a usable answer or returns empty, Tomverse normally releases the reserved credits automatically. If you cancel after usable output has begun, a proportionate credit charge may remain. Provider downtime does not automatically create a cash refund, but a material unresolved service failure may qualify for a remedy under this policy or applicable law. Send the trace ID to support if credits appear incorrect.",
        },
        {
          title: "Taxes, exchange rates, and payment currency",
          body: "Refunds cannot exceed the amount and currency actually captured by Stripe. Local price estimates may differ from the final amount because Stripe, your bank, card issuer, wallet, or payment provider may apply taxes, exchange rates, or fees. The Stripe receipt or invoice is the record of the captured amount and merchant identity. Third-party exchange or payment fees are governed by that provider.",
        },
        {
          title: "How to request and how we process it",
          body: "Subscription and credit-pack purchasers can submit a refund review from the account billing area or contact support@tomverse.app. Include the account email, plan, pack if applicable, charge date, transaction or receipt reference, reason, and any trace ID. Requests are reviewed individually. If approved, Tomverse submits the eligible refund to Stripe. A subscription refund may cancel or downgrade the related paid plan; a credit-pack refund reverses only the corresponding pack entitlement and does not by itself cancel a subscription. The time for funds to appear depends on Stripe and the payment provider.",
        },
        {
          title: "Operator and disputes",
          body: "Tomverse operates tomverse.app, and the legal seller for a transaction is identified on its Stripe receipt or invoice. Questions or disputes can be sent to support@tomverse.app or tomverse.app/support. You may also use any regulator, tribunal, or court process available under applicable law.",
        },
      ],
      cta: { label: "Contact billing support", href: "/support" },
    },
    ko: {
      eyebrow: "결제",
      title: "환불 정책",
      description: "Tomverse 구독 및 추가 크레딧 구매의 환불, 오청구 정정, 취소, 크레딧, 프로모션 및 제공자 장애 처리 기준입니다.",
      updated: "최종 업데이트: 2026년 7월 15일",
      sections: [
        {
          title: "적용 범위와 배제할 수 없는 소비자 권리",
          body: "본 정책은 Tomverse에서 구매하고 Stripe가 처리한 Pro·Max 구독과 일회성 추가 크레딧 팩에 적용되며, Free 플랜 사용자가 구매한 Starter Credit Pack도 포함합니다. 본 정책은 법률상 배제할 수 없는 보증이나 구제수단을 제한하지 않습니다. 호주 소비자법이 적용되는 경우 중대한 서비스 실패 또는 합리적인 기간 안에 해결되지 않은 문제에 대해 계약 취소, 미사용 부분 환불, 문제 시정 또는 손해 배상을 받을 권리가 있을 수 있습니다.",
        },
        {
          title: "환불 또는 결제 정정이 가능한 경우",
          body: "중복·무단·오청구, 결제한 플랜 또는 구매한 크레딧 팩이 지급되지 않은 경우, 중대한 서비스 실패 또는 법률상 환불이 필요한 사유는 검토 후 정정하거나 환불합니다. 그 밖의 요청도 결제 시점, 월간·연간 결제 주기 또는 팩, 사용한 유료 권리의 양 및 제출된 사실관계를 고려해 전액 또는 부분 환불을 재량으로 승인할 수 있습니다.",
          bullets: ["중복, 무단 또는 잘못된 금액의 청구", "유료 접근 또는 구매 크레딧 미지급, 혹은 중대한 서비스 실패", "적용되는 소비자법이 요구하는 구제"],
        },
        {
          title: "일반적으로 환불되지 않는 경우",
          body: "법률상 환불이 필요한 경우를 제외하고, 단순 변심, 갱신 전 취소를 잊은 경우, 정상 생성된 AI 답변의 문체·내용에 대한 불만, 일반 취소 후 남은 기간, 사용하지 않은 월 크레딧 또는 정상 지급된 추가 크레딧을 단순히 사용하지 않은 경우는 원칙적으로 환불 대상이 아닙니다. 환불 요청 제출은 승인을 보장하지 않으며 그 자체로 구독이나 크레딧 팩 권리를 취소하지 않습니다.",
        },
        {
          title: "월간·연간 구독 취소",
          body: "계정 영역에서 취소하면 다음 갱신이 중단됩니다. 월간 구독은 일반적으로 현재 결제 월 말까지, 연간 구독은 현재 결제 연도 말까지 유지됩니다. 단순 취소로 자동 일할 환불이 발생하지 않습니다. 환불이 승인되면 현재 시스템은 승인 처리 시 유료 구독을 취소하고 계정을 Free로 전환합니다.",
        },
        {
          title: "월 크레딧과 추가 크레딧",
          body: "AI 크레딧은 예치금이 아닌 서비스 사용 한도입니다. 월 플랜 크레딧은 매월 1일 00:00 UTC에 초기화되고 이월되지 않으며 해당 플랜 기간에 귀속됩니다. 추가 크레딧은 월 크레딧과 분리된 일회성 구매분으로, 구매일로부터 12개월(365일) 후 만료되고 월 초기화 때 사라지지 않습니다. 두 잔액 모두 양도하거나 현금으로 교환할 수 없습니다. Tomverse는 사용 가능한 월 플랜 크레딧을 먼저 차감한 뒤 만료일이 빠른 추가 크레딧 묶음부터 차감합니다.",
        },
        {
          title: "플랜 해지 후 추가 크레딧 이용",
          body: "Pro 또는 Max를 취소하거나 하위 플랜으로 변경해도 유효한 추가 크레딧은 그 자체로 소멸하지 않으며, 계정이 Free로 전환된 뒤에도 표시된 만료일까지 유지됩니다. 추가 크레딧은 사용량만 늘리고 상위 플랜, 모델, 파일 등 기능을 해제하지 않으며, 일일 제한, 플랜별 고비용 모델 제한, 공정사용 한도 또는 기타 안전장치를 늘리지 않습니다. 항상 계정의 현재 플랜 권한과 제한 안에서만 사용할 수 있습니다.",
        },
        {
          title: "추가 크레딧의 전액·부분 환불 및 차지백",
          body: "추가 크레딧의 전액 또는 부분 환불이 승인되면 해당 구매에서 환불 비율에 해당하는 크레딧 권리를 취소합니다. 먼저 그 구매에서 남아 있는 추가 크레딧을 회수합니다. 이미 사용해 회수할 수 없는 권리와 관련 원가 한도는 크레딧 부채로 기록하고, 이후 월 크레딧 또는 추가 크레딧 구매분을 제공하기 전에 우선 상계할 수 있습니다. 차지백 또는 결제 분쟁에도 같은 임시 회수와 상계가 적용될 수 있고, 분쟁이 해결될 때까지 AI 사용을 임시 제한할 수 있습니다. 구매자에게 유리하게 분쟁이 종결되면 시스템에 기록된 범위에서 관련 임시 회수분과 부채를 복원하거나 해제합니다. 이 기준은 법률상 배제할 수 없는 권리나 구제수단을 제한하지 않습니다.",
        },
        {
          title: "프로모션 결제",
          body: "승인된 환불은 프로모션 적용 후 실제 결제한 금액을 초과할 수 없으며 정가와의 차액이나 할인 자체는 환불되지 않습니다. 100% 할인 결제에는 현금 환불 가치가 없습니다. 법률상 필요하거나 Tomverse 결제 오류가 원인인 경우를 제외하면 사용했거나 환불된 프로모션 코드의 재발급은 보장되지 않습니다. 연간 할인과 프로모션은 해당 코드가 명시적으로 허용한 경우에만 중복됩니다.",
        },
        {
          title: "AI 제공자 장애와 크레딧 복원",
          body: "AI 제공자 요청이 사용 가능한 답변을 만들기 전에 실패하거나 빈 응답을 반환하면 Tomverse는 일반적으로 예약 크레딧을 자동 복원합니다. 사용 가능한 출력이 시작된 후 사용자가 취소하면 생성량에 비례한 크레딧이 남을 수 있습니다. 제공자 장애가 곧바로 현금 환불을 발생시키지는 않지만, 해결되지 않은 중대한 서비스 실패는 본 정책 또는 적용 법률에 따른 구제 대상이 될 수 있습니다. 크레딧이 잘못 차감된 것으로 보이면 추적 ID를 보내주세요.",
        },
        {
          title: "세금, 환율 및 결제 통화",
          body: "환불액은 Stripe가 실제 승인한 금액과 통화를 초과할 수 없습니다. 현지 가격 환산값은 Stripe, 은행, 카드사, 지갑 또는 결제 제공자가 적용하는 세금, 환율이나 수수료로 인해 최종 금액과 다를 수 있습니다. 실제 결제 금액과 판매자 정보는 Stripe 영수증 또는 인보이스를 기준으로 합니다. 제3자의 환전·결제 수수료에는 해당 제공자 정책이 적용됩니다.",
        },
        {
          title: "환불 요청 및 처리 절차",
          body: "구독 또는 크레딧 팩 구매자는 계정 결제 영역에서 환불 심사를 요청하거나 support@tomverse.app으로 문의할 수 있습니다. 계정 이메일, 플랜, 해당하는 경우 팩 이름, 결제일, 거래 또는 영수증 번호, 사유 및 관련 추적 ID를 포함해주세요. 요청은 개별 심사됩니다. 승인되면 Tomverse가 Stripe에 환불을 제출합니다. 구독 환불은 관련 유료 플랜을 취소하거나 하향 전환할 수 있고, 크레딧 팩 환불은 해당 팩 권리만 취소하며 그 자체로 구독을 취소하지 않습니다. 실제 입금 시점은 Stripe와 결제 제공자 처리 기간에 따라 달라집니다.",
        },
        {
          title: "운영 주체와 분쟁",
          body: "Tomverse는 tomverse.app을 운영하며 각 거래의 법적 판매자는 Stripe 영수증 또는 인보이스에 표시됩니다. 문의나 분쟁은 support@tomverse.app 또는 tomverse.app/support로 접수할 수 있고, 적용 법률에 따라 이용 가능한 규제기관, 재판소 또는 법원 절차를 이용할 수 있습니다.",
        },
      ],
      cta: { label: "결제 지원 문의", href: "/support" },
    },
    zh: {
      eyebrow: "账单",
      title: "退款政策",
      description: "适用于 Tomverse 订阅和附加积分购买的退款、账单更正、取消、积分、促销和提供商故障规则。",
      updated: "最后更新：2026 年 7 月 15 日",
      sections: [
        { title: "范围和不可排除的消费者权利", body: "本政策适用于通过 Tomverse 购买并由 Stripe 处理的 Pro、Max 订阅和一次性附加积分包，包括 Free 方案用户购买的 Starter Credit Pack。本政策不排除法律不得排除的保证或救济。在澳大利亚消费者法适用时，重大服务故障或未在合理时间内纠正的问题可能使你有权取消、获得未使用部分退款、纠正或赔偿。" },
        { title: "可能退款或更正账单的情况", body: "我们会审查重复、未授权或错误收费；付费方案或购买的积分包未交付；重大服务故障；或法律要求退款的情况。其他请求可根据收费时间、计费周期或积分包、已使用的付费权益及提交的事实，酌情批准全部或部分退款。", bullets: ["重复、未授权或错误收费", "未提供付费访问或购买的积分，或发生重大服务故障", "适用消费者法要求的救济"] },
        { title: "通常不退款的情况", body: "除非法律要求，改变主意、忘记在续订前取消、对有效 AI 回答的风格或内容不满意、正常取消后的未使用时间、未使用月度积分，或正确发放后仅未使用的附加积分，通常不予退款。提交请求不保证批准，也不会自动取消订阅或积分包权益。" },
        { title: "月付和年付取消", body: "账户区域取消会停止下一次续订。月付通常持续到当前付费月结束，年付持续到当前付费年结束。取消本身不会自动按比例退款。批准退款时，当前系统会取消付费订阅并把账户转为 Free。" },
        { title: "月度积分和附加积分", body: "AI 积分是服务额度，不是储值资金。月度方案积分按 UTC 在每个自然月开始时重置，不结转，并归属于相应方案周期。附加积分是独立的一次性购买，自购买之日起 12 个月（365 天）后到期，不会随月度额度重置。两种余额均不可转让或兑换现金。Tomverse 先扣除可用月度方案积分，再按最早到期顺序扣除附加积分。" },
        { title: "取消方案后的附加积分", body: "取消或降级 Pro、Max 本身不会删除仍有效的附加积分。即使账户转为 Free，积分仍保留至标示的到期日。附加积分只增加用量，不会解锁更高方案、模型、文件或其他功能，也不会提高每日限制、方案特定的高成本模型限制、公平使用限制或其他保障；只能在账户当前方案的权限和限制内使用。" },
        { title: "附加积分的全额退款、部分退款和拒付", body: "附加积分的全部或部分退款获批时，Tomverse 会按相应比例撤销购买权益，并先收回该购买中尚未使用的积分。已经使用而无法收回的积分及相关资助用量可记为积分债务，并在未来月度积分或附加积分购买可用前优先抵扣。拒付或付款争议可触发相同的临时撤销，并在争议未解决期间临时限制 AI 使用。若争议最终对购买者有利，系统会在记录范围内恢复或清除相关临时撤销和债务。本规则不限制法律不得排除的权利或救济。" },
        { title: "促销购买", body: "获批退款不超过促销后实际支付的金额；原价差额和折扣本身不退款。零元促销没有现金退款价值。除法律要求或 Tomverse 账单错误外，不保证重新发放已使用或已退款的促销代码。" },
        { title: "提供商故障和积分恢复", body: "AI 提供商在生成可用回答前失败或返回空响应时，Tomverse 通常会自动释放预留积分。可用输出开始后由用户取消时，可能保留按生成量计算的积分消耗。若积分似乎错误扣除，请附 trace ID 联系支持。" },
        { title: "税费、汇率和付款币种", body: "退款不超过 Stripe 实际收取的金额和币种。本地价格换算可能因税费、汇率或第三方费用与最终金额不同。实际金额和销售方身份以 Stripe 收据或发票为准。" },
        { title: "如何申请和处理", body: "订阅或积分包购买者可从账户账单区域申请退款审查，或联系 support@tomverse.app。请提供账户邮箱、方案、适用时的积分包名称、收费日期、交易或收据编号、原因和相关 trace ID。批准后，Tomverse 会向 Stripe 提交退款。订阅退款可能取消或降级相关付费方案；积分包退款只撤销对应积分包权益，不会因此自动取消订阅。到账时间取决于 Stripe 和付款服务商。" },
        { title: "运营方和争议", body: "Tomverse 运营 tomverse.app，每笔交易的法定销售方标示在 Stripe 收据或发票上。问题或争议可发送至 support@tomverse.app 或 tomverse.app/support，也可使用适用法律提供的监管机构、仲裁庭或法院程序。" },
      ],
      cta: { label: "联系账单支持", href: "/support" },
    },
  },
  safety: {
  "ko": {
    "eyebrow": "안전과 데이터 처리",
    "title": "안전과 데이터 처리",
    "description": "대화 접근, 공유 범위와 AI 제공자의 처리를 이해하고, 필요한 보호 기능을 선택하세요. 중요한 답변은 원문과 출처를 함께 확인하는 것이 좋습니다.",
    "sections": [
      {
        "title": "사용 중 나를 보호하는 기능",
        "body": "모델 이용 범위와 사용량, 파일 형식·용량 검사를 통해 사용할 수 있는 기능과 제한을 안내합니다. 지원되지 않는 파일은 이유를 확인하고 읽을 수 있는 형식으로 다시 준비할 수 있습니다."
      },
      {
        "title": "보안과 데이터 처리",
        "body": "선택한 AI 제공자는 답변에 필요한 질문과 자료를 처리합니다. 잠금은 저장된 대화에 대한 접근을 제어하고, 공유는 당시 내용의 읽기 전용 링크를 만듭니다. 자세한 데이터 처리 범위는 안전 안내에서 확인하세요."
      },
      {
        "title": "AI의 한계와 서비스 상태",
        "body": "답변은 선택한 외부 AI 모델이 생성하며 틀리거나 빠진 내용이 있을 수 있습니다. AI Review는 답변끼리 비교하는 기능입니다. 추가 사실 확인과 웹 검색은 별도 작업이며, 현재 모델 제공 상태는 서비스 상태 페이지에서 확인할 수 있습니다."
      }
    ]
  },
  "en": {
    "eyebrow": "Safety and data handling",
    "title": "Safety and data handling",
    "description": "Understand access to conversations, sharing and AI-provider processing, then choose the controls you need. Check important answers against the original material and sources.",
    "sections": [
      {
        "title": "Controls that help protect your use",
        "body": "Model access, usage limits and file checks show what is supported. If a file is not supported, check the reason and prepare a readable version."
      },
      {
        "title": "Security and data handling",
        "body": "Your selected AI provider processes the question and material needed to answer. Locks control access to saved conversations; sharing creates a read-only link to the content at that time. See the safety information for data-handling details."
      },
      {
        "title": "AI limitations and service status",
        "body": "Answers come from the selected external AI models and can be wrong or incomplete. AI Review compares those answers. External checks and web search are separate actions; see the service-status page for current availability."
      }
    ]
  },
  "zh": {
    "eyebrow": "安全与数据处理",
    "title": "安全与数据处理",
    "description": "了解对话访问、分享范围与 AI 提供商处理，再选择所需保护功能。重要回答应结合原始资料与来源确认。",
    "sections": [
      {
        "title": "帮助保护使用过程的功能",
        "body": "模型范围、用量限制及文件检查会说明支持条件。文件不支持时，可查看原因并准备可读取版本。"
      },
      {
        "title": "安全与数据处理",
        "body": "所选 AI 提供商会处理回答所需的问题与资料。锁定控制已保存对话的访问；分享会生成当时内容的只读链接。数据处理详情请查看安全说明。"
      },
      {
        "title": "AI 局限与服务状态",
        "body": "回答由所选外部 AI 模型生成，可能错误或遗漏。AI Review 比较这些回答，外部核实与网页搜索是独立操作。当前可用状态请查看服务状态页。"
      }
    ]
  },
  "fr": {
    "eyebrow": "Sécurité et traitement des données",
    "title": "Sécurité et traitement des données",
    "description": "Comprenez l’accès aux conversations, le partage et le traitement par les fournisseurs IA pour choisir les contrôles utiles. Vérifiez les réponses importantes dans les documents et sources.",
    "sections": [
      {
        "title": "Les contrôles qui protègent votre usage",
        "body": "L’accès aux modèles, les limites d’usage et les contrôles de fichiers précisent ce qui est pris en charge. En cas de refus, consultez le motif et préparez un fichier lisible."
      },
      {
        "title": "Sécurité et traitement des données",
        "body": "Le fournisseur IA choisi traite la question et les documents nécessaires à la réponse. Le verrou contrôle l’accès aux conversations enregistrées ; le partage crée un lien en lecture seule vers leur contenu à cet instant. Consultez les informations de sécurité pour le traitement des données."
      },
      {
        "title": "Limites de l’IA et état du service",
        "body": "Les modèles externes choisis génèrent les réponses, qui peuvent être erronées ou incomplètes. AI Review compare ces réponses. Vérifications externes et recherche web sont distinctes ; consultez l’état du service."
      }
    ]
  },
  "de": {
    "eyebrow": "Sicherheit und Datenverarbeitung",
    "title": "Sicherheit und Datenverarbeitung",
    "description": "Verstehen Sie Gesprächszugriff, Freigaben und KI-Anbieter-Verarbeitung und wählen Sie nötige Schutzfunktionen. Prüfen Sie wichtige Antworten am Original und an Quellen.",
    "sections": [
      {
        "title": "Schutzfunktionen bei der Nutzung",
        "body": "Modellzugriff, Nutzungslimits und Dateiprüfungen zeigen die unterstützten Möglichkeiten. Prüfen Sie bei abgelehnten Dateien den Grund und erstellen Sie eine lesbare Fassung."
      },
      {
        "title": "Sicherheit und Datenverarbeitung",
        "body": "Der gewählte KI-Anbieter verarbeitet die nötige Frage und das Material. Sperren regelt den Zugriff auf gespeicherte Gespräche; Teilen erstellt einen Nur-Lese-Link zum damaligen Inhalt. Details finden Sie in den Sicherheitsinformationen."
      },
      {
        "title": "KI-Grenzen und Servicestatus",
        "body": "Ausgewählte externe Modelle erzeugen Antworten, die falsch oder unvollständig sein können. AI Review vergleicht diese Antworten. Externe Prüfung und Websuche sind separate Schritte; die Verfügbarkeit steht auf der Statusseite."
      }
    ]
  },
  "es": {
    "eyebrow": "Seguridad y tratamiento de datos",
    "title": "Seguridad y tratamiento de datos",
    "description": "Entiende el acceso a conversaciones, el alcance de compartir y el procesamiento de los proveedores. Elige los controles necesarios y revisa respuestas importantes con el original y las fuentes.",
    "sections": [
      {
        "title": "Funciones que ayudan a proteger tu uso",
        "body": "El acceso a modelos, los límites y las comprobaciones de archivos indican qué se admite. Si se rechaza un archivo, revisa el motivo y prepara una versión legible."
      },
      {
        "title": "Seguridad y tratamiento de datos",
        "body": "El proveedor de IA seleccionado procesa la pregunta y el material necesarios. El bloqueo controla el acceso a conversaciones guardadas; compartir crea un enlace de solo lectura al contenido de ese momento. Consulta los detalles en la información de seguridad."
      },
      {
        "title": "Límites de la IA y estado del servicio",
        "body": "Los modelos externos elegidos generan respuestas que pueden ser incorrectas o incompletas. AI Review compara esas respuestas. La verificación externa y búsqueda web son acciones separadas; consulta el estado del servicio."
      }
    ]
  },
  "pt": {
    "eyebrow": "Segurança e tratamento de dados",
    "title": "Segurança e tratamento de dados",
    "description": "Entenda o acesso às conversas, o compartilhamento e o processamento dos provedores. Escolha os controles necessários e confira respostas importantes com o original e as fontes.",
    "sections": [
      {
        "title": "Recursos que ajudam a proteger seu uso",
        "body": "O acesso a modelos, os limites e as verificações de arquivos mostram o que é compatível. Se um arquivo for recusado, veja o motivo e prepare uma versão legível."
      },
      {
        "title": "Segurança e tratamento de dados",
        "body": "O provedor de IA escolhido processa a pergunta e o material necessários. O bloqueio controla o acesso a conversas salvas; compartilhar cria um link somente leitura do conteúdo daquele momento. Veja os detalhes nas informações de segurança."
      },
      {
        "title": "Limites da IA e status do serviço",
        "body": "Os modelos externos escolhidos geram respostas que podem estar erradas ou incompletas. O AI Review compara essas respostas. Verificação externa e busca na web são ações separadas; consulte o status do serviço."
      }
    ]
  }
},
  about: {
  "ko": {
    "eyebrow": "Tomverse",
    "title": "Tomverse 소개",
    "description": "모델을 고르느라 질문을 미루거나, 여러 답변을 복사해 비교하느라 시간을 쓰지 않도록 만들고 있습니다. Tomverse Chat은 질문에 맞는 모델 선택과 질문 다듬기를 돕고, Tomverse Review는 서로 다른 답변을 나란히 살펴보고 검토할 수 있게 합니다.",
    "sections": [
      {
        "title": "질문을 시작하기 쉽게",
        "body": "어떤 모델을 고를지 몰라도, 질문하고 비교하는 경험을 시작할 수 있게 만드는 것이 목표입니다. 공부할 때, 글을 다듬을 때, 자료를 이해할 때처럼 일상에서 필요한 결과에 집중합니다."
      },
      {
        "title": "선택과 판단은 사용자의 손에",
        "body": "질문 개선 제안은 확인하고 채택할 수 있고, 모델도 직접 선택할 수 있습니다. Review에서는 여러 답변을 같은 맥락에서 읽고 인용을 확인하며 더 살펴볼 내용을 판단합니다. 결과를 저장하고 다시 활용하는 일도 같은 경험 안에서 이어집니다."
      },
      {
        "title": "먼저 써보고, 필요에 맞게",
        "body": "Chat과 Review를 먼저 체험하고, 자주 쓰게 될 때 필요한 플랜을 선택하세요. 무료 계정으로 대화를 저장하고 지원되는 공유·파일 기능을 이용할 수 있습니다. 더 많은 사용량이나 모델이 필요하다면 Free·Pro·Max의 제공 범위와 크레딧을 비교해 보세요."
      },
      {
        "title": "운영 주체와 연락처",
        "body": "Tomverse는 tomverse.app의 서비스 및 운영 명칭이며, Tomverse Review를 비롯한 Tomverse의 제품들을 운영합니다. 유료 거래의 법적 판매자는 Stripe 결제 화면, 영수증 또는 인보이스에 표시됩니다. 계정, 결제, 법률 또는 제품 관련 문의는 support@tomverse.app 또는 tomverse.app/support로 접수할 수 있습니다."
      }
    ]
  },
  "en": {
    "eyebrow": "Tomverse",
    "title": "About Tomverse",
    "description": "We’re building Tomverse to reduce the effort of choosing models and comparing answers across separate tools. Tomverse Chat helps with model selection and clearer questions; Tomverse Review lets you read different answers together and examine their differences.",
    "sections": [
      {
        "title": "Make it easier to start a question",
        "body": "Our aim is to help you ask and compare even when you are unsure which model to choose. We focus on useful results for everyday learning, writing and understanding material."
      },
      {
        "title": "Keep you in control",
        "body": "You choose whether to apply question-refinement suggestions and can select a model yourself. Review keeps answers in the same context so you can inspect quotes and decide what deserves another look. Saving and reusing useful results are part of that experience."
      },
      {
        "title": "Try first, choose as needed",
        "body": "Try Chat and Review, then choose a plan as your needs grow. A free account lets you save conversations and use supported sharing and file features. Compare Free, Pro and Max when you need a larger allowance or broader model access."
      },
      {
        "title": "Operator and contact",
        "body": "Tomverse is the service and operating name for tomverse.app, which hosts Tomverse Review and other Tomverse products. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries."
      }
    ]
  },
  "zh": {
    "eyebrow": "Tomverse",
    "title": "关于 Tomverse",
    "description": "我们希望减少选择模型和在不同工具间复制、比较回答的麻烦。Tomverse Chat 帮助选择模型、让问题更清楚；Tomverse Review 则把不同回答放在一起，便于阅读和比较。",
    "sections": [
      {
        "title": "让提问更容易开始",
        "body": "我们希望即使不知道该选哪个模型，也能开始提问和比较，专注于学习、文字表达和理解资料等日常需要的结果。"
      },
      {
        "title": "由你掌握选择与判断",
        "body": "提问优化建议由你查看并决定是否采用，也可以手动选模型。在 Review 中，用同一上下文阅读回答、查看引文，决定需要深入了解的内容。保存与再次使用结果也属于这套体验。"
      },
      {
        "title": "先体验，再按需选择",
        "body": "先体验 Chat 和 Review，再按需要选择套餐。免费账户可以保存对话，并使用支持的分享与文件功能。需要更多用量或更广的模型范围时，可比较 Free、Pro、Max 的功能与积分额度。"
      },
      {
        "title": "运营方和联系方式",
        "body": "Tomverse 是 tomverse.app 的服务和运营名称，旗下运营 Tomverse Review 等 Tomverse 产品。付费交易的法定销售方标示在 Stripe 结账页、收据或发票上。账户、账单、法律或产品问题可发送至 support@tomverse.app 或 tomverse.app/support。"
      }
    ]
  },
  "fr": {
    "eyebrow": "Tomverse",
    "title": "À propos de Tomverse",
    "description": "Nous développons Tomverse pour simplifier le choix des modèles et la comparaison de réponses entre plusieurs outils. Tomverse Chat aide à choisir un modèle et à clarifier les questions ; Tomverse Review réunit les réponses pour en examiner les différences.",
    "sections": [
      {
        "title": "Poser une question plus facilement",
        "body": "Notre objectif est de vous aider à poser des questions et comparer sans devoir connaître chaque modèle. Nous privilégions des résultats utiles pour apprendre, écrire et comprendre des documents."
      },
      {
        "title": "Vous gardez la main",
        "body": "Vous décidez d’appliquer les suggestions et pouvez choisir un modèle vous-même. Review rassemble les réponses dans le même contexte pour examiner les citations et choisir quoi approfondir. Vous pouvez ensuite conserver et réutiliser les résultats utiles."
      },
      {
        "title": "Essayez, puis choisissez selon vos besoins",
        "body": "Essayez Chat et Review, puis choisissez une offre selon vos besoins. Un compte gratuit permet de conserver les conversations et d’utiliser les fonctions de partage et de fichiers prises en charge. Comparez Free, Pro et Max si vous avez besoin de plus de crédits ou d’un accès plus large aux modèles."
      },
      {
        "title": "Operator and contact",
        "body": "Tomverse is the service and operating name for tomverse.app, which hosts Tomverse Review and other Tomverse products. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries.",
        "lang": "en"
      }
    ]
  },
  "de": {
    "eyebrow": "Tomverse",
    "title": "Über Tomverse",
    "description": "Wir entwickeln Tomverse, um Modellwahl und Antwortvergleiche über mehrere Werkzeuge zu vereinfachen. Tomverse Chat hilft bei der Auswahl und bei klareren Fragen; Tomverse Review zeigt unterschiedliche Antworten zusammen und macht ihre Unterschiede sichtbar.",
    "sections": [
      {
        "title": "Fragen leichter beginnen",
        "body": "Wir möchten Fragen und Vergleiche auch ohne genaue Modellkenntnis erleichtern. Im Mittelpunkt stehen Ergebnisse für Lernen, Schreiben und das Verstehen von Material."
      },
      {
        "title": "Sie behalten die Kontrolle",
        "body": "Sie entscheiden über Vorschläge und können Modelle selbst wählen. Review hält Antworten im selben Kontext, damit Sie Zitate prüfen und weitere Fragen auswählen können. Nützliche Ergebnisse lassen sich speichern und wiederverwenden."
      },
      {
        "title": "Erst testen, dann nach Bedarf wählen",
        "body": "Testen Sie Chat und Review und wählen Sie einen Tarif passend zu Ihrem Bedarf. Mit einem kostenlosen Konto speichern Sie Gespräche und nutzen unterstützte Freigabe- und Dateifunktionen. Vergleichen Sie Free, Pro und Max für mehr Kontingent oder einen breiteren Modellzugriff."
      },
      {
        "title": "Operator and contact",
        "body": "Tomverse is the service and operating name for tomverse.app, which hosts Tomverse Review and other Tomverse products. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries.",
        "lang": "en"
      }
    ]
  },
  "es": {
    "eyebrow": "Tomverse",
    "title": "Acerca de Tomverse",
    "description": "Creamos Tomverse para reducir el esfuerzo de elegir modelos y comparar respuestas entre herramientas. Tomverse Chat ayuda a elegir un modelo y formular preguntas más claras; Tomverse Review reúne distintas respuestas para examinar sus diferencias.",
    "sections": [
      {
        "title": "Que empezar sea más fácil",
        "body": "Queremos ayudarte a preguntar y comparar aunque no sepas qué modelo elegir. Nos centramos en resultados útiles para aprender, escribir y entender materiales."
      },
      {
        "title": "Tú mantienes el control",
        "body": "Tú decides si aplicar sugerencias y puedes elegir el modelo. Review reúne respuestas en el mismo contexto para revisar citas y decidir qué profundizar. También puedes guardar y reutilizar resultados útiles."
      },
      {
        "title": "Prueba y elige según tus necesidades",
        "body": "Prueba Chat y Review y elige un plan según tus necesidades. Una cuenta gratuita permite guardar conversaciones y usar las funciones compatibles para compartir y trabajar con archivos. Compara Free, Pro y Max si necesitas más uso o acceso a más modelos."
      },
      {
        "title": "Operator and contact",
        "body": "Tomverse is the service and operating name for tomverse.app, which hosts Tomverse Review and other Tomverse products. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries.",
        "lang": "en"
      }
    ]
  },
  "pt": {
    "eyebrow": "Tomverse",
    "title": "Sobre o Tomverse",
    "description": "Criamos o Tomverse para reduzir o esforço de escolher modelos e comparar respostas entre ferramentas. O Tomverse Chat ajuda na escolha e na clareza das perguntas; o Tomverse Review reúne respostas diferentes para examinar suas diferenças.",
    "sections": [
      {
        "title": "Facilitar o primeiro passo",
        "body": "Queremos ajudar você a perguntar e comparar mesmo sem saber qual modelo escolher. Priorizamos resultados úteis para aprender, escrever e entender materiais."
      },
      {
        "title": "Você mantém o controle",
        "body": "Você decide se aplica sugestões e pode escolher o modelo. O Review reúne respostas no mesmo contexto para examinar citações e decidir o que aprofundar. Também é possível salvar e reutilizar resultados úteis."
      },
      {
        "title": "Experimente e escolha conforme a necessidade",
        "body": "Experimente Chat e Review e escolha um plano conforme suas necessidades. Uma conta gratuita permite salvar conversas e usar os recursos compatíveis de compartilhamento e arquivos. Compare Free, Pro e Max quando precisar de mais créditos ou acesso a mais modelos."
      },
      {
        "title": "Operator and contact",
        "body": "Tomverse is the service and operating name for tomverse.app, which hosts Tomverse Review and other Tomverse products. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries.",
        "lang": "en"
      }
    ]
  }
},
  support: {
    en: {
      eyebrow: "Support",
      title: "Support",
      description: "Get help with accounts, model access, files, sharing, active subscriptions, cancellation, refunds, and product feedback.",
      sections: [
        { title: "Help Centre", body: "Start with the Help Centre for common setup and troubleshooting guidance.", bullets: ["Login and OAuth issues", "File upload troubleshooting", "Model access and limits"] },
        { title: "PDF and Office troubleshooting", body: "If a PDF or Office file fails, check that it is not password-protected, corrupted, too large, or a scanned image without extractable text. Re-exporting the document as PDF, reducing the file size, or pasting the key text directly often resolves the issue.", bullets: ["Images, PDFs, Office files, text files, and Google Drive files are supported after login.", "Guest mode does not support attachments.", "Attach up to 5 files, 10 MB each."] },
        { title: "Contact support", body: "For account-specific issues, include your account email, approximate time, browser, and any trace ID shown in the product." },
      ],
      cta: { label: "Open Help Centre", href: "/support/help-centre" },
    },
    ko: {
      eyebrow: "지원",
      title: "지원",
      description: "계정, 모델 접근, 파일, 공유, 유료 구독, 취소, 환불 및 제품 피드백에 대한 도움을 받을 수 있습니다.",
      sections: [
        { title: "Help Centre", body: "일반적인 설정과 문제 해결은 Help Centre에서 먼저 확인할 수 있습니다.", bullets: ["로그인 및 OAuth 문제", "파일 업로드 문제", "모델 접근과 제한"] },
        { title: "지원 문의", body: "계정별 문제는 계정 이메일, 발생 시간, 브라우저, 제품에 표시된 추적 ID를 함께 보내주시면 더 빠르게 확인할 수 있습니다." },
      ],
      cta: { label: "Help Centre 열기", href: "/support/help-centre" },
    },
    zh: {
      eyebrow: "支持",
      title: "支持",
      description: "获取账户、模型访问、文件、分享、付费订阅、取消、退款和产品反馈方面的帮助。",
      sections: [
        { title: "Help Centre", body: "常见设置和故障排查可先查看 Help Centre。", bullets: ["登录和 OAuth 问题", "文件上传排查", "模型访问和限制"] },
        { title: "联系支持", body: "对于账户相关问题，请提供账户邮箱、发生时间、浏览器以及产品中显示的追踪 ID。" },
      ],
      cta: { label: "打开 Help Centre", href: "/support/help-centre" },
    },
  },
  helpCentre: {
  "ko": {
    "eyebrow": "도움말 센터",
    "title": "도움말 센터",
    "description": "Chat과 Review 시작부터 모델 선택, 파일, 저장과 공유까지. 하려는 작업을 고르고 화면에서 무엇을 확인해야 하는지 살펴보세요.",
    "sections": [
      {
        "title": "처음 시작하기",
        "body": "같은 질문에도 답변은 달라집니다. Tomverse Review에서 최대 3개 모델의 답변을 나란히 읽고, AI Review로 공통점·차이·빠진 조건을 인용과 함께 살펴보세요. 검토 결과를 바탕으로 더 읽을 답변과 다음 질문을 직접 고를 수 있습니다.",
        "bullets": [
          "한 모델과 질문을 이어갈 때는 Tomverse Chat을 살펴보세요.",
          "여러 답변을 비교할 때는 Review에서 최대 세 모델을 선택하세요.",
          "저장·공유와 프로젝트는 로그인 후 이용 조건을 확인하세요."
        ],
        "link": {
          "label": "Review 워크스페이스 가이드",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "로그인과 계정 접근",
        "body": "로그인 화면으로 돌아오지 못하면 같은 브라우저에서 다시 시도하세요. 문제가 계속되면 로그인 방법과 화면의 오류 내용을 지원팀에 보내주세요.",
        "bullets": [
          "기존 계정과 같은 이메일·로그인 방법을 사용했는지 확인하세요.",
          "인증 코드가 만료됐다면 화면에서 새 코드를 요청하세요."
        ]
      },
      {
        "title": "모델과 크레딧 확인",
        "body": "전송 전 표시되는 값은 기본 예상 크레딧입니다. 선택한 모델의 기본값을 합산하며, 파일 내용과 긴 대화 기록을 처리한 뒤 적용되는 배율에 따라 최종 사용량은 달라질 수 있습니다.",
        "bullets": [
          "모델 선택창에서 이용 가능한 모델과 기본 크레딧을 확인하세요.",
          "월 플랜 크레딧과 추가 구매 크레딧은 별도로 표시됩니다.",
          "요금제 페이지에서 모델 이용 범위와 사용량을 비교하세요."
        ],
        "link": {
          "label": "먼저 써보고, 필요에 맞게",
          "href": "/pricing"
        }
      },
      {
        "title": "파일과 Google Drive",
        "body": "파일을 첨부할 수 있는 화면에서는 지원 형식과 크기를 먼저 확인하세요. 암호가 걸리거나 손상된 문서, 읽을 텍스트가 없는 스캔 PDF는 처리되지 않을 수 있습니다. 한 파일로 다시 시도하거나 핵심 텍스트를 직접 붙여넣어 보세요.",
        "bullets": [
          "지원되는 비회원 첨부: 메시지당 1개, 파일당 5MB까지. Google Drive 연결은 로그인 필요.",
          "첨부가 허용된 로그인 플랜: 최대 5개, 파일당 10MB, 한 요청 합계 25MB까지.",
          "계정 파일은 대화와 연결되어 보관됩니다. 비회원 파일은 임시 처리되며 저장·공유·내보내기에 포함되지 않습니다."
        ],
        "link": {
          "label": "파일과 Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "답변이 오지 않을 때",
        "body": "모델 제공이 일시적으로 제한되거나 답변 생성에 실패할 수 있습니다. 화면의 이유와 서비스 상태를 확인하고, 필요하면 추천된 대체 모델로 한 번 다시 시도하세요. 계속 실패하면 추적 ID와 모델명을 지원팀에 전달해 주세요."
      },
      {
        "title": "저장·공유와 데이터 처리",
        "body": "선택한 AI 제공자는 답변에 필요한 질문과 자료를 처리합니다. 잠금은 저장된 대화에 대한 접근을 제어하고, 공유는 당시 내용의 읽기 전용 링크를 만듭니다. 자세한 데이터 처리 범위는 안전 안내에서 확인하세요."
      },
      {
        "title": "지원팀에 문의하기",
        "body": "문제가 계속되면 계정 이메일, 대략적인 발생 시간, 사용한 제품과 모델, 첨부 여부, 화면의 추적 ID를 알려주세요. 문의는 폼과 이메일로 접수합니다. 비밀번호나 카드번호는 보내지 마세요."
      }
    ],
    "cta": {
      "label": "지원팀에 문의하기",
      "href": "/support"
    }
  },
  "en": {
    "eyebrow": "Help Centre",
    "title": "Help Centre",
    "description": "From starting Chat and Review to models, files, saving and sharing: choose your task and find what to check on screen.",
    "sections": [
      {
        "title": "Getting started",
        "body": "The same question can produce different answers. In Tomverse Review, read up to three model answers side by side and use AI Review to examine agreements, differences and missing conditions with quotes. Decide which answer to explore and what to ask next.",
        "bullets": [
          "Explore Tomverse Chat for a conversation with one model.",
          "Select up to three models in Review to compare answers.",
          "Check signed-in requirements for saving, sharing and projects."
        ],
        "link": {
          "label": "Review workspace guide",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "Sign-in and account access",
        "body": "If sign-in does not return you to Tomverse, try again in the same browser. If the problem continues, send support the sign-in method and the error shown.",
        "bullets": [
          "Check that you used the email and sign-in method for your account.",
          "Request a new code on screen if the previous one expired."
        ]
      },
      {
        "title": "Models and credits",
        "body": "The amount shown before sending is a base credit estimate. It adds the selected models’ base costs; the final usage may change when file content and long conversation history are processed.",
        "bullets": [
          "See available models and base credits in the model selector.",
          "Monthly plan credits and purchased credits are shown separately.",
          "Compare model access and allowances on the pricing page."
        ],
        "link": {
          "label": "Try first, choose as needed",
          "href": "/pricing"
        }
      },
      {
        "title": "Files and Google Drive",
        "body": "Where attachments are available, check supported formats and sizes. Password-protected, damaged or scanned documents without readable text may fail. Try one file or paste the key text.",
        "bullets": [
          "Supported guest attachments: one file per message, up to 5 MB. Google Drive connection requires sign-in.",
          "Signed-in plans with attachments: up to five files, 10 MB each and 25 MB total per request.",
          "Account files are kept with the conversation. Guest files are temporary and are not included in saving, sharing or exports."
        ],
        "link": {
          "label": "Files and Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "When an answer does not arrive",
        "body": "Models can be temporarily limited or fail to answer. Check the reason and service status, then try a suggested alternative once if needed. If the problem continues, send support the trace ID and model name."
      },
      {
        "title": "Saving, sharing and data",
        "body": "Your selected AI provider processes the question and material needed to answer. Locks control access to saved conversations; sharing creates a read-only link to the content at that time. See the safety information for data-handling details."
      },
      {
        "title": "Contact support",
        "body": "If the problem continues, include your account email, approximate time, product and model, attachment details and the on-screen trace ID. Use the form or email; do not send passwords or card numbers."
      }
    ],
    "cta": {
      "label": "Contact support",
      "href": "/support"
    }
  },
  "zh": {
    "eyebrow": "帮助中心",
    "title": "帮助中心",
    "description": "从开始使用 Chat 与 Review，到模型、文件、保存和分享：选择想完成的任务，查看屏幕上需要确认的内容。",
    "sections": [
      {
        "title": "开始使用",
        "body": "同一个问题，可能得到不同回答。在 Tomverse Review 中并排阅读最多三个模型的回答，再用 AI Review 结合引文查看共识、差异与遗漏条件。由你决定重点阅读哪个回答、接下来问什么。",
        "bullets": [
          "想与一个模型持续对话时，可了解 Tomverse Chat。",
          "比较多个回答时，在 Review 中选择最多三个模型。",
          "保存、分享与项目功能请查看登录后的使用条件。"
        ],
        "link": {
          "label": "Review 工作区指南",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "登录与账户访问",
        "body": "如果登录后无法返回 Tomverse，请在同一浏览器重试。问题仍然存在时，请向支持提供登录方式与屏幕上的错误信息。",
        "bullets": [
          "请确认使用了账户原有邮箱与登录方式。",
          "验证码过期时，请在屏幕上申请新码。"
        ]
      },
      {
        "title": "模型与积分",
        "body": "发送前显示的是基础积分预估，由所选模型的基础消耗相加得出。处理文件内容和较长的对话记录后，最终用量可能发生变化。",
        "bullets": [
          "在选择器中查看可用模型与基础积分。",
          "月度套餐积分与购买积分会分别显示。",
          "在套餐页面比较模型范围与额度。"
        ],
        "link": {
          "label": "先体验，再按需选择",
          "href": "/pricing"
        }
      },
      {
        "title": "文件与 Google Drive",
        "body": "附件可用时，请先确认支持格式与大小。加密、损坏或无可读文字的扫描 PDF 可能无法处理。可尝试一个文件或直接粘贴关键文字。",
        "bullets": [
          "支持的访客附件：每条消息一个文件，最多5MB。连接 Google Drive 需要登录。",
          "允许附件的登录套餐：最多五个文件，每个10MB，每次请求合计25MB。",
          "账户文件与对话一起保留。访客文件为临时处理，不包含在保存、分享或导出中。"
        ],
        "link": {
          "label": "文件与 Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "没有收到回答时",
        "body": "模型可能临时受限或回答失败。请查看原因和服务状态，必要时用推荐替代模型重试一次。仍然失败时，向支持提供追踪ID和模型名。"
      },
      {
        "title": "保存、分享与数据处理",
        "body": "所选 AI 提供商会处理回答所需的问题与资料。锁定控制已保存对话的访问；分享会生成当时内容的只读链接。数据处理详情请查看安全说明。"
      },
      {
        "title": "联系支持",
        "body": "问题持续时，请提供账户邮箱、大致时间、产品与模型、附件情况及追踪ID。通过表单或邮件联系，不要发送密码或银行卡号。"
      }
    ],
    "cta": {
      "label": "联系支持",
      "href": "/support"
    }
  },
  "fr": {
    "eyebrow": "Centre d’aide",
    "title": "Centre d’aide",
    "description": "De Chat et Review aux modèles, fichiers, enregistrement et partage : choisissez votre tâche et les éléments à vérifier à l’écran.",
    "sections": [
      {
        "title": "Bien commencer",
        "body": "Une même question peut produire des réponses différentes. Dans Tomverse Review, lisez jusqu’à trois réponses côte à côte et examinez avec AI Review leurs accords, différences et conditions oubliées, citations à l’appui. Choisissez ensuite quoi approfondir et quelle question poser.",
        "bullets": [
          "Découvrez Tomverse Chat pour dialoguer avec un modèle.",
          "Choisissez jusqu’à trois modèles dans Review pour comparer.",
          "Vérifiez les conditions de connexion pour enregistrer, partager et utiliser les projets."
        ],
        "link": {
          "label": "Guide de l’espace Review",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "Connexion et accès au compte",
        "body": "Si la connexion ne vous ramène pas à Tomverse, réessayez dans le même navigateur. Si le problème persiste, envoyez à l’assistance la méthode utilisée et le message d’erreur.",
        "bullets": [
          "Vérifiez l’adresse et la méthode utilisées pour votre compte.",
          "Demandez un nouveau code si le précédent a expiré."
        ]
      },
      {
        "title": "Modèles et crédits",
        "body": "Le montant affiché avant l’envoi est une estimation des crédits de base, additionnés pour les modèles sélectionnés. L’usage final peut varier après traitement des fichiers et d’un long historique.",
        "bullets": [
          "Consultez modèles accessibles et crédits de base dans le sélecteur.",
          "Les crédits mensuels et achetés sont affichés séparément.",
          "Comparez modèles et quotas sur la page Tarifs."
        ],
        "link": {
          "label": "Essayez, puis choisissez selon vos besoins",
          "href": "/pricing"
        }
      },
      {
        "title": "Fichiers et Google Drive",
        "body": "Lorsque les pièces jointes sont proposées, vérifiez formats et tailles. Un document protégé, endommagé ou scanné sans texte lisible peut échouer. Essayez un seul fichier ou collez le texte essentiel.",
        "bullets": [
          "Pièces jointes invité prises en charge : un fichier par message, jusqu’à 5 Mo. Connexion requise pour Google Drive.",
          "Offres connectées avec pièces jointes : cinq fichiers maximum, 10 Mo chacun et 25 Mo par demande.",
          "Les fichiers du compte sont conservés avec la conversation. Les fichiers invités sont temporaires et exclus de l’enregistrement, du partage et des exports."
        ],
        "link": {
          "label": "Fichiers et Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "Si une réponse n’arrive pas",
        "body": "Un modèle peut être limité ou ne pas répondre. Consultez le motif et l’état du service puis essayez une alternative proposée. Si le problème persiste, transmettez l’identifiant de suivi et le modèle."
      },
      {
        "title": "Enregistrement, partage et données",
        "body": "Le fournisseur IA choisi traite la question et les documents nécessaires à la réponse. Le verrou contrôle l’accès aux conversations enregistrées ; le partage crée un lien en lecture seule vers leur contenu à cet instant. Consultez les informations de sécurité pour le traitement des données."
      },
      {
        "title": "Contacter l’assistance",
        "body": "Indiquez l’e-mail du compte, l’heure approximative, le produit, le modèle, les pièces jointes et l’identifiant affiché. Utilisez le formulaire ou l’e-mail ; n’envoyez ni mot de passe ni numéro de carte."
      }
    ],
    "cta": {
      "label": "Contacter l’assistance",
      "href": "/support"
    }
  },
  "de": {
    "eyebrow": "Hilfecenter",
    "title": "Hilfecenter",
    "description": "Von Chat und Review bis zu Modellen, Dateien, Speichern und Teilen: Wählen Sie Ihre Aufgabe und prüfen Sie die passenden Hinweise.",
    "sections": [
      {
        "title": "Erste Schritte",
        "body": "Dieselbe Frage kann unterschiedliche Antworten liefern. Lesen Sie in Tomverse Review bis zu drei Modellantworten nebeneinander und prüfen Sie mit AI Review Gemeinsamkeiten, Unterschiede und fehlende Bedingungen samt Zitaten. Entscheiden Sie selbst, was Sie vertiefen und als Nächstes fragen.",
        "bullets": [
          "Entdecken Sie Tomverse Chat für ein Gespräch mit einem Modell.",
          "Wählen Sie in Review bis zu drei Modelle für den Vergleich.",
          "Prüfen Sie Kontoanforderungen für Speichern, Teilen und Projekte."
        ],
        "link": {
          "label": "Review-Workspace-Leitfaden",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "Anmeldung und Kontozugriff",
        "body": "Falls Sie nach der Anmeldung nicht zu Tomverse zurückkehren, versuchen Sie es im selben Browser erneut. Bei weiteren Problemen senden Sie dem Support die Anmeldemethode und den angezeigten Fehler.",
        "bullets": [
          "Prüfen Sie E-Mail und Anmeldemethode Ihres Kontos.",
          "Fordern Sie bei abgelaufenem Code einen neuen an."
        ]
      },
      {
        "title": "Modelle und Credits",
        "body": "Vor dem Senden sehen Sie eine Schätzung der Basis-Credits für die gewählten Modelle. Der endgültige Verbrauch kann nach Verarbeitung von Dateien und langem Gesprächsverlauf abweichen.",
        "bullets": [
          "Prüfen Sie verfügbare Modelle und Basis-Credits in der Auswahl.",
          "Monatliche Tarif-Credits und gekaufte Credits werden getrennt angezeigt.",
          "Vergleichen Sie Modellzugriff und Kontingente auf der Tarifseite."
        ],
        "link": {
          "label": "Erst testen, dann nach Bedarf wählen",
          "href": "/pricing"
        }
      },
      {
        "title": "Dateien und Google Drive",
        "body": "Prüfen Sie bei verfügbaren Anhängen Format und Größe. Geschützte, beschädigte oder gescannte Dateien ohne lesbaren Text können scheitern. Versuchen Sie eine Datei oder fügen Sie Kerntext ein.",
        "bullets": [
          "Unterstützte Gastanhänge: eine Datei pro Nachricht, bis 5 MB. Google Drive erfordert Anmeldung.",
          "Berechtigte Kontotarife: bis fünf Dateien, je 10 MB und insgesamt 25 MB pro Anfrage.",
          "Kontodateien werden mit dem Gespräch aufbewahrt. Gastdateien sind temporär und nicht Teil von Speicherung, Freigaben oder Exporten."
        ],
        "link": {
          "label": "Dateien und Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "Wenn eine Antwort ausbleibt",
        "body": "Modelle können eingeschränkt sein oder ausfallen. Prüfen Sie Grund und Status und versuchen Sie nötigenfalls ein vorgeschlagenes Ersatzmodell. Senden Sie bei weiteren Fehlern Trace-ID und Modellname an den Support."
      },
      {
        "title": "Speichern, Teilen und Daten",
        "body": "Der gewählte KI-Anbieter verarbeitet die nötige Frage und das Material. Sperren regelt den Zugriff auf gespeicherte Gespräche; Teilen erstellt einen Nur-Lese-Link zum damaligen Inhalt. Details finden Sie in den Sicherheitsinformationen."
      },
      {
        "title": "Support kontaktieren",
        "body": "Nennen Sie Konto-E-Mail, ungefähre Zeit, Produkt, Modell, Anhänge und angezeigte Trace-ID. Nutzen Sie Formular oder E-Mail; senden Sie keine Passwörter oder Kartennummern."
      }
    ],
    "cta": {
      "label": "Support kontaktieren",
      "href": "/support"
    }
  },
  "es": {
    "eyebrow": "Centro de ayuda",
    "title": "Centro de ayuda",
    "description": "Desde empezar con Chat y Review hasta modelos, archivos, guardar y compartir: elige tu tarea y qué revisar en pantalla.",
    "sections": [
      {
        "title": "Primeros pasos",
        "body": "La misma pregunta puede dar respuestas diferentes. En Tomverse Review, lee hasta tres respuestas en paralelo y usa AI Review para examinar coincidencias, diferencias y condiciones omitidas, con citas. Decide qué respuesta explorar y qué preguntar después.",
        "bullets": [
          "Explora Tomverse Chat para conversar con un modelo.",
          "Elige hasta tres modelos en Review para comparar respuestas.",
          "Consulta los requisitos de cuenta para guardar, compartir y usar proyectos."
        ],
        "link": {
          "label": "Guía del espacio Review",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "Acceso e inicio de sesión",
        "body": "Si al iniciar sesión no vuelves a Tomverse, inténtalo en el mismo navegador. Si el problema continúa, envía al soporte el método de acceso y el error mostrado.",
        "bullets": [
          "Comprueba el correo y el método de acceso de tu cuenta.",
          "Pide un código nuevo si el anterior caducó."
        ]
      },
      {
        "title": "Modelos y créditos",
        "body": "La cantidad que ves antes de enviar es una estimación de créditos base para los modelos seleccionados. El uso final puede variar al procesar archivos e historiales largos.",
        "bullets": [
          "Consulta modelos disponibles y créditos base en el selector.",
          "Los créditos mensuales y comprados aparecen por separado.",
          "Compara acceso a modelos y uso en la página de planes."
        ],
        "link": {
          "label": "Prueba y elige según tus necesidades",
          "href": "/pricing"
        }
      },
      {
        "title": "Archivos y Google Drive",
        "body": "Cuando se admitan adjuntos, comprueba formato y tamaño. Los documentos protegidos, dañados o escaneados sin texto legible pueden fallar. Prueba un archivo o pega el texto clave.",
        "bullets": [
          "Adjuntos de invitado compatibles: un archivo por mensaje, hasta 5 MB. Google Drive requiere iniciar sesión.",
          "Planes con adjuntos: hasta cinco archivos, 10 MB cada uno y 25 MB en total por solicitud.",
          "Los archivos de cuenta se conservan con la conversación. Los archivos de invitado son temporales y no se incluyen al guardar, compartir o exportar."
        ],
        "link": {
          "label": "Archivos y Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "Si no llega una respuesta",
        "body": "Un modelo puede estar limitado o fallar. Revisa el motivo y el estado y prueba una alternativa recomendada si hace falta. Si persiste, envía al soporte el identificador de seguimiento y modelo."
      },
      {
        "title": "Guardar, compartir y datos",
        "body": "El proveedor de IA seleccionado procesa la pregunta y el material necesarios. El bloqueo controla el acceso a conversaciones guardadas; compartir crea un enlace de solo lectura al contenido de ese momento. Consulta los detalles en la información de seguridad."
      },
      {
        "title": "Contactar soporte",
        "body": "Incluye el correo de la cuenta, hora aproximada, producto, modelo, adjuntos y el identificador mostrado. Usa el formulario o correo; no envíes contraseñas ni números de tarjeta."
      }
    ],
    "cta": {
      "label": "Contactar soporte",
      "href": "/support"
    }
  },
  "pt": {
    "eyebrow": "Central de ajuda",
    "title": "Central de ajuda",
    "description": "Do início no Chat e no Review até modelos, arquivos, salvar e compartilhar: escolha sua tarefa e veja o que conferir na tela.",
    "sections": [
      {
        "title": "Primeiros passos",
        "body": "A mesma pergunta pode gerar respostas diferentes. No Tomverse Review, leia até três respostas lado a lado e use o AI Review para examinar consensos, diferenças e condições omitidas, com citações. Decida qual resposta explorar e o que perguntar depois.",
        "bullets": [
          "Conheça o Tomverse Chat para conversar com um modelo.",
          "Escolha até três modelos no Review para comparar respostas.",
          "Confira os requisitos de conta para salvar, compartilhar e usar projetos."
        ],
        "link": {
          "label": "Guia do espaço Review",
          "href": "/support/help-centre/chat-workspace"
        }
      },
      {
        "title": "Login e acesso à conta",
        "body": "Se o login não levar você de volta ao Tomverse, tente novamente no mesmo navegador. Se o problema continuar, informe ao suporte o método de login e o erro exibido.",
        "bullets": [
          "Confira o e-mail e o método de login da sua conta.",
          "Peça um código novo se o anterior expirou."
        ]
      },
      {
        "title": "Modelos e créditos",
        "body": "O valor exibido antes do envio é uma estimativa dos créditos-base dos modelos escolhidos. O uso final pode mudar após o processamento de arquivos e históricos longos.",
        "bullets": [
          "Veja os modelos disponíveis e créditos-base no seletor.",
          "Os créditos mensais e comprados aparecem separadamente.",
          "Compare acesso a modelos e limites na página de planos."
        ],
        "link": {
          "label": "Experimente e escolha conforme a necessidade",
          "href": "/pricing"
        }
      },
      {
        "title": "Arquivos e Google Drive",
        "body": "Quando anexos estiverem disponíveis, confira formato e tamanho. Documentos protegidos, danificados ou digitalizados sem texto legível podem falhar. Tente um arquivo ou cole o texto principal.",
        "bullets": [
          "Anexos compatíveis para visitantes: um por mensagem, até 5 MB. Google Drive exige login.",
          "Planos com anexos: até cinco arquivos, 10 MB por arquivo e 25 MB no total por solicitação.",
          "Os arquivos da conta ficam com a conversa. Arquivos de visitantes são temporários e não entram ao salvar, compartilhar ou exportar."
        ],
        "link": {
          "label": "Arquivos e Google Drive",
          "href": "/ai-for-file-analysis"
        }
      },
      {
        "title": "Quando uma resposta não chega",
        "body": "Um modelo pode estar limitado ou falhar. Confira o motivo e o status e tente uma alternativa sugerida se necessário. Se persistir, envie ao suporte o ID de rastreamento e o modelo."
      },
      {
        "title": "Salvar, compartilhar e dados",
        "body": "O provedor de IA escolhido processa a pergunta e o material necessários. O bloqueio controla o acesso a conversas salvas; compartilhar cria um link somente leitura do conteúdo daquele momento. Veja os detalhes nas informações de segurança."
      },
      {
        "title": "Contatar suporte",
        "body": "Inclua e-mail da conta, horário aproximado, produto, modelo, anexos e o ID exibido. Use formulário ou e-mail; não envie senhas ou números de cartão."
      }
    ],
    "cta": {
      "label": "Contatar suporte",
      "href": "/support"
    }
  }
},
} satisfies Record<
  string,
  { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>
>;

export const focusedSafetyPages = {
  "approach": {
    "ko": {
      "eyebrow": "안전과 데이터 처리",
      "title": "사용 중 나를 보호하는 기능",
      "description": "모델 이용 범위와 사용량, 파일 형식·용량 검사를 통해 사용할 수 있는 기능과 제한을 안내합니다. 지원되지 않는 파일은 이유를 확인하고 읽을 수 있는 형식으로 다시 준비할 수 있습니다.",
      "sections": [
        {
          "title": "사용 중 나를 보호하는 기능",
          "body": "모델 이용 범위와 사용량, 파일 형식·용량 검사를 통해 사용할 수 있는 기능과 제한을 안내합니다. 지원되지 않는 파일은 이유를 확인하고 읽을 수 있는 형식으로 다시 준비할 수 있습니다."
        }
      ]
    },
    "en": {
      "eyebrow": "Safety and data handling",
      "title": "Controls that help protect your use",
      "description": "Model access, usage limits and file checks show what is supported. If a file is not supported, check the reason and prepare a readable version.",
      "sections": [
        {
          "title": "Controls that help protect your use",
          "body": "Model access, usage limits and file checks show what is supported. If a file is not supported, check the reason and prepare a readable version."
        }
      ]
    },
    "zh": {
      "eyebrow": "安全与数据处理",
      "title": "帮助保护使用过程的功能",
      "description": "模型范围、用量限制及文件检查会说明支持条件。文件不支持时，可查看原因并准备可读取版本。",
      "sections": [
        {
          "title": "帮助保护使用过程的功能",
          "body": "模型范围、用量限制及文件检查会说明支持条件。文件不支持时，可查看原因并准备可读取版本。"
        }
      ]
    },
    "fr": {
      "eyebrow": "Sécurité et traitement des données",
      "title": "Les contrôles qui protègent votre usage",
      "description": "L’accès aux modèles, les limites d’usage et les contrôles de fichiers précisent ce qui est pris en charge. En cas de refus, consultez le motif et préparez un fichier lisible.",
      "sections": [
        {
          "title": "Les contrôles qui protègent votre usage",
          "body": "L’accès aux modèles, les limites d’usage et les contrôles de fichiers précisent ce qui est pris en charge. En cas de refus, consultez le motif et préparez un fichier lisible."
        }
      ]
    },
    "de": {
      "eyebrow": "Sicherheit und Datenverarbeitung",
      "title": "Schutzfunktionen bei der Nutzung",
      "description": "Modellzugriff, Nutzungslimits und Dateiprüfungen zeigen die unterstützten Möglichkeiten. Prüfen Sie bei abgelehnten Dateien den Grund und erstellen Sie eine lesbare Fassung.",
      "sections": [
        {
          "title": "Schutzfunktionen bei der Nutzung",
          "body": "Modellzugriff, Nutzungslimits und Dateiprüfungen zeigen die unterstützten Möglichkeiten. Prüfen Sie bei abgelehnten Dateien den Grund und erstellen Sie eine lesbare Fassung."
        }
      ]
    },
    "es": {
      "eyebrow": "Seguridad y tratamiento de datos",
      "title": "Funciones que ayudan a proteger tu uso",
      "description": "El acceso a modelos, los límites y las comprobaciones de archivos indican qué se admite. Si se rechaza un archivo, revisa el motivo y prepara una versión legible.",
      "sections": [
        {
          "title": "Funciones que ayudan a proteger tu uso",
          "body": "El acceso a modelos, los límites y las comprobaciones de archivos indican qué se admite. Si se rechaza un archivo, revisa el motivo y prepara una versión legible."
        }
      ]
    },
    "pt": {
      "eyebrow": "Segurança e tratamento de dados",
      "title": "Recursos que ajudam a proteger seu uso",
      "description": "O acesso a modelos, os limites e as verificações de arquivos mostram o que é compatível. Se um arquivo for recusado, veja o motivo e prepare uma versão legível.",
      "sections": [
        {
          "title": "Recursos que ajudam a proteger seu uso",
          "body": "O acesso a modelos, os limites e as verificações de arquivos mostram o que é compatível. Se um arquivo for recusado, veja o motivo e prepare uma versão legível."
        }
      ]
    }
  },
  "securityPrivacy": {
    "ko": {
      "eyebrow": "안전과 데이터 처리",
      "title": "보안과 데이터 처리",
      "description": "선택한 AI 제공자는 답변에 필요한 질문과 자료를 처리합니다. 잠금은 저장된 대화에 대한 접근을 제어하고, 공유는 당시 내용의 읽기 전용 링크를 만듭니다. 자세한 데이터 처리 범위는 안전 안내에서 확인하세요.",
      "sections": [
        {
          "title": "보안과 데이터 처리",
          "body": "선택한 AI 제공자는 답변에 필요한 질문과 자료를 처리합니다. 잠금은 저장된 대화에 대한 접근을 제어하고, 공유는 당시 내용의 읽기 전용 링크를 만듭니다. 자세한 데이터 처리 범위는 안전 안내에서 확인하세요."
        }
      ]
    },
    "en": {
      "eyebrow": "Safety and data handling",
      "title": "Security and data handling",
      "description": "Your selected AI provider processes the question and material needed to answer. Locks control access to saved conversations; sharing creates a read-only link to the content at that time. See the safety information for data-handling details.",
      "sections": [
        {
          "title": "Security and data handling",
          "body": "Your selected AI provider processes the question and material needed to answer. Locks control access to saved conversations; sharing creates a read-only link to the content at that time. See the safety information for data-handling details."
        }
      ]
    },
    "zh": {
      "eyebrow": "安全与数据处理",
      "title": "安全与数据处理",
      "description": "所选 AI 提供商会处理回答所需的问题与资料。锁定控制已保存对话的访问；分享会生成当时内容的只读链接。数据处理详情请查看安全说明。",
      "sections": [
        {
          "title": "安全与数据处理",
          "body": "所选 AI 提供商会处理回答所需的问题与资料。锁定控制已保存对话的访问；分享会生成当时内容的只读链接。数据处理详情请查看安全说明。"
        }
      ]
    },
    "fr": {
      "eyebrow": "Sécurité et traitement des données",
      "title": "Sécurité et traitement des données",
      "description": "Le fournisseur IA choisi traite la question et les documents nécessaires à la réponse. Le verrou contrôle l’accès aux conversations enregistrées ; le partage crée un lien en lecture seule vers leur contenu à cet instant. Consultez les informations de sécurité pour le traitement des données.",
      "sections": [
        {
          "title": "Sécurité et traitement des données",
          "body": "Le fournisseur IA choisi traite la question et les documents nécessaires à la réponse. Le verrou contrôle l’accès aux conversations enregistrées ; le partage crée un lien en lecture seule vers leur contenu à cet instant. Consultez les informations de sécurité pour le traitement des données."
        }
      ]
    },
    "de": {
      "eyebrow": "Sicherheit und Datenverarbeitung",
      "title": "Sicherheit und Datenverarbeitung",
      "description": "Der gewählte KI-Anbieter verarbeitet die nötige Frage und das Material. Sperren regelt den Zugriff auf gespeicherte Gespräche; Teilen erstellt einen Nur-Lese-Link zum damaligen Inhalt. Details finden Sie in den Sicherheitsinformationen.",
      "sections": [
        {
          "title": "Sicherheit und Datenverarbeitung",
          "body": "Der gewählte KI-Anbieter verarbeitet die nötige Frage und das Material. Sperren regelt den Zugriff auf gespeicherte Gespräche; Teilen erstellt einen Nur-Lese-Link zum damaligen Inhalt. Details finden Sie in den Sicherheitsinformationen."
        }
      ]
    },
    "es": {
      "eyebrow": "Seguridad y tratamiento de datos",
      "title": "Seguridad y tratamiento de datos",
      "description": "El proveedor de IA seleccionado procesa la pregunta y el material necesarios. El bloqueo controla el acceso a conversaciones guardadas; compartir crea un enlace de solo lectura al contenido de ese momento. Consulta los detalles en la información de seguridad.",
      "sections": [
        {
          "title": "Seguridad y tratamiento de datos",
          "body": "El proveedor de IA seleccionado procesa la pregunta y el material necesarios. El bloqueo controla el acceso a conversaciones guardadas; compartir crea un enlace de solo lectura al contenido de ese momento. Consulta los detalles en la información de seguridad."
        }
      ]
    },
    "pt": {
      "eyebrow": "Segurança e tratamento de dados",
      "title": "Segurança e tratamento de dados",
      "description": "O provedor de IA escolhido processa a pergunta e o material necessários. O bloqueio controla o acesso a conversas salvas; compartilhar cria um link somente leitura do conteúdo daquele momento. Veja os detalhes nas informações de segurança.",
      "sections": [
        {
          "title": "Segurança e tratamento de dados",
          "body": "O provedor de IA escolhido processa a pergunta e o material necessários. O bloqueio controla o acesso a conversas salvas; compartilhar cria um link somente leitura do conteúdo daquele momento. Veja os detalhes nas informações de segurança."
        }
      ]
    }
  },
  "trustTransparency": {
    "ko": {
      "eyebrow": "안전과 데이터 처리",
      "title": "AI의 한계와 서비스 상태",
      "description": "답변은 선택한 외부 AI 모델이 생성하며 틀리거나 빠진 내용이 있을 수 있습니다. AI Review는 답변끼리 비교하는 기능입니다. 추가 사실 확인과 웹 검색은 별도 작업이며, 현재 모델 제공 상태는 서비스 상태 페이지에서 확인할 수 있습니다.",
      "sections": [
        {
          "title": "AI의 한계와 서비스 상태",
          "body": "답변은 선택한 외부 AI 모델이 생성하며 틀리거나 빠진 내용이 있을 수 있습니다. AI Review는 답변끼리 비교하는 기능입니다. 추가 사실 확인과 웹 검색은 별도 작업이며, 현재 모델 제공 상태는 서비스 상태 페이지에서 확인할 수 있습니다."
        }
      ]
    },
    "en": {
      "eyebrow": "Safety and data handling",
      "title": "AI limitations and service status",
      "description": "Answers come from the selected external AI models and can be wrong or incomplete. AI Review compares those answers. External checks and web search are separate actions; see the service-status page for current availability.",
      "sections": [
        {
          "title": "AI limitations and service status",
          "body": "Answers come from the selected external AI models and can be wrong or incomplete. AI Review compares those answers. External checks and web search are separate actions; see the service-status page for current availability."
        }
      ]
    },
    "zh": {
      "eyebrow": "安全与数据处理",
      "title": "AI 局限与服务状态",
      "description": "回答由所选外部 AI 模型生成，可能错误或遗漏。AI Review 比较这些回答，外部核实与网页搜索是独立操作。当前可用状态请查看服务状态页。",
      "sections": [
        {
          "title": "AI 局限与服务状态",
          "body": "回答由所选外部 AI 模型生成，可能错误或遗漏。AI Review 比较这些回答，外部核实与网页搜索是独立操作。当前可用状态请查看服务状态页。"
        }
      ]
    },
    "fr": {
      "eyebrow": "Sécurité et traitement des données",
      "title": "Limites de l’IA et état du service",
      "description": "Les modèles externes choisis génèrent les réponses, qui peuvent être erronées ou incomplètes. AI Review compare ces réponses. Vérifications externes et recherche web sont distinctes ; consultez l’état du service.",
      "sections": [
        {
          "title": "Limites de l’IA et état du service",
          "body": "Les modèles externes choisis génèrent les réponses, qui peuvent être erronées ou incomplètes. AI Review compare ces réponses. Vérifications externes et recherche web sont distinctes ; consultez l’état du service."
        }
      ]
    },
    "de": {
      "eyebrow": "Sicherheit und Datenverarbeitung",
      "title": "KI-Grenzen und Servicestatus",
      "description": "Ausgewählte externe Modelle erzeugen Antworten, die falsch oder unvollständig sein können. AI Review vergleicht diese Antworten. Externe Prüfung und Websuche sind separate Schritte; die Verfügbarkeit steht auf der Statusseite.",
      "sections": [
        {
          "title": "KI-Grenzen und Servicestatus",
          "body": "Ausgewählte externe Modelle erzeugen Antworten, die falsch oder unvollständig sein können. AI Review vergleicht diese Antworten. Externe Prüfung und Websuche sind separate Schritte; die Verfügbarkeit steht auf der Statusseite."
        }
      ]
    },
    "es": {
      "eyebrow": "Seguridad y tratamiento de datos",
      "title": "Límites de la IA y estado del servicio",
      "description": "Los modelos externos elegidos generan respuestas que pueden ser incorrectas o incompletas. AI Review compara esas respuestas. La verificación externa y búsqueda web son acciones separadas; consulta el estado del servicio.",
      "sections": [
        {
          "title": "Límites de la IA y estado del servicio",
          "body": "Los modelos externos elegidos generan respuestas que pueden ser incorrectas o incompletas. AI Review compara esas respuestas. La verificación externa y búsqueda web son acciones separadas; consulta el estado del servicio."
        }
      ]
    },
    "pt": {
      "eyebrow": "Segurança e tratamento de dados",
      "title": "Limites da IA e status do serviço",
      "description": "Os modelos externos escolhidos geram respostas que podem estar erradas ou incompletas. O AI Review compara essas respostas. Verificação externa e busca na web são ações separadas; consulte o status do serviço.",
      "sections": [
        {
          "title": "Limites da IA e status do serviço",
          "body": "Os modelos externos escolhidos geram respostas que podem estar erradas ou incompletas. O AI Review compara essas respostas. Verificação externa e busca na web são ações separadas; consulte o status do serviço."
        }
      ]
    }
  }
} satisfies Record<
  string,
  { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>
>;
