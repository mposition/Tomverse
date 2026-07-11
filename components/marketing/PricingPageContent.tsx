"use client";

import Link from "next/link";
import { CheckCircle2, Minus } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";

type PlanCopy = {
  name: string;
  eyebrow: string;
  price: string;
  period: string;
  description: string;
  cta: string;
  href: string;
  highlighted?: boolean;
  badge?: string;
  usage: string;
  features: string[];
};

type PricingCopy = {
  eyebrow: string;
  title: string;
  description: string;
  billingNote: string;
  compareTitle: string;
  compareDescription: string;
  table: {
    feature: string;
    free: string;
    pro: string;
    max: string;
    rows: Array<{ label: string; free: string; pro: string; max: string }>;
  };
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  note: string;
  plans: PlanCopy[];
};

const copy: { en: PricingCopy } & Partial<Record<Language, PricingCopy>> = {
  en: {
    eyebrow: "Pricing",
    title: "Choose the right level of AI power.",
    description:
      "Start free, then upgrade when you need more models, higher limits, file workflows, and premium model access.",
    billingNote: "Launch offer: use code TOMVERSE50 for 50% off Pro or Max for your first 3 months. Cancel anytime.",
    compareTitle: "Compare what each plan unlocks",
    compareDescription:
      "Tomverse plans are designed around model access, usage allowance, file workflows, and sharing controls.",
    table: {
      feature: "Feature",
      free: "무료",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Model access", free: "Free and Pro model tiers", pro: "All models with Pro usage limits", max: "All models with the largest allowance" },
        { label: "Multi-model comparison", free: "Up to 3 models", pro: "Up to 3 models", max: "Up to 3 models" },
        { label: "File attachments", free: "Images, PDFs, Office, Drive", pro: "Images, PDFs, Office, Drive", max: "Higher file and context limits" },
        { label: "Conversation sharing", free: "Share and download", pro: "Share and download", max: "Share, download, priority limits" },
        { label: "Usage allowance", free: "Free daily and monthly limits", pro: "Higher daily and monthly usage", max: "No daily message limit with monthly fair-use protection" },
      ],
    },
    faqTitle: "Pricing questions",
    faqs: [
      {
        question: "Can I keep using Tomverse for free?",
        answer: "Yes. The Free plan is intended for light daily use with access to Free and Pro model tiers within usage limits.",
      },
      {
        question: "How does the launch discount work?",
        answer: "Enter promo code TOMVERSE50 at checkout to receive 50% off Pro or Max for the first 3 months. After that, the plan renews at the regular monthly price unless canceled.",
      },
      {
        question: "Does Pro restrict which models I can choose?",
        answer: "Pro is intended to unlock the available model catalogue. Higher-cost models are managed through usage and cost limits rather than a simple model picker block.",
      },
    ],
    note:
      "\uAC00\uACA9\uC740 \uC138\uAE08 \uC804 USD \uAE30\uC900\uC785\uB2C8\uB2E4. Max\uB294 \uC77C\uC77C \uBA54\uC2DC\uC9C0 \uD55C\uB3C4\uB97C \uC5C6\uC560\uC9C0\uB9CC, \uC6D4\uAC04 fair-use, \uB0A8\uC6A9 \uBC29\uC9C0, Provider \uBE44\uC6A9 \uBCF4\uD638 \uD55C\uB3C4\uB294 \uC801\uC6A9\uB429\uB2C8\uB2E4.",
    plans: [
      {
        name: "Free",
        eyebrow: "For starting out",
        price: "$0",
        period: "per month",
        description: "A simple way to try Tomverse and use selected AI models for light daily work.",
        cta: "Start free",
        href: "/chat",
        usage: "Basic daily usage",
        features: [
          "Access to Free and Pro model tiers",
          "Compare up to 3 models",
          "Basic chat history",
          "File attachments, sharing, and downloads after login",
          "Good for light personal use",
        ],
      },
      {
        name: "Pro",
        eyebrow: "For everyday productivity",
        price: "$19",
        period: "per month",
        description: "For people who compare models, attach files, and reuse conversations throughout the week.",
        cta: "Upgrade to Pro",
        href: "/chat",
        highlighted: true,
        badge: "Recommended",
        usage: "Promo TOMVERSE50: $9.50/month for first 3 months",
        features: [
          "Access to all available model tiers",
          "Compare up to 3 models side by side",
          "File attachments and Google Drive files",
          "Share and download conversations",
          "Higher daily and monthly limits",
        ],
      },
      {
        name: "Max",
        eyebrow: "For heavier AI workflows",
        price: "$35",
        period: "per month",
        description: "For power users who need premium model tiers, larger allowances, and priority room to work.",
        cta: "Upgrade to Max",
        href: "/chat",
        usage: "Promo TOMVERSE50: $17.50/month for first 3 months",
        features: [
          "Access to Free, Pro, and Max model tiers",
          "No daily message limit with monthly fair-use protection",
          "Higher attachment and context limits",
          "Priority access to advanced model tiers",
          "Built for heavier daily AI workflows",
        ],
      },
    ],
  },
  ko: {
    eyebrow: "???",
    title: "??? ?? AI ??? ?????.",
    description: "??? ????, ? ?? ???? ?? ????, ???? ?? ??? ??? ? ????????.",
    billingNote: "?? ?? ??: TOMVERSE50 ??? Pro ?? Max ? 3?? 50% ??. ??? ??? ? ????.",
    compareTitle: "???? ?? ?? ??",
    compareDescription: "Tomverse ???? ?? ??, ???, ?? ????, ?? ??? ???? ???????.",
    table: {
      feature: "??",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "?? ??", free: "Free ? Pro ?? ??", pro: "?? ??, Pro ??? ??", max: "?? ??, ?? ??? ??" },
        { label: "?? ?? ??", free: "?? 3? ??", pro: "?? 3? ??", max: "?? 3? ??" },
        { label: "?? ??", free: "???, PDF, Office, Drive", pro: "???, PDF, Office, Drive", max: "? ?? ?? ? ???? ??" },
        { label: "?? ??", free: "?? ? ????", pro: "?? ? ????", max: "??, ????, ?? ??" },
        { label: "???", free: "Free ??/?? ??", pro: "? ?? ??/?? ???", max: "?? ??? ??? + ?? fair-use ??" },
      ],
    },
    faqTitle: "?? ?? ??",
    faqs: [
      { question: "??? ?? ??? ? ????", answer: "?. Free? ??? ?? ??? Free? Pro ?? ??? ??? ??? ? ??? ?????." },
      { question: "?? ??? ??? ??????", answer: "?? ? ???? ?? TOMVERSE50? ???? Pro ?? Max ? 3?? 50% ??? ?????. ???? ?? ?? ???? ?????." },
      { question: "Pro?? ?? ??? ??? ??????", answer: "Pro? ?? ??? ?? ???? ??? ???? ?????. ?? ??? ?? ?? ???? ???? ?? ??? ???? ?? Tomverse? ?? ??? ? ? ????." },
    ],
    note: "??? ?? ? USD ?????. Max? ?? ??? ??? ????, ?? fair-use, ?? ??, Provider ?? ?? ??? ?????.",
    plans: [
      { name: "Free", eyebrow: "?? ???? ???", price: "$0", period: "?", description: "Tomverse? ???? ??? AI ??? ??? ?? ??? ???? ?? ??????.", cta: "??? ??", href: "/chat", usage: "?? ?? ???", features: ["Free ? Pro ?? ?? ??", "?? 3? ?? ?? ??", "?? ?? ??", "??? ? ?? ??, ??, ????", "??? ?? ??? ??"] },
      { name: "Pro", eyebrow: "?? ???", price: "$19", period: "?", description: "?? ??? ????, ??? ????, ??? ???? ???? ????? ?????.", cta: "Pro? ?????", href: "/chat", highlighted: true, badge: "??", usage: "???? TOMVERSE50: ? 3?? ? $9.50", features: ["?? ??? ?? ?? ?? ??", "?? 3? ?? ?? ??", "?? ?? ? Google Drive ??", "?? ?? ? ????", "? ?? ??/?? ???"] },
      { name: "Max", eyebrow: "??? AI ????", price: "$35", period: "?", description: "???? ?? ??, ? ? ???, ? ???? ?? ??? ??? ?? ??????.", cta: "Max? ?????", href: "/chat", usage: "???? TOMVERSE50: ? 3?? ? $17.50", features: ["Free, Pro, Max ?? ?? ?? ??", "?? ??? ??? + ?? fair-use ??", "? ?? ???? ? ???? ??", "?? ?? ?? ?? ??", "??? ?? AI ????? ??"] },
    ],
  },
  zh: {
    eyebrow: "??",
    title: "?????? AI ?????",
    description: "????????????????????????????????",
    billingNote: "??????? TOMVERSE50?Pro ? Max ? 3 ??? 50% ?????????",
    compareTitle: "???????????",
    compareDescription: "Tomverse ????????????????????????????",
    table: {
      feature: "??",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "????", free: "Free ? Pro ????", pro: "?????Pro ????", max: "???????????" },
        { label: "?????", free: "?? 3 ???", pro: "?? 3 ???", max: "?? 3 ???" },
        { label: "????", free: "???PDF?Office?Drive", pro: "???PDF?Office?Drive", max: "??????????" },
        { label: "????", free: "?????", pro: "?????", max: "??????????" },
        { label: "????", free: "Free ???????", pro: "?????????", max: "????????????? fair-use ??" },
      ],
    },
    faqTitle: "????",
    faqs: [
      { question: "????????? Tomverse ??", answer: "???Free ?????????????????? Free ? Pro ???????" },
      { question: "?????????", answer: "????????? TOMVERSE50?Pro ? Max ? 3 ???? 50% ???????????????????" },
      { question: "Pro ????????????", answer: "Pro ?????????????????????????????????????????????" },
    ],
    note: "????????Max ??????????????? fair-use????? Provider ???????",
    plans: [
      { name: "Free", eyebrow: "??????", price: "$0", period: "??", description: "??????????? Tomverse ??????? AI ???", cta: "????", href: "/chat", usage: "??????", features: ["?? Free ? Pro ????", "???? 3 ???", "??????", "????????????????", "????????"] },
      { name: "Pro", eyebrow: "?????", price: "$19", period: "??", description: "??????????????????????", cta: "??? Pro", href: "/chat", highlighted: true, badge: "??", usage: "?? TOMVERSE50?? 3 ???? $9.50", features: ["??????????", "?????? 3 ???", "????? Google Drive ??", "???????", "?????????"] },
      { name: "Max", eyebrow: "??? AI ???", price: "$35", period: "??", description: "????????????????????????????", cta: "??? Max", href: "/chat", usage: "?? TOMVERSE50?? 3 ???? $17.50", features: ["?? Free?Pro ? Max ??????", "????????????? fair-use ??", "??????????", "??????????", "??????? AI ???"] },
    ],
  },
  fr: {
    eyebrow: "Tarifs",
    title: "Choisissez le bon niveau de puissance IA.",
    description: "Commencez gratuitement, puis passez ? un plan sup?rieur lorsque vous avez besoin de plus de volume, de fichiers et de mod?les avanc?s.",
    billingNote: "Offre de lancement : utilisez TOMVERSE50 pour obtenir -50 % sur Pro ou Max pendant vos 3 premiers mois. Annulation possible ? tout moment.",
    compareTitle: "Comparez ce que chaque plan d?bloque",
    compareDescription: "Les plans Tomverse sont con?us autour de l?acc?s aux mod?les, des quotas, des fichiers et du partage.",
    table: {
      feature: "Fonctionnalit?",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Acc?s aux mod?les", free: "Niveaux Free et Pro", pro: "Tous les mod?les avec limites Pro", max: "Tous les mod?les avec la plus grande enveloppe" },
        { label: "Comparaison multi-mod?les", free: "Jusqu?? 3 mod?les", pro: "Jusqu?? 3 mod?les", max: "Jusqu?? 3 mod?les" },
        { label: "Pi?ces jointes", free: "Images, PDF, Office, Drive", pro: "Images, PDF, Office, Drive", max: "Limites de fichiers et de contexte plus ?lev?es" },
        { label: "Partage de conversations", free: "Partage et t?l?chargement", pro: "Partage et t?l?chargement", max: "Partage, t?l?chargement, limites prioritaires" },
        { label: "Quota d?usage", free: "Limites Free quotidiennes et mensuelles", pro: "Usage quotidien et mensuel plus ?lev?", max: "Aucune limite quotidienne de messages avec protection mensuelle fair-use" },
      ],
    },
    faqTitle: "Questions sur les tarifs",
    faqs: [
      { question: "Puis-je continuer ? utiliser Tomverse gratuitement ?", answer: "Oui. Le plan Free est pr?vu pour un usage quotidien l?ger avec acc?s aux niveaux de mod?les Free et Pro dans les limites d?utilisation." },
      { question: "Comment fonctionne la r?duction de lancement ?", answer: "Saisissez le code TOMVERSE50 au paiement pour obtenir -50 % sur Pro ou Max pendant les 3 premiers mois. Ensuite, le plan se renouvelle au prix mensuel standard, sauf annulation." },
      { question: "Pro limite-t-il les mod?les que je peux choisir ?", answer: "Pro vise ? ouvrir le catalogue de mod?les disponible. Les mod?les plus co?teux sont g?r?s par des limites d?usage et de co?t plut?t que par un blocage simple dans le s?lecteur." },
    ],
    note: "Les prix sont en USD hors taxes. Max supprime la limite quotidienne de messages, mais les protections mensuelles fair-use, anti-abus et de co?ts Provider s?appliquent.",
    plans: [
      { name: "Free", eyebrow: "Pour commencer", price: "$0", period: "par mois", description: "Une fa?on simple d?essayer Tomverse et d?utiliser certains mod?les IA pour un travail quotidien l?ger.", cta: "Commencer gratuitement", href: "/chat", usage: "Usage quotidien de base", features: ["Acc?s aux niveaux de mod?les Free et Pro", "Comparer jusqu?? 3 mod?les", "Historique de conversation de base", "Pi?ces jointes, partage et t?l?chargements apr?s connexion", "Adapt? ? un usage personnel l?ger"] },
      { name: "Pro", eyebrow: "Productivit? quotidienne", price: "$19", period: "par mois", description: "Pour les personnes qui comparent des mod?les, joignent des fichiers et r?utilisent leurs conversations chaque semaine.", cta: "Passer ? Pro", href: "/chat", highlighted: true, badge: "Recommand?", usage: "Promo TOMVERSE50 : 9,50 $/mois pendant 3 mois", features: ["Acc?s ? tous les niveaux de mod?les disponibles", "Comparer jusqu?? 3 mod?les c?te ? c?te", "Pi?ces jointes et fichiers Google Drive", "Partager et t?l?charger les conversations", "Limites quotidiennes et mensuelles plus ?lev?es"] },
      { name: "Max", eyebrow: "Workflows IA intensifs", price: "$35", period: "par mois", description: "Pour les utilisateurs intensifs qui ont besoin de mod?les avanc?s, de volumes plus importants et d?une marge prioritaire.", cta: "Passer ? Max", href: "/chat", usage: "Promo TOMVERSE50 : 17,50 $/mois pendant 3 mois", features: ["Acc?s aux niveaux Free, Pro et Max", "Aucune limite quotidienne de messages avec protection mensuelle fair-use", "Limites de pi?ces jointes et de contexte plus ?lev?es", "Acc?s prioritaire aux mod?les avanc?s", "Con?u pour les workflows IA quotidiens intensifs"] },
    ],
  },
  de: {
    eyebrow: "Preise",
    title: "W?hlen Sie die passende KI-Leistung.",
    description: "Starten Sie kostenlos und upgraden Sie, wenn Sie mehr Nutzung, Datei-Workflows und Premium-Modelle ben?tigen.",
    billingNote: "Launch-Angebot: Mit TOMVERSE50 erhalten Sie 50 % Rabatt auf Pro oder Max in den ersten 3 Monaten. Jederzeit k?ndbar.",
    compareTitle: "Vergleichen Sie, was jeder Plan freischaltet",
    compareDescription: "Tomverse-Pl?ne sind rund um Modellzugriff, Nutzungslimits, Datei-Workflows und Teilen-Funktionen aufgebaut.",
    table: {
      feature: "Funktion",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Modellzugriff", free: "Free- und Pro-Modellstufen", pro: "Alle Modelle mit Pro-Limits", max: "Alle Modelle mit dem gr??ten Kontingent" },
        { label: "Multi-Modell-Vergleich", free: "Bis zu 3 Modelle", pro: "Bis zu 3 Modelle", max: "Bis zu 3 Modelle" },
        { label: "Dateianh?nge", free: "Bilder, PDFs, Office, Drive", pro: "Bilder, PDFs, Office, Drive", max: "H?here Datei- und Kontextlimits" },
        { label: "Unterhaltungen teilen", free: "Teilen und herunterladen", pro: "Teilen und herunterladen", max: "Teilen, herunterladen, priorisierte Limits" },
        { label: "Nutzungskontingent", free: "T?gliche und monatliche Free-Limits", pro: "H?here t?gliche und monatliche Nutzung", max: "Kein t?gliches Nachrichtenlimit mit monatlichem Fair-Use-Schutz" },
      ],
    },
    faqTitle: "Fragen zu Preisen",
    faqs: [
      { question: "Kann ich Tomverse weiter kostenlos nutzen?", answer: "Ja. Free ist f?r leichte t?gliche Nutzung gedacht und bietet innerhalb der Limits Zugriff auf Free- und Pro-Modellstufen." },
      { question: "Wie funktioniert der Launch-Rabatt?", answer: "Geben Sie beim Checkout TOMVERSE50 ein, um in den ersten 3 Monaten 50 % Rabatt auf Pro oder Max zu erhalten. Danach verl?ngert sich der Plan zum regul?ren Monatspreis, sofern er nicht gek?ndigt wird." },
      { question: "Beschr?nkt Pro die ausw?hlbaren Modelle?", answer: "Pro soll den verf?gbaren Modellkatalog ?ffnen. Kostenintensivere Modelle werden eher ?ber Nutzungs- und Kostenlimits gesteuert als durch eine einfache Sperre im Modellw?hler." },
    ],
    note: "Preise verstehen sich in USD vor Steuern. Max entfernt das t?gliche Nachrichtenlimit, aber monatlicher Fair-Use-, Missbrauchs- und Provider-Kostenschutz gelten weiterhin.",
    plans: [
      { name: "Free", eyebrow: "F?r den Einstieg", price: "$0", period: "pro Monat", description: "Ein einfacher Weg, Tomverse auszuprobieren und ausgew?hlte KI-Modelle f?r leichte t?gliche Arbeit zu nutzen.", cta: "Kostenlos starten", href: "/chat", usage: "Grundlegende t?gliche Nutzung", features: ["Zugriff auf Free- und Pro-Modellstufen", "Bis zu 3 Modelle vergleichen", "Grundlegender Chatverlauf", "Dateianh?nge, Teilen und Downloads nach Anmeldung", "Gut f?r leichte pers?nliche Nutzung"] },
      { name: "Pro", eyebrow: "T?gliche Produktivit?t", price: "$19", period: "pro Monat", description: "F?r Nutzer, die Modelle vergleichen, Dateien anh?ngen und Unterhaltungen regelm??ig wiederverwenden.", cta: "Auf Pro upgraden", href: "/chat", highlighted: true, badge: "Empfohlen", usage: "Promo TOMVERSE50: 9,50 $/Monat f?r 3 Monate", features: ["Zugriff auf alle verf?gbaren Modellstufen", "Bis zu 3 Modelle nebeneinander vergleichen", "Dateianh?nge und Google-Drive-Dateien", "Unterhaltungen teilen und herunterladen", "H?here t?gliche und monatliche Limits"] },
      { name: "Max", eyebrow: "Intensive KI-Workflows", price: "$35", period: "pro Monat", description: "F?r Power-User, die Premium-Modelle, gr??ere Kontingente und priorisierten Spielraum ben?tigen.", cta: "Auf Max upgraden", href: "/chat", usage: "Promo TOMVERSE50: 17,50 $/Monat f?r 3 Monate", features: ["Zugriff auf Free-, Pro- und Max-Modellstufen", "Kein t?gliches Nachrichtenlimit mit monatlichem Fair-Use-Schutz", "H?here Anhang- und Kontextlimits", "Priorisierter Zugriff auf fortgeschrittene Modelle", "F?r intensive t?gliche KI-Workflows entwickelt"] },
    ],
  },
  es: {
    eyebrow: "Precios",
    title: "Elige el nivel adecuado de potencia de IA.",
    description: "Empieza gratis y actualiza cuando necesites m?s uso, flujos con archivos y acceso a modelos premium.",
    billingNote: "Oferta de lanzamiento: usa TOMVERSE50 para obtener 50 % de descuento en Pro o Max durante tus primeros 3 meses. Cancela cuando quieras.",
    compareTitle: "Compara lo que desbloquea cada plan",
    compareDescription: "Los planes de Tomverse se dise?an alrededor del acceso a modelos, l?mites de uso, archivos y controles para compartir.",
    table: {
      feature: "Funci?n",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Acceso a modelos", free: "Niveles Free y Pro", pro: "Todos los modelos con l?mites Pro", max: "Todos los modelos con la mayor asignaci?n" },
        { label: "Comparaci?n multi-modelo", free: "Hasta 3 modelos", pro: "Hasta 3 modelos", max: "Hasta 3 modelos" },
        { label: "Archivos adjuntos", free: "Im?genes, PDF, Office, Drive", pro: "Im?genes, PDF, Office, Drive", max: "L?mites superiores de archivos y contexto" },
        { label: "Compartir conversaciones", free: "Compartir y descargar", pro: "Compartir y descargar", max: "Compartir, descargar y l?mites prioritarios" },
        { label: "Uso permitido", free: "L?mites diarios y mensuales Free", pro: "Mayor uso diario y mensual", max: "Sin l?mite diario de mensajes con protecci?n mensual fair-use" },
      ],
    },
    faqTitle: "Preguntas sobre precios",
    faqs: [
      { question: "?Puedo seguir usando Tomverse gratis?", answer: "S?. Free est? pensado para uso diario ligero con acceso a niveles de modelos Free y Pro dentro de los l?mites de uso." },
      { question: "?C?mo funciona el descuento de lanzamiento?", answer: "Introduce TOMVERSE50 al pagar para recibir 50 % de descuento en Pro o Max durante los primeros 3 meses. Despu?s, el plan se renueva al precio mensual regular salvo cancelaci?n." },
      { question: "?Pro limita los modelos que puedo elegir?", answer: "Pro est? pensado para abrir el cat?logo de modelos disponible. Los modelos de mayor coste se gestionan con l?mites de uso y coste, no con un bloqueo simple del selector." },
    ],
    note: "Los precios est?n en USD antes de impuestos. Max elimina el l?mite diario de mensajes, pero siguen aplicando protecciones mensuales fair-use, antiabuso y de coste Provider.",
    plans: [
      { name: "Free", eyebrow: "Para empezar", price: "$0", period: "al mes", description: "Una forma sencilla de probar Tomverse y usar modelos de IA seleccionados para trabajo diario ligero.", cta: "Empezar gratis", href: "/chat", usage: "Uso diario b?sico", features: ["Acceso a niveles de modelos Free y Pro", "Comparar hasta 3 modelos", "Historial b?sico de chat", "Archivos, compartir y descargas tras iniciar sesi?n", "Adecuado para uso personal ligero"] },
      { name: "Pro", eyebrow: "Productividad diaria", price: "$19", period: "al mes", description: "Para quienes comparan modelos, adjuntan archivos y reutilizan conversaciones durante la semana.", cta: "Actualizar a Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "Promo TOMVERSE50: $9.50/mes durante 3 meses", features: ["Acceso a todos los niveles de modelos disponibles", "Comparar hasta 3 modelos lado a lado", "Archivos adjuntos y Google Drive", "Compartir y descargar conversaciones", "L?mites diarios y mensuales superiores"] },
      { name: "Max", eyebrow: "Flujos intensivos de IA", price: "$35", period: "al mes", description: "Para usuarios avanzados que necesitan modelos premium, mayores asignaciones y margen prioritario.", cta: "Actualizar a Max", href: "/chat", usage: "Promo TOMVERSE50: $17.50/mes durante 3 meses", features: ["Acceso a niveles Free, Pro y Max", "Sin l?mite diario de mensajes con protecci?n mensual fair-use", "L?mites superiores de adjuntos y contexto", "Acceso prioritario a modelos avanzados", "Dise?ado para flujos diarios intensivos de IA"] },
    ],
  },
  pt: {
    eyebrow: "Pre?os",
    title: "Escolha o n?vel certo de pot?ncia de IA.",
    description: "Comece gr?tis e fa?a upgrade quando precisar de mais uso, fluxos com arquivos e acesso a modelos premium.",
    billingNote: "Oferta de lan?amento: use TOMVERSE50 para 50% de desconto em Pro ou Max nos 3 primeiros meses. Cancele quando quiser.",
    compareTitle: "Compare o que cada plano libera",
    compareDescription: "Os planos Tomverse s?o pensados em torno de acesso a modelos, limites de uso, arquivos e compartilhamento.",
    table: {
      feature: "Recurso",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Acesso a modelos", free: "N?veis Free e Pro", pro: "Todos os modelos com limites Pro", max: "Todos os modelos com a maior franquia" },
        { label: "Compara??o multi-modelo", free: "At? 3 modelos", pro: "At? 3 modelos", max: "At? 3 modelos" },
        { label: "Anexos", free: "Imagens, PDFs, Office, Drive", pro: "Imagens, PDFs, Office, Drive", max: "Limites maiores de arquivos e contexto" },
        { label: "Compartilhar conversas", free: "Compartilhar e baixar", pro: "Compartilhar e baixar", max: "Compartilhar, baixar e limites priorit?rios" },
        { label: "Limite de uso", free: "Limites di?rios e mensais Free", pro: "Uso di?rio e mensal maior", max: "Sem limite di?rio de mensagens com prote??o mensal fair-use" },
      ],
    },
    faqTitle: "Perguntas sobre pre?os",
    faqs: [
      { question: "Posso continuar usando o Tomverse de gra?a?", answer: "Sim. O Free ? pensado para uso di?rio leve, com acesso aos n?veis de modelos Free e Pro dentro dos limites de uso." },
      { question: "Como funciona o desconto de lan?amento?", answer: "Digite TOMVERSE50 no checkout para receber 50% de desconto em Pro ou Max nos 3 primeiros meses. Depois disso, o plano renova pelo pre?o mensal regular, salvo cancelamento." },
      { question: "O Pro limita quais modelos posso escolher?", answer: "O Pro foi pensado para liberar o cat?logo de modelos dispon?vel. Modelos de custo maior s?o gerenciados por limites de uso e custo, n?o por um bloqueio simples no seletor." },
    ],
    note: "Os pre?os s?o em USD antes de impostos. O Max remove o limite di?rio de mensagens, mas prote??es mensais fair-use, antiabuso e de custo Provider continuam aplic?veis.",
    plans: [
      { name: "Free", eyebrow: "Para come?ar", price: "$0", period: "por m?s", description: "Uma forma simples de testar o Tomverse e usar modelos de IA selecionados para trabalho di?rio leve.", cta: "Come?ar gr?tis", href: "/chat", usage: "Uso di?rio b?sico", features: ["Acesso aos n?veis de modelos Free e Pro", "Comparar at? 3 modelos", "Hist?rico b?sico de chat", "Anexos, compartilhamento e downloads ap?s login", "Bom para uso pessoal leve"] },
      { name: "Pro", eyebrow: "Produtividade di?ria", price: "$19", period: "por m?s", description: "Para pessoas que comparam modelos, anexam arquivos e reutilizam conversas durante a semana.", cta: "Atualizar para Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "Promo TOMVERSE50: US$9.50/m?s por 3 meses", features: ["Acesso a todos os n?veis de modelos dispon?veis", "Comparar at? 3 modelos lado a lado", "Anexos e arquivos do Google Drive", "Compartilhar e baixar conversas", "Limites di?rios e mensais maiores"] },
      { name: "Max", eyebrow: "Fluxos intensivos de IA", price: "$35", period: "por m?s", description: "Para usu?rios avan?ados que precisam de modelos premium, franquias maiores e prioridade de uso.", cta: "Atualizar para Max", href: "/chat", usage: "Promo TOMVERSE50: US$17.50/m?s por 3 meses", features: ["Acesso aos n?veis Free, Pro e Max", "Sem limite di?rio de mensagens com prote??o mensal fair-use", "Limites maiores de anexos e contexto", "Acesso priorit?rio a modelos avan?ados", "Feito para fluxos di?rios intensivos de IA"] },
    ],
  },
};

export function PricingPageContent() {
  const { lang, t } = useLanguage();
  const content = copy[lang] ?? copy.en;

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <p className="mt-5 rounded-full bg-zinc-100 px-4 py-2 text-sm font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            {content.billingNote}
          </p>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {content.plans.map((plan) => (
            <article
              key={plan.name}
              className={`relative flex min-h-full flex-col rounded-[1.75rem] border p-6 shadow-sm ${
                plan.highlighted
                  ? "border-blue-500 bg-blue-600 text-white shadow-2xl shadow-blue-950/20"
                  : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
              }`}
            >
              <div className="flex min-h-8 items-start justify-between gap-3">
                <p className={`text-xs font-black uppercase tracking-[0.18em] ${plan.highlighted ? "text-blue-100" : "text-blue-600 dark:text-blue-400"}`}>
                  {plan.eyebrow}
                </p>
                {plan.badge && (
                  <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-black text-white ring-1 ring-white/20">
                    {plan.badge}
                  </span>
                )}
              </div>
              <h2 className="mt-4 text-3xl font-black">{plan.name}</h2>
              <p className={`mt-3 min-h-14 text-sm leading-6 ${plan.highlighted ? "text-blue-50" : "text-zinc-600 dark:text-zinc-300"}`}>
                {plan.description}
              </p>
              <div className="mt-8">
                <span className="text-4xl font-black">{plan.price}</span>
                <span className={`ml-2 text-sm font-bold ${plan.highlighted ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}`}>
                  {plan.period}
                </span>
              </div>
              <p className={`mt-3 text-sm font-black ${plan.highlighted ? "text-blue-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                {plan.usage}
              </p>
              {plan.price === "$0" ? (
                <Link
                  href={plan.href}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted
                      ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {plan.cta}
                </Link>
              ) : (
                <UpgradeInterestButton
                  plan={plan.name === "Max" ? "Max" : "Pro"}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted
                      ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {plan.cta}
                </UpgradeInterestButton>
              )}
              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className={`flex gap-3 text-sm font-semibold leading-6 ${plan.highlighted ? "text-white" : "text-zinc-700 dark:text-zinc-300"}`}>
                    <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${plan.highlighted ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <section className="mt-16 rounded-[2rem] border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-6">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-black">{content.compareTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{content.compareDescription}</p>
          </div>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr>
                  {[content.table.feature, content.table.free, content.table.pro, content.table.max].map((heading) => (
                    <th key={heading} className="border-b border-zinc-200 px-4 py-3 font-black text-zinc-900 dark:border-zinc-800 dark:text-white">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.table.rows.map((row) => (
                  <tr key={row.label}>
                    <td className="border-b border-zinc-200 px-4 py-4 font-black dark:border-zinc-800">{row.label}</td>
                    {[row.free, row.pro, row.max].map((value, index) => (
                      <td key={`${row.label}-${index}`} className="border-b border-zinc-200 px-4 py-4 font-semibold text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                        {value === "-" ? <Minus className="h-4 w-4 text-zinc-400" /> : value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <h2 className="text-3xl font-black">{content.faqTitle}</h2>
          <div className="grid gap-4">
            {content.faqs.map((faq) => (
              <article key={faq.question} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <h3 className="font-black">{faq.question}</h3>
                <p className="mt-2 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="mt-10 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-sm leading-7 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
          {content.note}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
