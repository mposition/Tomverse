"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Code2,
  FileText,
  FolderKanban,
  HeartHandshake,
  HelpCircle,
  Layers3,
  LockKeyhole,
  Search,
  ServerCog,
  Share2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Workflow,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

const supportedModels = [
  { name: "GPT", mark: "◎", detail: "OpenAI", className: "from-white to-zinc-100", image: "/model-icons/chatgpt.png" },
  { name: "Claude", mark: "AI", detail: "Anthropic", className: "from-white to-orange-50", image: "/model-icons/claude.png" },
  { name: "Gemini", mark: "✦", detail: "Google", className: "from-white to-sky-50", image: "/model-icons/gemini.png" },
  { name: "Llama", mark: "∞", detail: "Groq", className: "from-white to-blue-50", image: "/model-icons/llama.png" },
  { name: "DeepSeek", mark: "DS", detail: "DeepSeek", className: "from-white to-blue-50", image: "/model-icons/deepseek.png" },
  { name: "Mistral", mark: "M", detail: "Mistral AI", className: "from-white to-orange-50", image: "/model-icons/mistral.png" },
  { name: "Grok", mark: "/", detail: "xAI", className: "from-white to-zinc-100", image: "/model-icons/grok.png" },
  { name: "Kimi", mark: "KM", detail: "Moonshot", className: "from-white to-blue-50", image: "/model-icons/kimi.png" },
  { name: "Qwen", mark: "QW", detail: "Alibaba", className: "from-white to-indigo-50", image: "/model-icons/qwen.png" },
  { name: "Perplexity", mark: "P", detail: "Sonar", className: "from-white to-cyan-50", image: "/model-icons/perplexity.png" },
];

type CardCopy = { title: string; description: string };
type PricingPreviewCopy = CardCopy & { price: string; bullets: string[] };
type LaunchCopy = {
  eyebrow: string;
  title: string;
  description: string;
  items: CardCopy[];
};

type LandingCopy = {
  app: string;
  badge: string;
  title: string;
  description: string;
  primaryCta: string;
  pricingCta: string;
  steps: string[];
  previewTitle: string;
  previewCount: string;
  previewAnswers: string[];
  featuresTitle: string;
  featuresDescription: string;
  features: CardCopy[];
  useCasesTitle: string;
  useCasesDescription: string;
  useCases: CardCopy[];
  whyTitle: string;
  whyDescription: string;
  whyItems: CardCopy[];
  trustTitle: string;
  trustDescription: string;
  trustItems: CardCopy[];
  modelsTitle: string;
  modelsDescription: string;
  pricingTitle: string;
  pricingDescription: string;
  pricingPlans: PricingPreviewCopy[];
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  ctaTitle: string;
  ctaDescription: string;
};

const copy: { en: LandingCopy } & Partial<Record<Language, LandingCopy>> = {
  en: {
    app: "Open app",
    badge: "Multi-model AI workspace",
    title: "Compare the best AI answers in one place.",
    description:
      "Tomverse AI helps you ask once, compare multiple models, attach real files, and keep useful conversations organized for work that needs sharper answers.",
    primaryCta: "Start for free",
    pricingCta: "View pricing",
    steps: ["Choose up to three models", "Send one prompt or attach files", "Compare, follow up, share, or export"],
    previewTitle: "Tomverse comparison",
    previewCount: "3 models",
    previewAnswers: [
      "Direct answer with practical next steps.",
      "Careful reasoning and tradeoffs.",
      "Fast summary with concise structure.",
    ],
    featuresTitle: "A calmer way to use many AIs.",
    featuresDescription:
      "Designed for repeated work, not one-off demos. Keep your model choices, files, private sessions, and shareable outputs in one workflow.",
    features: [
      { title: "Compare AI models side by side", description: "Ask once and compare answers from multiple leading models in one focused workspace." },
      { title: "Work with files and context", description: "Attach images, PDFs, office documents, and Google Drive files when your task needs real material." },
      { title: "Share polished conversations", description: "Turn useful chats into read-only public pages or download them as clean text records." },
      { title: "Built for privacy-aware work", description: "Use locked chats, Private Mode, rate limits, and hardened security controls for safer daily use." },
    ],
    useCasesTitle: "Built for real daily work.",
    useCasesDescription: "Use Tomverse when the task benefits from multiple perspectives, real files, and a reusable record.",
    useCases: [
      { title: "Research and summaries", description: "Compare concise summaries, deeper analysis, and source-aware follow-up ideas." },
      { title: "Coding and debugging", description: "Ask several models for fixes, tradeoffs, tests, and alternative implementations." },
      { title: "Business writing", description: "Draft emails, proposals, product copy, and planning notes with multiple styles." },
      { title: "File-based analysis", description: "Bring screenshots, PDFs, office files, and Drive context into the conversation." },
    ],
    whyTitle: "Why use Tomverse instead of opening every AI app?",
    whyDescription: "Tomverse keeps model choice, conversation context, sharing, and privacy controls in one workflow.",
    whyItems: [
      { title: "One prompt, multiple answers", description: "Compare different model strengths without copying prompts across tabs." },
      { title: "Follow up where it matters", description: "Ask a specific model a follow-up while keeping the full comparison nearby." },
      { title: "Portable outcomes", description: "Share useful conversations or download clean text records for later work." },
    ],
    trustTitle: "Designed with trust controls from day one.",
    trustDescription: "Public AI tools need clear boundaries. Tomverse makes privacy and sharing behavior visible to users.",
    trustItems: [
      { title: "Private Mode clarity", description: "Private Mode does not save Tomverse chat history, while still sending prompts to selected AI providers." },
      { title: "Read-only share snapshots", description: "Shared links are public read-only views designed to avoid exposing later conversation updates." },
      { title: "Locked conversations", description: "Sensitive chats can be locked and require unlock verification before protected actions." },
      { title: "Attachment safeguards", description: "Files are validated, bounded, and handled with temporary storage controls." },
    ],
    modelsTitle: "Built around the model market.",
    modelsDescription:
      "New models arrive constantly. Tomverse keeps model choice centralized so users can compare the right options without rebuilding their workflow.",
    pricingTitle: "Start free, upgrade when usage grows.",
    pricingDescription: "Plans are built around usage allowance, file workflows, sharing, and access to the available model catalogue.",
    pricingPlans: [
      { title: "Free", price: "$0", description: "For trying Tomverse and light daily work.", bullets: ["Free and Pro model tiers", "Usage-limited daily work", "Files, sharing, and downloads after login"] },
      { title: "Pro", price: "$19/mo", description: "For everyday multi-model comparison.", bullets: ["Use TOMVERSE50 for 50% off 3 months", "All available models", "Files, sharing, downloads"] },
      { title: "Max", price: "$35/mo", description: "For heavier AI workflows.", bullets: ["Use TOMVERSE50 for 50% off 3 months", "No daily message limit", "Monthly fair-use protection"] },
    ],
    faqTitle: "Quick questions",
    faqs: [
      { question: "Can I use Tomverse for free?", answer: "Yes. Free is intended for light usage with access to Free and Pro model tiers within usage limits." },
      { question: "Which models are supported?", answer: "Tomverse supports models across providers such as OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, and Perplexity." },
      { question: "What is Private Mode?", answer: "Private Mode means Tomverse does not save the conversation to the Tomverse database. AI providers may still receive prompts to generate responses." },
      { question: "Can I attach files?", answer: "Yes. Tomverse supports images, PDFs, Office documents, Google Drive files, and other allowed attachment types depending on provider support." },
    ],
    ctaTitle: "Ready to compare smarter?",
    ctaDescription: "Start with the free workspace and upgrade when you need more power.",
  },
  ko: {
    app: "? ??",
    badge: "?? ?? AI ??????",
    title: "??? AI ??? ???? ?????.",
    description: "Tomverse AI? ? ?? ???? ?? ??? ??? ????, ?? ??? ????, ??? ??? ??? ???? ??? ? ?? ?????.",
    primaryCta: "??? ????",
    pricingCta: "?? ??",
    steps: ["?? 3? ?? ??","?? ?? ?? ??","??, ?? ??, ??, ????"],
    previewTitle: "Tomverse ??",
    previewCount: "3? ??",
    previewAnswers: ["?? ??? ?? ?? ?? ??","??? ???? ?? ??","??? ??? ??? ??"],
    featuresTitle: "?? AI? ? ???? ???? ??.",
    featuresDescription: "??? ??? ??? ?? ??? ?? ??????. ?? ??, ??, Private Mode, ?? ???? ??? ???? ?????.",
    features: [{ title: "AI ??? ??? ??", description: "? ? ???? ?? ?? ??? ??? ? ???? ???? ??? ? ????." }, { title: "??? ???? ?? ??", description: "???, PDF, Office ??, Google Drive ??? ??? ?? ?? ???? ??? ? ????." }, { title: "??? ???? ??", description: "??? ??? ?? ?? ?? ???? ???? ??? ??? ??? ????? ? ????." }, { title: "?????? ??? ?? ??", description: "?? ??, Private Mode, ??? ??, ?? ?? ? ??? ?? ??? ?? ???? ?????." }],
    useCasesTitle: "?? ?? ??? ?? ??????.",
    useCasesDescription: "?? ??, ?? ??, ??? ??? ??? ??? ???? Tomverse? ????.",
    useCases: [{ title: "???? ??", description: "??? ??, ?? ??, ?? ?? ????? ?? ?? ???? ?????." }, { title: "??? ???", description: "???, ??????, ???, ?? ??? ?? ???? ??? ? ????." }, { title: "???? ???", description: "???, ???, ?? ??, ?? ??? ??? ??? ??????." }, { title: "?? ?? ??", description: "????, PDF, Office ??, Drive ??? ?? ??? ??? ? ????." }],
    whyTitle: "? ?? AI ?? ?? ?? ?? Tomverse? ??????",
    whyDescription: "Tomverse? ?? ??, ?? ??, ??, ????? ??? ??? ???? ????.",
    whyItems: [{ title: "? ? ???? ?? ?? ??", description: "?? ?? ??? ???? ?? ??? ??? ?? ?????." }, { title: "??? ???? ?? ??", description: "?? ?? ??? ????? ?? ???? ?? ??? ?? ? ????." }, { title: "???? ?? ????", description: "??? ??? ????? ??? ???? ???? ?? ??? ? ????." }],
    trustTitle: "???? ?? ??? ??? ??????.",
    trustDescription: "?? AI ???? ??? ??? ?????. Tomverse? ??, ??, ?? ??? ????? ??? ?????.",
    trustItems: [{ title: "Private Mode ??", description: "Private Mode? Tomverse ?? ??? ???? ???, ??? AI ????? ??? ??? ? ????." }, { title: "?? ?? ?? ???", description: "?? ??? ?? ?? ?? ????, ?? ??? ??? ?? ???? ??? ??????." }, { title: "?? ??", description: "??? ??? ?? ? ??, ??? ?? ? ?? ?? ??? ?????." }, { title: "???? ??", description: "??? ??, ?? ??, ?? ?? ??? ?? ?????." }],
    modelsTitle: "??? ??? ?? ??? ???? ??.",
    modelsDescription: "? ??? ?? ?????. Tomverse? ?? ??? ???? ??? ???? ????? ??? ?? ??? ??? ??? ? ?? ???.",
    pricingTitle: "??? ???? ???? ?? ????????.",
    pricingDescription: "???? ??? ??, ?? ????, ?? ??, ?? ??? ?? ???? ??? ???? ??????.",
    pricingPlans: [{ title: "Free", price: "$0", description: "Tomverse ??? ??? ?? ??????.", bullets: ["Free ? Pro ?? ??","??? ?? ?? ?? ??","??? ? ??, ??, ????"] }, { title: "Pro", price: "$19/?", description: "???? ?? ?? ??????.", bullets: ["TOMVERSE50 ?? ? 3?? 50% ??","?? ??? ?? ??","??, ??, ????"] }, { title: "Max", price: "$35/?", description: "??? AI ????????.", bullets: ["TOMVERSE50 ?? ? 3?? 50% ??","?? ??? ???","?? fair-use ??"] }],
    faqTitle: "?? ??",
    faqs: [{ question: "??? ??? ? ????", answer: "?. Free? ??? ?? ??? Free ? Pro ?? ??? ??? ??? ? ??? ?????." }, { question: "?? ??? ??????", answer: "OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity ? ?? ???? ??? ?????." }, { question: "Private Mode? ??????", answer: "Tomverse ??????? ??? ???? ?? ?????. ?? ??? ?? AI ????? ??? ??? ? ????." }, { question: "?? ??? ??????", answer: "?. ???, PDF, Office ??, Google Drive ?? ? ??? ?? ??? ?????. ???? ?? ??? ?? ? ????." }],
    ctaTitle: "? ???? ???????",
    ctaDescription: "?? ??????? ???? ? ??? ??? ??? ? ????????.",
  },
  zh: {
    app: "????",
    badge: "??? AI ???",
    title: "????????? AI ???",
    description: "Tomverse AI ???????????????????????????????????????????",
    primaryCta: "????",
    pricingCta: "????",
    steps: ["????????","?????????","???????????"],
    previewTitle: "Tomverse ??",
    previewCount: "3 ???",
    previewAnswers: ["????????????","?????????","???????????"],
    featuresTitle: "???????? AI?",
    featuresDescription: "??????????????????????????????????????????????",
    features: [{ title: "???? AI ??", description: "??????????????????????????" }, { title: "??????????", description: "?????????????????PDF?Office ??? Google Drive ???" }, { title: "???????", description: "???????????????????????????" }, { title: "???????????", description: "???????Private Mode????????????????????" }],
    useCasesTitle: "???????????",
    useCasesDescription: "??????????????????????Tomverse ??????",
    useCases: [{ title: "?????", description: "???????????????????" }, { title: "?????", description: "???????????????????????" }, { title: "????", description: "???????????????????????" }, { title: "???????", description: "????PDF?Office ??? Drive ????????" }],
    whyTitle: "?????????? AI ???",
    whyDescription: "Tomverse ???????????????????????????",
    whyItems: [{ title: "?????????", description: "?????????????????????????" }, { title: "?????????", description: "??????????????????????" }, { title: "?????", description: "??????????????????????" }],
    trustTitle: "?????????????",
    trustDescription: "?? AI ??????????Tomverse ????????????????",
    trustItems: [{ title: "Private Mode ??", description: "Private Mode ??? Tomverse ???????????????? AI ????" }, { title: "??????", description: "???????????????????????????" }, { title: "????", description: "????????????????????????" }, { title: "????", description: "????????????????????" }],
    modelsTitle: "??????????????",
    modelsDescription: "????????Tomverse ?????????????????????????????",
    pricingTitle: "??????????????",
    pricingDescription: "????????????????????????????????",
    pricingPlans: [{ title: "Free", price: "$0", description: "???? Tomverse ????????", bullets: ["Free ? Pro ????","??????????","??????????????"] }, { title: "Pro", price: "$19/?", description: "??????????", bullets: ["?? TOMVERSE50?3 ?? 50% ??","??????","????????"] }, { title: "Max", price: "$35/?", description: "????? AI ????", bullets: ["?? TOMVERSE50?3 ?? 50% ??","???????","?? fair-use ??"] }],
    faqTitle: "????",
    faqs: [{ question: "????????", answer: "???Free ???????????????? Free ? Pro ???????" }, { question: "???????", answer: "Tomverse ?? OpenAI?Anthropic?Google?Groq?DeepSeek?xAI?Moonshot?Qwen?Perplexity ????????" }, { question: "Private Mode ????", answer: "Private Mode ?? Tomverse ???????? Tomverse ??????????????????? AI ????" }, { question: "????????", answer: "???Tomverse ?????PDF?Office ???Google Drive ???????????????????????????" }],
    ctaTitle: "???????????",
    ctaDescription: "?????????????????????",
  },
  fr: {
    app: "Ouvrir l?app",
    badge: "Espace IA multi-mod?les",
    title: "Comparez les meilleures r?ponses IA au m?me endroit.",
    description: "Tomverse AI vous aide ? poser une seule question, comparer plusieurs mod?les, joindre de vrais fichiers et organiser les conversations utiles.",
    primaryCta: "Commencer gratuitement",
    pricingCta: "Voir les tarifs",
    steps: ["Choisissez jusqu?? trois mod?les","Envoyez une question ou joignez des fichiers","Comparez, poursuivez, partagez ou exportez"],
    previewTitle: "Comparaison Tomverse",
    previewCount: "3 mod?les",
    previewAnswers: ["R?ponse directe avec prochaines ?tapes concr?tes.","Raisonnement prudent et compromis.","R?sum? rapide et bien structur?."],
    featuresTitle: "Une fa?on plus calme d?utiliser plusieurs IA.",
    featuresDescription: "Con?u pour le travail r?p?t?. Gardez mod?les, fichiers, sessions priv?es et r?sultats partageables dans un seul flux.",
    features: [{ title: "Comparer les mod?les IA c?te ? c?te", description: "Posez une question une fois et comparez les r?ponses de plusieurs mod?les dans un espace concentr?." }, { title: "Travailler avec fichiers et contexte", description: "Joignez images, PDF, documents Office et fichiers Google Drive lorsque la t?che exige du contenu r?el." }, { title: "Partager des conversations propres", description: "Transformez des ?changes utiles en pages publiques en lecture seule ou t?l?chargez-les en texte clair." }, { title: "Pens? pour le travail sensible ? la confidentialit?", description: "Utilisez conversations verrouill?es, Private Mode, limites d?usage et contr?les de s?curit?." }],
    useCasesTitle: "Con?u pour le vrai travail quotidien.",
    useCasesDescription: "Utilisez Tomverse quand la t?che b?n?ficie de plusieurs perspectives, de fichiers r?els et d?un historique r?utilisable.",
    useCases: [{ title: "Recherche et r?sum?s", description: "Comparez synth?ses, analyses plus profondes et id?es de suivi." }, { title: "Code et d?bogage", description: "Demandez corrections, compromis, tests et alternatives ? plusieurs mod?les." }, { title: "R?daction professionnelle", description: "R?digez e-mails, propositions, textes produit et notes de planification avec plusieurs styles." }, { title: "Analyse de fichiers", description: "Int?grez captures, PDF, fichiers Office et contexte Drive ? la conversation." }],
    whyTitle: "Pourquoi utiliser Tomverse plut?t que plusieurs apps IA ?",
    whyDescription: "Tomverse r?unit choix du mod?le, contexte, partage et confidentialit? dans un seul flux.",
    whyItems: [{ title: "Une question, plusieurs r?ponses", description: "Comparez les forces des mod?les sans copier vos prompts dans plusieurs onglets." }, { title: "Relancer le bon mod?le", description: "Posez une question de suivi ? un mod?le pr?cis tout en gardant la comparaison." }, { title: "Des r?sultats portables", description: "Partagez ou t?l?chargez les conversations utiles pour les r?utiliser." }],
    trustTitle: "Des contr?les de confiance d?s le d?part.",
    trustDescription: "Les outils IA publics ont besoin de limites claires. Tomverse rend visibles stockage, partage et verrouillage.",
    trustItems: [{ title: "Private Mode clair", description: "Private Mode ne sauvegarde pas l?historique Tomverse, mais les prompts peuvent ?tre envoy?s aux fournisseurs IA s?lectionn?s." }, { title: "Snapshots partag?s en lecture seule", description: "Les liens partag?s sont des vues publiques en lecture seule qui n?exposent pas les mises ? jour ult?rieures." }, { title: "Conversations verrouill?es", description: "Les ?changes sensibles peuvent ?tre verrouill?s avant certaines actions prot?g?es." }, { title: "Protection des fichiers", description: "Les fichiers sont valid?s, limit?s et trait?s avec stockage temporaire contr?l?." }],
    modelsTitle: "Con?u pour un march? des mod?les qui ?volue vite.",
    modelsDescription: "Tomverse centralise le choix des mod?les pour comparer les bonnes options sans changer de flux de travail.",
    pricingTitle: "Commencez gratuitement, passez au niveau sup?rieur quand l?usage augmente.",
    pricingDescription: "Les plans reposent sur les quotas, les fichiers, le partage et l?acc?s au catalogue de mod?les.",
    pricingPlans: [{ title: "Free", price: "$0", description: "Pour essayer Tomverse et travailler l?g?rement au quotidien.", bullets: ["Niveaux Free et Pro","Usage quotidien limit?","Fichiers, partage et t?l?chargements apr?s connexion"] }, { title: "Pro", price: "$19/mois", description: "Pour la comparaison multi-mod?les quotidienne.", bullets: ["TOMVERSE50 : -50 % pendant 3 mois","Tous les mod?les disponibles","Fichiers, partage, t?l?chargements"] }, { title: "Max", price: "$35/mois", description: "Pour les workflows IA plus intensifs.", bullets: ["TOMVERSE50 : -50 % pendant 3 mois","Aucune limite quotidienne de messages","Protection mensuelle fair-use"] }],
    faqTitle: "Questions rapides",
    faqs: [{ question: "Puis-je utiliser Tomverse gratuitement ?", answer: "Oui. Free est pr?vu pour un usage l?ger avec acc?s aux niveaux Free et Pro dans les limites." }, { question: "Quels mod?les sont pris en charge ?", answer: "Tomverse prend en charge OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity et d?autres." }, { question: "Qu?est-ce que Private Mode ?", answer: "Private Mode signifie que Tomverse ne sauvegarde pas la conversation dans sa base de donn?es. Les fournisseurs IA peuvent toujours recevoir les prompts." }, { question: "Puis-je joindre des fichiers ?", answer: "Oui. Images, PDF, documents Office, fichiers Google Drive et autres types autoris?s selon le fournisseur." }],
    ctaTitle: "Pr?t ? comparer plus intelligemment ?",
    ctaDescription: "Commencez avec l?espace gratuit et passez au niveau sup?rieur quand vous avez besoin de plus de puissance.",
  },
  de: {
    app: "App ?ffnen",
    badge: "Multi-Modell-KI-Arbeitsbereich",
    title: "Vergleichen Sie die besten KI-Antworten an einem Ort.",
    description: "Tomverse AI hilft Ihnen, einmal zu fragen, mehrere Modelle zu vergleichen, echte Dateien anzuh?ngen und n?tzliche Unterhaltungen f?r die Arbeit zu organisieren.",
    primaryCta: "Kostenlos starten",
    pricingCta: "Preise ansehen",
    steps: ["Bis zu drei Modelle ausw?hlen","Eine Frage senden oder Dateien anh?ngen","Vergleichen, nachfragen, teilen oder exportieren"],
    previewTitle: "Tomverse-Vergleich",
    previewCount: "3 Modelle",
    previewAnswers: ["Direkte Antwort mit praktischen n?chsten Schritten.","Sorgf?ltige Begr?ndung mit Abw?gungen.","Schnelle, knappe und strukturierte Zusammenfassung."],
    featuresTitle: "Eine ruhigere Art, mehrere KIs zu nutzen.",
    featuresDescription: "F?r wiederkehrende Arbeit entwickelt, nicht nur f?r Demos. Modelle, Dateien, private Sitzungen und teilbare Ergebnisse bleiben in einem Ablauf.",
    features: [{ title: "KI-Modelle nebeneinander vergleichen", description: "Stellen Sie eine Frage einmal und vergleichen Sie Antworten f?hrender Modelle in einem fokussierten Arbeitsbereich." }, { title: "Mit Dateien und Kontext arbeiten", description: "H?ngen Sie Bilder, PDFs, Office-Dokumente und Google-Drive-Dateien an, wenn die Aufgabe echtes Material ben?tigt." }, { title: "Unterhaltungen sauber teilen", description: "Machen Sie n?tzliche Chats zu schreibgesch?tzten ?ffentlichen Seiten oder laden Sie sie als klare Textaufzeichnungen herunter." }, { title: "F?r datenschutzbewusste Arbeit gebaut", description: "Nutzen Sie gesperrte Chats, Private Mode, Nutzungslimits und geh?rtete Sicherheitskontrollen." }],
    useCasesTitle: "F?r echte t?gliche Arbeit gebaut.",
    useCasesDescription: "Tomverse hilft, wenn eine Aufgabe mehrere Perspektiven, echte Dateien und wiederverwendbare Ergebnisse braucht.",
    useCases: [{ title: "Recherche und Zusammenfassungen", description: "Vergleichen Sie kurze Zusammenfassungen, tiefere Analysen und Ideen f?r Folgefragen." }, { title: "Programmieren und Debugging", description: "Fragen Sie mehrere Modelle nach Korrekturen, Abw?gungen, Tests und Alternativen." }, { title: "Gesch?ftliches Schreiben", description: "Entwerfen Sie E-Mails, Angebote, Produkttexte und Planungsnotizen in mehreren Stilen." }, { title: "Dateibasierte Analyse", description: "Bringen Sie Screenshots, PDFs, Office-Dateien und Drive-Kontext in die Unterhaltung." }],
    whyTitle: "Warum Tomverse statt mehrere KI-Apps zu ?ffnen?",
    whyDescription: "Tomverse h?lt Modellauswahl, Gespr?chskontext, Teilen und Datenschutzkontrollen in einem Ablauf.",
    whyItems: [{ title: "Eine Frage, mehrere Antworten", description: "Vergleichen Sie Modellst?rken, ohne Prompts ?ber mehrere Tabs zu kopieren." }, { title: "Dort nachfragen, wo es z?hlt", description: "Stellen Sie einem bestimmten Modell eine Folgefrage und behalten Sie den Vergleich im Blick." }, { title: "Ergebnisse mitnehmen", description: "Teilen Sie n?tzliche Unterhaltungen oder laden Sie klare Textaufzeichnungen herunter." }],
    trustTitle: "Vertrauenskontrollen von Anfang an.",
    trustDescription: "?ffentliche KI-Werkzeuge brauchen klare Grenzen. Tomverse macht Speicher-, Teilen- und Sperrverhalten sichtbar.",
    trustItems: [{ title: "Private Mode klar erkl?rt", description: "Private Mode speichert keinen Tomverse-Chatverlauf, w?hrend Prompts weiterhin an ausgew?hlte KI-Anbieter gesendet werden k?nnen." }, { title: "Schreibgesch?tzte Teilen-Snapshots", description: "Geteilte Links sind ?ffentliche schreibgesch?tzte Ansichten, die sp?tere Gespr?chs?nderungen nicht offenlegen." }, { title: "Gesperrte Unterhaltungen", description: "Sensible Chats k?nnen gesperrt werden und erfordern vor gesch?tzten Aktionen eine Entsperrpr?fung." }, { title: "Schutz f?r Anh?nge", description: "Dateien werden validiert, begrenzt und mit kontrollierter tempor?rer Speicherung verarbeitet." }],
    modelsTitle: "F?r den schnell wechselnden Modellmarkt gebaut.",
    modelsDescription: "Neue Modelle erscheinen st?ndig. Tomverse zentralisiert die Modellauswahl, damit Nutzer passende Optionen vergleichen k?nnen, ohne ihren Workflow umzubauen.",
    pricingTitle: "Kostenlos starten, upgraden wenn die Nutzung w?chst.",
    pricingDescription: "Pl?ne richten sich nach Nutzungskontingent, Datei-Workflows, Teilen und Zugriff auf den verf?gbaren Modellkatalog.",
    pricingPlans: [{ title: "Free", price: "$0", description: "Zum Ausprobieren von Tomverse und f?r leichte t?gliche Arbeit.", bullets: ["Free- und Pro-Modellstufen","Begrenzte t?gliche Nutzung","Dateien, Teilen und Downloads nach Anmeldung"] }, { title: "Pro", price: "$19/Monat", description: "F?r t?glichen Multi-Modell-Vergleich.", bullets: ["TOMVERSE50: 50 % Rabatt f?r 3 Monate","Alle verf?gbaren Modelle","Dateien, Teilen, Downloads"] }, { title: "Max", price: "$35/Monat", description: "F?r intensivere KI-Workflows.", bullets: ["TOMVERSE50: 50 % Rabatt f?r 3 Monate","Kein t?gliches Nachrichtenlimit","Monatlicher Fair-Use-Schutz"] }],
    faqTitle: "Kurze Fragen",
    faqs: [{ question: "Kann ich Tomverse kostenlos nutzen?", answer: "Ja. Free ist f?r leichte Nutzung mit Zugriff auf Free- und Pro-Modellstufen innerhalb der Limits gedacht." }, { question: "Welche Modelle werden unterst?tzt?", answer: "Tomverse unterst?tzt Modelle von OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity und weiteren Anbietern." }, { question: "Was ist Private Mode?", answer: "Private Mode bedeutet, dass Tomverse die Unterhaltung nicht in der Tomverse-Datenbank speichert. KI-Anbieter k?nnen Prompts weiterhin zur Antworterzeugung erhalten." }, { question: "Kann ich Dateien anh?ngen?", answer: "Ja. Tomverse unterst?tzt Bilder, PDFs, Office-Dokumente, Google-Drive-Dateien und weitere erlaubte Anh?nge je nach Anbieter." }],
    ctaTitle: "Bereit, smarter zu vergleichen?",
    ctaDescription: "Starten Sie mit dem kostenlosen Arbeitsbereich und upgraden Sie, wenn Sie mehr Leistung brauchen.",
  },
  es: {
    app: "Abrir app",
    badge: "Espacio de IA multimodelo",
    title: "Compara las mejores respuestas de IA en un solo lugar.",
    description: "Tomverse AI te ayuda a preguntar una vez, comparar varios modelos, adjuntar archivos reales y organizar conversaciones ?tiles para trabajar mejor.",
    primaryCta: "Empezar gratis",
    pricingCta: "Ver precios",
    steps: ["Elige hasta tres modelos","Env?a una pregunta o adjunta archivos","Compara, pregunta de nuevo, comparte o exporta"],
    previewTitle: "Comparaci?n Tomverse",
    previewCount: "3 modelos",
    previewAnswers: ["Respuesta directa con pr?ximos pasos pr?cticos.","Razonamiento cuidadoso con alternativas.","Resumen r?pido, breve y estructurado."],
    featuresTitle: "Una forma m?s tranquila de usar muchas IA.",
    featuresDescription: "Dise?ado para trabajo repetido, no para demos aisladas. Mant?n modelos, archivos, sesiones privadas y resultados compartibles en un solo flujo.",
    features: [{ title: "Compara modelos de IA lado a lado", description: "Pregunta una vez y compara respuestas de varios modelos l?deres en un espacio enfocado." }, { title: "Trabaja con archivos y contexto", description: "Adjunta im?genes, PDF, documentos Office y archivos de Google Drive cuando la tarea requiere material real." }, { title: "Comparte conversaciones pulidas", description: "Convierte chats ?tiles en p?ginas p?blicas de solo lectura o desc?rgalos como registros de texto limpios." }, { title: "Creado para trabajo con privacidad", description: "Usa chats bloqueados, Private Mode, l?mites de uso y controles de seguridad reforzados." }],
    useCasesTitle: "Creado para trabajo diario real.",
    useCasesDescription: "Usa Tomverse cuando la tarea se beneficia de varias perspectivas, archivos reales y un registro reutilizable.",
    useCases: [{ title: "Investigaci?n y res?menes", description: "Compara res?menes breves, an?lisis m?s profundos e ideas para preguntas de seguimiento." }, { title: "Programaci?n y depuraci?n", description: "Pide a varios modelos correcciones, alternativas, pruebas y tradeoffs." }, { title: "Redacci?n de negocios", description: "Redacta emails, propuestas, textos de producto y notas de planificaci?n con varios estilos." }, { title: "An?lisis basado en archivos", description: "Incluye capturas, PDF, archivos Office y contexto de Drive en la conversaci?n." }],
    whyTitle: "?Por qu? usar Tomverse en vez de abrir cada app de IA?",
    whyDescription: "Tomverse mantiene elecci?n de modelo, contexto, compartici?n y privacidad en un solo flujo.",
    whyItems: [{ title: "Una pregunta, varias respuestas", description: "Compara fortalezas de modelos sin copiar prompts entre pesta?as." }, { title: "Contin?a con el modelo adecuado", description: "Haz una pregunta de seguimiento a un modelo espec?fico mientras mantienes la comparaci?n cerca." }, { title: "Resultados portables", description: "Comparte conversaciones ?tiles o descarga registros de texto limpios para usarlos despu?s." }],
    trustTitle: "Controles de confianza desde el primer d?a.",
    trustDescription: "Las herramientas p?blicas de IA necesitan l?mites claros. Tomverse muestra el comportamiento de guardado, compartici?n y bloqueo.",
    trustItems: [{ title: "Claridad de Private Mode", description: "Private Mode no guarda historial en Tomverse, aunque los prompts pueden enviarse a los proveedores de IA seleccionados." }, { title: "Snapshots compartidos de solo lectura", description: "Los enlaces compartidos son vistas p?blicas de solo lectura que no exponen actualizaciones posteriores." }, { title: "Conversaciones bloqueadas", description: "Los chats sensibles pueden bloquearse y requerir verificaci?n antes de acciones protegidas." }, { title: "Protecci?n de adjuntos", description: "Los archivos se validan, limitan y procesan con almacenamiento temporal controlado." }],
    modelsTitle: "Dise?ado para el mercado cambiante de modelos.",
    modelsDescription: "Aparecen modelos nuevos constantemente. Tomverse centraliza la elecci?n para comparar opciones adecuadas sin rehacer el flujo de trabajo.",
    pricingTitle: "Empieza gratis y actualiza cuando crezca el uso.",
    pricingDescription: "Los planes se basan en l?mites de uso, flujos con archivos, compartici?n y acceso al cat?logo de modelos.",
    pricingPlans: [{ title: "Free", price: "$0", description: "Para probar Tomverse y trabajo diario ligero.", bullets: ["Niveles Free y Pro","Trabajo diario con l?mite de uso","Archivos, compartir y descargas tras iniciar sesi?n"] }, { title: "Pro", price: "$19/mes", description: "Para comparaci?n multimodelo diaria.", bullets: ["TOMVERSE50: 50 % de descuento por 3 meses","Todos los modelos disponibles","Archivos, compartir, descargas"] }, { title: "Max", price: "$35/mes", description: "Para flujos de IA m?s intensivos.", bullets: ["TOMVERSE50: 50 % de descuento por 3 meses","Sin l?mite diario de mensajes","Protecci?n mensual fair-use"] }],
    faqTitle: "Preguntas r?pidas",
    faqs: [{ question: "?Puedo usar Tomverse gratis?", answer: "S?. Free est? pensado para uso ligero con acceso a niveles Free y Pro dentro de los l?mites." }, { question: "?Qu? modelos se admiten?", answer: "Tomverse admite modelos de OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity y otros proveedores." }, { question: "?Qu? es Private Mode?", answer: "Private Mode significa que Tomverse no guarda la conversaci?n en su base de datos. Los proveedores de IA a?n pueden recibir prompts para generar respuestas." }, { question: "?Puedo adjuntar archivos?", answer: "S?. Tomverse admite im?genes, PDF, documentos Office, archivos de Google Drive y otros tipos permitidos seg?n el proveedor." }],
    ctaTitle: "?Listo para comparar mejor?",
    ctaDescription: "Empieza con el espacio gratuito y actualiza cuando necesites m?s potencia.",
  },
  pt: {
    app: "Abrir app",
    badge: "Workspace de IA multimodelo",
    title: "Compare as melhores respostas de IA em um s? lugar.",
    description: "O Tomverse AI ajuda voc? a perguntar uma vez, comparar v?rios modelos, anexar arquivos reais e organizar conversas ?teis para o trabalho.",
    primaryCta: "Come?ar gr?tis",
    pricingCta: "Ver pre?os",
    steps: ["Escolha at? tr?s modelos","Envie uma pergunta ou anexe arquivos","Compare, continue, compartilhe ou exporte"],
    previewTitle: "Compara??o Tomverse",
    previewCount: "3 modelos",
    previewAnswers: ["Resposta direta com pr?ximos passos pr?ticos.","Racioc?nio cuidadoso com alternativas.","Resumo r?pido, conciso e estruturado."],
    featuresTitle: "Uma forma mais tranquila de usar v?rias IAs.",
    featuresDescription: "Criado para trabalho recorrente, n?o apenas demonstra??es. Mantenha modelos, arquivos, sess?es privadas e resultados compartilh?veis em um ?nico fluxo.",
    features: [{ title: "Compare modelos de IA lado a lado", description: "Pergunte uma vez e compare respostas de v?rios modelos l?deres em um workspace focado." }, { title: "Trabalhe com arquivos e contexto", description: "Anexe imagens, PDFs, documentos Office e arquivos do Google Drive quando a tarefa exigir material real." }, { title: "Compartilhe conversas bem formatadas", description: "Transforme chats ?teis em p?ginas p?blicas somente leitura ou baixe registros de texto limpos." }, { title: "Criado para trabalho com privacidade", description: "Use chats bloqueados, Private Mode, limites de uso e controles de seguran?a refor?ados." }],
    useCasesTitle: "Criado para trabalho di?rio real.",
    useCasesDescription: "Use o Tomverse quando a tarefa se beneficia de v?rias perspectivas, arquivos reais e um registro reutiliz?vel.",
    useCases: [{ title: "Pesquisa e resumos", description: "Compare resumos curtos, an?lises mais profundas e ideias de acompanhamento." }, { title: "C?digo e depura??o", description: "Pe?a corre??es, alternativas, testes e tradeoffs a v?rios modelos." }, { title: "Reda??o de neg?cios", description: "Crie emails, propostas, textos de produto e notas de planejamento com v?rios estilos." }, { title: "An?lise baseada em arquivos", description: "Inclua capturas, PDFs, arquivos Office e contexto do Drive na conversa." }],
    whyTitle: "Por que usar o Tomverse em vez de abrir cada app de IA?",
    whyDescription: "O Tomverse mant?m escolha de modelo, contexto, compartilhamento e privacidade em um ?nico fluxo.",
    whyItems: [{ title: "Uma pergunta, v?rias respostas", description: "Compare os pontos fortes dos modelos sem copiar prompts entre abas." }, { title: "Continue com o modelo certo", description: "Fa?a uma pergunta de acompanhamento a um modelo espec?fico mantendo a compara??o por perto." }, { title: "Resultados port?teis", description: "Compartilhe conversas ?teis ou baixe registros de texto limpos para usar depois." }],
    trustTitle: "Controles de confian?a desde o in?cio.",
    trustDescription: "Ferramentas p?blicas de IA precisam de limites claros. O Tomverse mostra como salvar, compartilhar e bloquear funcionam.",
    trustItems: [{ title: "Clareza do Private Mode", description: "Private Mode n?o salva o hist?rico no Tomverse, mas prompts ainda podem ser enviados aos provedores de IA selecionados." }, { title: "Snapshots compartilhados somente leitura", description: "Links compartilhados s?o visualiza??es p?blicas somente leitura que n?o exp?em atualiza??es posteriores." }, { title: "Conversas bloqueadas", description: "Chats sens?veis podem ser bloqueados e exigir verifica??o antes de a??es protegidas." }, { title: "Prote??o de anexos", description: "Arquivos s?o validados, limitados e processados com armazenamento tempor?rio controlado." }],
    modelsTitle: "Criado para o mercado de modelos em constante mudan?a.",
    modelsDescription: "Novos modelos surgem o tempo todo. O Tomverse centraliza a escolha para comparar op??es certas sem refazer o fluxo de trabalho.",
    pricingTitle: "Comece gr?tis e fa?a upgrade quando o uso crescer.",
    pricingDescription: "Os planos s?o baseados em limites de uso, fluxos com arquivos, compartilhamento e acesso ao cat?logo de modelos.",
    pricingPlans: [{ title: "Free", price: "$0", description: "Para testar o Tomverse e uso di?rio leve.", bullets: ["N?veis Free e Pro","Uso di?rio com limite","Arquivos, compartilhamento e downloads ap?s login"] }, { title: "Pro", price: "US$19/m?s", description: "Para compara??o multimodelo di?ria.", bullets: ["TOMVERSE50: 50% de desconto por 3 meses","Todos os modelos dispon?veis","Arquivos, compartilhamento, downloads"] }, { title: "Max", price: "US$35/m?s", description: "Para fluxos de IA mais intensos.", bullets: ["TOMVERSE50: 50% de desconto por 3 meses","Sem limite di?rio de mensagens","Prote??o mensal fair-use"] }],
    faqTitle: "Perguntas r?pidas",
    faqs: [{ question: "Posso usar o Tomverse gr?tis?", answer: "Sim. O Free ? pensado para uso leve com acesso aos n?veis Free e Pro dentro dos limites." }, { question: "Quais modelos s?o compat?veis?", answer: "O Tomverse oferece modelos de OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Moonshot, Qwen, Perplexity e outros provedores." }, { question: "O que ? Private Mode?", answer: "Private Mode significa que o Tomverse n?o salva a conversa no banco de dados. Provedores de IA ainda podem receber prompts para gerar respostas." }, { question: "Posso anexar arquivos?", answer: "Sim. O Tomverse aceita imagens, PDFs, documentos Office, arquivos do Google Drive e outros tipos permitidos conforme o provedor." }],
    ctaTitle: "Pronto para comparar melhor?",
    ctaDescription: "Comece com o workspace gratuito e fa?a upgrade quando precisar de mais pot?ncia.",
  }
};

const launchCopy: { en: LaunchCopy } & Partial<Record<Language, LaunchCopy>> = {
  en: {
    eyebrow: "AI workspace for daily work",
    title: "More than a model picker.",
    description:
      "Tomverse brings the controls, organization, sharing, and support context users need to rely on one AI workspace every day.",
    items: [
      { title: "Project organization", description: "Group chats into projects, rename them, and keep growing workspaces easier to scan." },
      { title: "Plan and usage clarity", description: "Users can see current plan, daily and monthly usage, remaining limits, and why a feature is locked." },
      { title: "Provider status awareness", description: "When a model provider is limited, Tomverse shows status and suggests nearby alternatives." },
      { title: "File workflows", description: "Images, PDFs, Office files, text files, and Google Drive imports are supported with validation and guidance." },
      { title: "Support context", description: "Feedback can include trace ID, model, plan, browser, and attachment context for faster support." },
      { title: "Public share documents", description: "Shared conversations are read-only snapshots with model filters, copy actions, expiry, and app CTA." },
    ],
  },
  ko: {
    eyebrow: "?? ??? ?? AI ??????",
    title: "??? ?? ???? ????.",
    description: "Tomverse? ???? ?? ??? AI ??????? ??? ? ??? ??? ??, ?? ??, ??, ?? ??, ?? ?? ??? ? ?? ?? ?????.",
    items: [{ title: "???? ??", description: "??? ?????? ??, ?? ??? ??? ?? ??? ??????? ? ?? ?????." }, { title: "??? ??? ??", description: "?? ??, ??/?? ???, ?? ??, ?? ?? ??? ????? ??? ?????." }, { title: "Provider ?? ??", description: "?? ???? ????? ??? ?? ? ??? ?? ??? ?? ?????." }, { title: "?? ?? ??", description: "???, PDF, Office, ???, Google Drive ??? ??? ?? ?? ??? ??? ? ????." }, { title: "?? ??? ??? ???", description: "???? ?? ID, ??, ??, ????, ?? ??? ???? ?? ??? ?????." }, { title: "?? ?? ??", description: "?? ??? ?? ?? ????? ???? ?? ??, ??, ???, ? ?? CTA? ?????." }],
  },
  zh: {
    eyebrow: "????? AI ???",
    title: "?????????",
    description: "Tomverse ????????????????????????????????????????????? AI ????",
    items: [{ title: "????", description: "???????????????????????" }, { title: "?????????", description: "??????????????????????????????????" }, { title: "Provider ????", description: "???????????????Tomverse ???????????????" }, { title: "?????", description: "?????PDF?Office???? Google Drive ????????????" }, { title: "?????????", description: "??????? ID???????????????????????" }, { title: "??????", description: "???????????????????????????????? CTA?" }],
  },
  fr: {
    eyebrow: "Espace IA pour le travail quotidien",
    title: "Bien plus qu?un s?lecteur de mod?les.",
    description: "Tomverse r?unit contr?les, organisation, partage et contexte de support pour qu?un seul espace IA puisse servir au quotidien.",
    items: [{ title: "Organisation par projets", description: "Regroupez les chats en projets, renommez-les et gardez les grands espaces plus lisibles." }, { title: "Clart? du plan et de l?usage", description: "Les utilisateurs voient le plan actuel, l?usage quotidien et mensuel, les limites restantes et pourquoi une fonction est verrouill?e." }, { title: "?tat des fournisseurs", description: "Quand un fournisseur est limit?, Tomverse affiche l??tat et sugg?re des alternatives proches." }, { title: "Flux avec fichiers", description: "Images, PDF, fichiers Office, texte et imports Google Drive sont pris en charge avec validation et conseils." }, { title: "Contexte de support", description: "Les retours peuvent inclure trace ID, mod?le, plan, navigateur et contexte des pi?ces jointes." }, { title: "Documents partag?s publics", description: "Les conversations partag?es sont des snapshots en lecture seule avec filtres de mod?le, copie, expiration et CTA vers l?app." }],
  },
  de: {
    eyebrow: "KI-Arbeitsbereich f?r den Alltag",
    title: "Mehr als ein Modellw?hler.",
    description: "Tomverse vereint Kontrollen, Organisation, Teilen und Support-Kontext, damit Nutzer t?glich auf einen KI-Arbeitsbereich vertrauen k?nnen.",
    items: [{ title: "Projektorganisation", description: "Gruppieren Sie Chats in Projekte, benennen Sie sie um und halten Sie wachsende Arbeitsbereiche ?bersichtlich." }, { title: "Klarheit zu Plan und Nutzung", description: "Nutzer sehen aktuellen Plan, t?gliche und monatliche Nutzung, verbleibende Limits und warum eine Funktion gesperrt ist." }, { title: "Anbieterstatus im Blick", description: "Wenn ein Modellanbieter eingeschr?nkt ist, zeigt Tomverse den Status und schl?gt passende Alternativen vor." }, { title: "Datei-Workflows", description: "Bilder, PDFs, Office-Dateien, Textdateien und Google-Drive-Importe werden mit Validierung und Anleitung unterst?tzt." }, { title: "Support-Kontext", description: "Feedback kann Trace-ID, Modell, Plan, Browser und Anhangskontext enthalten." }, { title: "?ffentliche Teilen-Dokumente", description: "Geteilte Unterhaltungen sind schreibgesch?tzte Snapshots mit Modellfiltern, Kopieraktionen, Ablaufdatum und App-CTA." }],
  },
  es: {
    eyebrow: "Espacio de IA para el trabajo diario",
    title: "M?s que un selector de modelos.",
    description: "Tomverse re?ne controles, organizaci?n, compartici?n y contexto de soporte para que los usuarios dependan de un solo espacio de IA cada d?a.",
    items: [{ title: "Organizaci?n por proyectos", description: "Agrupa chats en proyectos, c?mbiales el nombre y mant?n espacios grandes m?s f?ciles de revisar." }, { title: "Claridad de plan y uso", description: "Los usuarios ven su plan actual, uso diario y mensual, l?mites restantes y por qu? una funci?n est? bloqueada." }, { title: "Estado de proveedores", description: "Cuando un proveedor est? limitado, Tomverse muestra el estado y sugiere alternativas cercanas." }, { title: "Flujos con archivos", description: "Se admiten im?genes, PDF, archivos Office, texto e importaciones de Google Drive con validaci?n y gu?a." }, { title: "Contexto de soporte", description: "El feedback puede incluir trace ID, modelo, plan, navegador y contexto de adjuntos." }, { title: "Documentos p?blicos compartidos", description: "Las conversaciones compartidas son snapshots de solo lectura con filtros de modelo, copia, caducidad y CTA hacia la app." }],
  },
  pt: {
    eyebrow: "Workspace de IA para o trabalho di?rio",
    title: "Mais do que um seletor de modelos.",
    description: "O Tomverse re?ne controles, organiza??o, compartilhamento e contexto de suporte para que usu?rios dependam de um ?nico workspace de IA todos os dias.",
    items: [{ title: "Organiza??o por projetos", description: "Agrupe chats em projetos, renomeie-os e mantenha espa?os grandes mais f?ceis de examinar." }, { title: "Clareza de plano e uso", description: "Usu?rios veem o plano atual, uso di?rio e mensal, limites restantes e por que um recurso est? bloqueado." }, { title: "Status dos provedores", description: "Quando um provedor est? limitado, o Tomverse mostra o status e sugere alternativas pr?ximas." }, { title: "Fluxos com arquivos", description: "Imagens, PDFs, arquivos Office, texto e importa??es do Google Drive s?o suportados com valida??o e orienta??o." }, { title: "Contexto de suporte", description: "Feedback pode incluir trace ID, modelo, plano, navegador e contexto de anexos." }, { title: "Documentos p?blicos compartilhados", description: "Conversas compartilhadas s?o snapshots somente leitura com filtros de modelo, c?pia, expira??o e CTA para abrir o app." }],
  }
};

const featureIcons = [Layers3, FileText, Share2, LockKeyhole];
const useCaseIcons = [Search, Code2, BriefcaseBusiness, FileText];
const trustIcons = [ShieldCheck, Share2, LockKeyhole, FileText];
const launchIcons = [FolderKanban, BarChart3, ServerCog, UploadCloud, HeartHandshake, Share2];

const CardGrid = ({
  items,
  icons,
}: {
  items: CardCopy[];
  icons: Array<typeof Layers3>;
}) => (
  <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
    {items.map((item, index) => {
      const Icon = icons[index] ?? Layers3;
      return (
        <article key={item.title} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h3 className="mt-4 text-base font-black">{item.title}</h3>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.description}</p>
        </article>
      );
    })}
  </div>
);

export function LandingPageContent() {
  const { lang } = useLanguage();
  const content = copy[lang] ?? copy.en;
  const launch = launchCopy[lang] ?? launchCopy.en;

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="relative">
        <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <Sparkles className="h-3.5 w-3.5" />
              {content.badge}
            </div>
            <h1 className="mt-6 max-w-4xl text-5xl font-black leading-[1.04] text-zinc-950 dark:text-white sm:text-6xl lg:text-7xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/chat"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-black text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500"
              >
                {content.primaryCta}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-zinc-300 px-6 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {content.pricingCta}
              </Link>
            </div>
            <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-3">
              {content.steps.map((step, index) => (
                <div key={step} className="flex items-center gap-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-black text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                    {index + 1}
                  </span>
                  {step}
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-3xl border border-zinc-200 bg-zinc-950 p-2 shadow-2xl shadow-zinc-300/60 dark:border-zinc-800 dark:shadow-black/50 md:rounded-[2rem] md:p-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 md:rounded-[1.5rem]">
                <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5 md:px-4 md:py-3">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-blue-400" />
                    <span className="text-xs font-bold text-zinc-300">{content.previewTitle}</span>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-black text-emerald-300">
                    {content.previewCount}
                  </span>
                </div>
                <div className="grid gap-2 p-3 md:grid-cols-3 md:gap-3 md:p-4">
                  {["GPT", "Claude", "Gemini"].map((model, index) => (
                    <div key={model} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 md:min-h-72 md:p-4">
                      <div className="mb-3 flex items-center justify-between md:mb-5">
                        <span className="text-sm font-black text-white">{model}</span>
                        <span className="h-2 w-2 rounded-full bg-blue-400" />
                      </div>
                      <div className="space-y-2 md:space-y-3">
                        <div className="h-2.5 w-3/4 rounded-full bg-zinc-700 md:h-3" />
                        <div className="h-2.5 w-full rounded-full bg-zinc-800 md:h-3" />
                        <div className="hidden h-3 w-5/6 rounded-full bg-zinc-800 md:block" />
                        <div className="mt-3 rounded-xl bg-blue-600 p-2.5 text-xs font-bold leading-5 text-white md:mt-5 md:p-3">
                          {content.previewAnswers[index]}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.featuresTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.featuresDescription}</p>
          </div>
          <CardGrid items={content.features} icons={featureIcons} />
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-black uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">
                {launch.eyebrow}
              </p>
              <h2 className="mt-3 text-3xl font-black sm:text-4xl">{launch.title}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{launch.description}</p>
            </div>
            <Link
              href="/support/help-centre"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300 px-4 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
            >
              Help Centre
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {launch.items.map((item, index) => {
              const Icon = launchIcons[index] ?? Layers3;
              return (
                <article
                  key={item.title}
                  className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-base font-black">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.useCasesTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.useCasesDescription}</p>
          </div>
          <CardGrid items={content.useCases} icons={useCaseIcons} />
        </div>
      </section>

      <section className="border-y border-zinc-200 bg-zinc-950 py-20 text-white dark:border-zinc-800">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <Workflow className="h-7 w-7 text-blue-400" />
            <h2 className="mt-5 text-3xl font-black sm:text-4xl">{content.whyTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-300">{content.whyDescription}</p>
          </div>
          <div className="grid gap-4">
            {content.whyItems.map((item) => (
              <article key={item.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
                <h3 className="font-black">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-300">{item.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black sm:text-4xl">{content.trustTitle}</h2>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.trustDescription}</p>
          </div>
          <CardGrid items={content.trustItems} icons={trustIcons} />
        </div>
      </section>

      <section id="models" className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <h2 className="text-3xl font-black sm:text-4xl">{content.modelsTitle}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.modelsDescription}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {supportedModels.map((model) => (
                <article
                  key={model.name}
                  className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${model.className} text-lg font-black text-white shadow-sm ring-1 ring-zinc-200/70 dark:ring-zinc-800`}>
                    {model.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={model.image} alt={`${model.name} logo`} className="h-8 w-8 object-contain" />
                    ) : (
                      model.mark
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-base font-black text-zinc-950 dark:text-white">{model.name}</span>
                    <span className="block truncate text-xs font-bold text-zinc-500 dark:text-zinc-400">{model.detail}</span>
                  </span>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-black sm:text-4xl">{content.pricingTitle}</h2>
              <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.pricingDescription}</p>
            </div>
            <Link href="/pricing" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white transition hover:bg-blue-500">
              {content.pricingCta}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {content.pricingPlans.map((plan, index) => (
              <article key={plan.title} className={`rounded-2xl border p-6 ${index === 1 ? "border-blue-500 bg-blue-600 text-white" : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40"}`}>
                <h3 className="text-2xl font-black">{plan.title}</h3>
                <p className={`mt-2 text-3xl font-black ${index === 1 ? "text-white" : "text-zinc-950 dark:text-white"}`}>{plan.price}</p>
                <p className={`mt-3 text-sm leading-6 ${index === 1 ? "text-blue-50" : "text-zinc-600 dark:text-zinc-300"}`}>{plan.description}</p>
                <ul className="mt-5 space-y-3">
                  {plan.bullets.map((bullet) => (
                    <li key={bullet} className={`flex gap-3 text-sm font-semibold ${index === 1 ? "text-white" : "text-zinc-700 dark:text-zinc-200"}`}>
                      <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${index === 1 ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/30">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.6fr_1.4fr] lg:px-8">
          <div>
            <HelpCircle className="h-7 w-7 text-blue-600 dark:text-blue-400" />
            <h2 className="mt-5 text-3xl font-black sm:text-4xl">{content.faqTitle}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {content.faqs.map((faq) => (
              <article key={faq.question} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                <h3 className="font-black">{faq.question}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-blue-600 py-16 text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-4 sm:px-6 md:flex-row md:items-center lg:px-8">
          <div>
            <h2 className="text-3xl font-black">{content.ctaTitle}</h2>
            <p className="mt-2 text-sm font-medium text-blue-100">{content.ctaDescription}</p>
          </div>
          <Link
            href="/chat"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-black text-blue-700 transition hover:bg-blue-50"
          >
            {content.app}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
}
