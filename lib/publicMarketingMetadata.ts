import type { Metadata } from "next";
import type { Language } from "@/lib/language";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import { SEO_LOCALES, createPageMetadata, localizedPath, localizedQueryPath, queryLanguageAlternates } from "@/lib/seo";

type Copy = { title: string; description: string };
type LocalizedPairs = [[string, string], [string, string], [string, string], [string, string], [string, string], [string, string], [string, string]];
const localized = (...entries: LocalizedPairs): Record<Language, Copy> =>
  Object.fromEntries(SEO_LOCALES.map((locale, index) => [locale, {
    title: entries[index][0], description: entries[index][1],
  }])) as Record<Language, Copy>;

/** This catalogue contains editorial copy only; no account or feature reads. */
export const publicMarketingMetadataCopy = {
  "/about": localized(
    ["About Tomverse | Chat and Review", "Discover how Tomverse Chat helps with AI selection and everyday questions, while Tomverse Review compares answers and perspectives with quotes."],
    ["Tomverse 소개 | Chat과 Review", "AI 선택과 일상 질문을 돕는 Tomverse Chat, 여러 답변의 관점과 빠진 내용을 인용으로 비교하는 Tomverse Review를 알아보세요."],
    ["关于 Tomverse | Chat 与 Review", "了解 Tomverse Chat 如何帮助选择 AI 和解答日常问题，以及 Tomverse Review 如何结合引文比较回答中的视角与遗漏。"],
    ["À propos de Tomverse | Chat et Review", "Découvrez Tomverse Chat pour choisir une IA et poser vos questions, et Tomverse Review pour comparer les points de vue et omissions, citations à l’appui."],
    ["Über Tomverse | Chat und Review", "Entdecken Sie Tomverse Chat für KI-Auswahl und Alltagsfragen sowie Tomverse Review zum Vergleich von Perspektiven und Lücken anhand von Zitaten."],
    ["Acerca de Tomverse | Chat y Review", "Conoce Tomverse Chat para elegir una IA y plantear preguntas cotidianas, y Tomverse Review para comparar perspectivas y omisiones con citas."],
    ["Sobre o Tomverse | Chat e Review", "Conheça o Tomverse Chat para escolher uma IA e fazer perguntas do dia a dia, e o Tomverse Review para comparar perspectivas e lacunas com citações."],
  ),
  "/faq": localized(
    ["Tomverse FAQ | Chat, Review and Credits", "Find answers about Chat and Review, guest access, Smart Adaptive, question refinement, AI Review, files, plans and credit usage."],
    ["Tomverse 자주 묻는 질문 | Chat·Review·크레딧", "Chat과 Review, 비회원 이용, Smart Adaptive, 질문 다듬기, AI Review, 파일과 플랜·크레딧 사용에 대한 답변을 확인하세요."],
    ["Tomverse 常见问题 | Chat、Review 与积分", "查看 Chat 与 Review、访客体验、Smart Adaptive、提问优化、AI Review、文件、套餐和积分使用的常见问题。"],
    ["FAQ Tomverse | Chat, Review et crédits", "Retrouvez les réponses sur Chat et Review, le mode invité, Smart Adaptive, la reformulation, AI Review, les fichiers, les offres et les crédits."],
    ["Tomverse FAQ | Chat, Review und Credits", "Antworten zu Chat und Review, Gastzugang, Smart Adaptive, Fragenpräzisierung, AI Review, Dateien, Tarifen und Credit-Verbrauch."],
    ["Preguntas frecuentes de Tomverse | Chat, Review y créditos", "Resuelve dudas sobre Chat y Review, acceso como invitado, Smart Adaptive, preguntas, AI Review, archivos, planes y créditos."],
    ["Perguntas frequentes do Tomverse | Chat, Review e créditos", "Veja respostas sobre Chat e Review, acesso como visitante, Smart Adaptive, perguntas, AI Review, arquivos, planos e créditos."],
  ),
  "/pricing": localized(
    ["Tomverse Pricing | Free, Pro and Max", "Start with Free and compare Pro and Max by model access, monthly credits and file limits. See billing choices, add-on credits and usage examples."],
    ["Tomverse 요금제 | Free·Pro·Max", "Free로 시작하고 모델 이용 범위, 월 크레딧과 파일 한도로 Pro·Max를 비교하세요. 결제 방식, 추가 크레딧과 사용량 예시도 확인할 수 있습니다."],
    ["Tomverse 套餐 | Free、Pro 与 Max", "从 Free 开始，按模型范围、每月积分和文件限制比较 Pro 与 Max。查看结算方式、额外积分和用量示例。"],
    ["Tarifs Tomverse | Free, Pro et Max", "Commencez avec Free et comparez Pro et Max selon les modèles, crédits mensuels et limites de fichiers. Consultez la facturation et les exemples d’usage."],
    ["Tomverse Tarife | Free, Pro und Max", "Starten Sie mit Free und vergleichen Sie Pro und Max nach Modellzugriff, monatlichen Credits und Dateilimits. Entdecken Sie Abrechnung und Nutzungsbeispiele."],
    ["Precios de Tomverse | Free, Pro y Max", "Empieza con Free y compara Pro y Max por modelos, créditos mensuales y límites de archivos. Consulta facturación, créditos adicionales y ejemplos de uso."],
    ["Preços do Tomverse | Free, Pro e Max", "Comece no Free e compare Pro e Max por modelos, créditos mensais e limites de arquivos. Veja cobrança, créditos adicionais e exemplos de uso."],
  ),
  "/models": localized(
    ["Tomverse AI Models | Uses and Credits", "Explore Tomverse models by provider, suggested uses and base credits. Access depends on your plan and service availability; check the current status."],
    ["Tomverse AI 모델 | 활용과 크레딧", "제공자, 추천 활용과 기본 크레딧으로 Tomverse 모델을 살펴보세요. 이용 범위는 플랜과 서비스 상태에 따라 달라지므로 현재 상태도 확인하세요."],
    ["Tomverse AI 模型 | 用途与积分", "按提供商、推荐用途和基础积分查看 Tomverse 模型。可用范围取决于套餐与服务状态，请查看当前状态。"],
    ["Modèles IA Tomverse | Usages et crédits", "Explorez les modèles selon leur fournisseur, usages suggérés et crédits de base. L’accès dépend de l’offre et du service ; consultez l’état actuel."],
    ["Tomverse KI-Modelle | Aufgaben und Credits", "Entdecken Sie Modelle nach Anbieter, vorgeschlagenen Aufgaben und Basis-Credits. Zugriff hängt von Tarif und Verfügbarkeit ab; prüfen Sie den Status."],
    ["Modelos de IA de Tomverse | Usos y créditos", "Explora modelos por proveedor, usos sugeridos y créditos base. El acceso depende del plan y del servicio; consulta su estado actual."],
    ["Modelos de IA do Tomverse | Usos e créditos", "Explore modelos por provedor, usos sugeridos e créditos-base. O acesso depende do plano e da disponibilidade; confira o status atual."],
  ),
  "/safety": localized(
    ["Tomverse Safety | Controls and AI Limits", "Understand Tomverse account and sharing controls, AI-provider processing, answer limitations and the information to check before important decisions."],
    ["Tomverse 안전 안내 | 제어와 AI의 한계", "계정과 공유 제어, AI 제공자의 처리 범위와 답변의 한계를 살펴보고 중요한 판단 전에 확인할 정보를 알아보세요."],
    ["Tomverse 安全说明 | 控制与 AI 局限", "了解账户和分享控制、AI 提供商处理、回答局限，以及重要决定前需要确认的信息。"],
    ["Sécurité Tomverse | Contrôles et limites de l’IA", "Comprenez les contrôles de compte et de partage, le traitement par les fournisseurs et les limites des réponses avant une décision importante."],
    ["Tomverse Sicherheit | Kontrolle und KI-Grenzen", "Erfahren Sie mehr über Konto- und Freigabekontrollen, Anbieter-Verarbeitung und Antwortgrenzen vor wichtigen Entscheidungen."],
    ["Seguridad de Tomverse | Controles y límites de la IA", "Conoce los controles de cuenta y uso compartido, el procesamiento de proveedores y los límites de las respuestas antes de tomar decisiones importantes."],
    ["Segurança do Tomverse | Controles e limites da IA", "Entenda controles de conta e compartilhamento, processamento de provedores e limites das respostas antes de decisões importantes."],
  ),
  "/safety/approach": localized(
    ["Tomverse Safety Approach", "See how layered controls, clear AI limitations, user choices and incident response guide Tomverse Chat and Review."],
    ["Tomverse의 안전 접근 방식", "여러 단계의 제어, AI의 한계 안내, 사용자 선택과 장애 대응이 Chat과 Review에서 어떻게 연결되는지 알아보세요."],
    ["Tomverse 的安全方法", "了解分层控制、清晰的 AI 局限、用户选择与事件响应如何用于 Tomverse Chat 和 Review。"],
    ["L’approche de sécurité de Tomverse", "Découvrez les contrôles successifs, les limites de l’IA, les choix utilisateur et la réponse aux incidents dans Chat et Review."],
    ["Der Sicherheitsansatz von Tomverse", "Erfahren Sie, wie mehrstufige Kontrollen, KI-Grenzen, Nutzerentscheidungen und Vorfallreaktionen Chat und Review begleiten."],
    ["El enfoque de seguridad de Tomverse", "Descubre los controles por capas, límites de la IA, decisiones del usuario y respuesta a incidentes en Chat y Review."],
    ["A abordagem de segurança do Tomverse", "Conheça controles em camadas, limites da IA, escolhas do usuário e resposta a incidentes no Chat e no Review."],
  ),
  "/safety/security-privacy": localized(
    ["Tomverse Security and Data Processing", "Learn how accounts, saved conversations, attachments and shared links are controlled, and what selected AI providers process to answer your questions."],
    ["Tomverse 보안과 데이터 처리", "계정·저장한 대화·첨부 파일·공유 링크의 제어와, 답변을 위해 선택한 AI 제공자가 처리하는 내용을 확인하세요."],
    ["Tomverse 安全与数据处理", "了解账户、已保存对话、附件和分享链接的控制，以及所选 AI 提供商为回答问题处理的内容。"],
    ["Sécurité et traitement des données dans Tomverse", "Comprenez les contrôles des comptes, conversations, fichiers et liens partagés, ainsi que les données traitées par le fournisseur IA choisi."],
    ["Tomverse Sicherheit und Datenverarbeitung", "Informationen zu Konto-, Gesprächs-, Datei- und Linkkontrollen sowie zu den Daten, die gewählte KI-Anbieter für Antworten verarbeiten."],
    ["Seguridad y tratamiento de datos en Tomverse", "Consulta los controles de cuentas, conversaciones, archivos y enlaces, y los datos que procesa el proveedor de IA elegido para responder."],
    ["Segurança e processamento de dados no Tomverse", "Veja controles de contas, conversas, arquivos e links, e os dados que o provedor de IA escolhido processa para responder."],
  ),
  "/safety/trust-transparency": localized(
    ["Tomverse Trust and Transparency", "Understand model-provider boundaries, public service status, AI answer limitations and how to check the information behind a decision."],
    ["Tomverse 신뢰와 투명성", "모델 제공자의 역할, 공개 서비스 상태, AI 답변의 한계와 판단에 필요한 정보를 확인하는 방법을 알아보세요."],
    ["Tomverse 信任与透明度", "了解模型提供商的角色、公开服务状态、AI 回答的局限，以及决定前如何确认相关信息。"],
    ["Confiance et transparence chez Tomverse", "Comprenez le rôle des fournisseurs, l’état public du service, les limites des réponses et les informations à vérifier avant de décider."],
    ["Tomverse Vertrauen und Transparenz", "Informationen zu Anbieterrollen, öffentlichem Servicestatus, KI-Antwortgrenzen und zur Prüfung von Entscheidungsgrundlagen."],
    ["Confianza y transparencia en Tomverse", "Conoce el papel de los proveedores, el estado público del servicio, los límites de la IA y qué información comprobar antes de decidir."],
    ["Confiança e transparência no Tomverse", "Entenda o papel dos provedores, o status público do serviço, os limites da IA e o que conferir antes de decidir."],
  ),
  "/support": localized(
    ["Tomverse Support | Get Help", "Get help with Chat and Review, accounts, models, files, credits and errors. Learn what to include in a support request and check service status."],
    ["Tomverse 고객 지원", "Chat과 Review, 계정·모델·파일·크레딧과 오류 관련 도움을 받으세요. 문의에 필요한 정보를 살펴보고 서비스 상태도 확인할 수 있습니다."],
    ["Tomverse 支持 | 获取帮助", "获取 Chat 和 Review、账户、模型、文件、积分与错误的帮助。了解联系支持需要的信息，并查看服务状态。"],
    ["Assistance Tomverse | Obtenir de l’aide", "Obtenez de l’aide pour Chat, Review, comptes, modèles, fichiers, crédits et erreurs. Préparez votre demande et consultez l’état du service."],
    ["Tomverse Support | Hilfe erhalten", "Hilfe zu Chat, Review, Konten, Modellen, Dateien, Credits und Fehlern. Erfahren Sie, welche Angaben eine Anfrage benötigt, und prüfen Sie den Status."],
    ["Soporte de Tomverse | Obtén ayuda", "Recibe ayuda con Chat, Review, cuentas, modelos, archivos, créditos y errores. Prepara tu consulta y revisa el estado del servicio."],
    ["Suporte do Tomverse | Receba ajuda", "Receba ajuda com Chat, Review, contas, modelos, arquivos, créditos e erros. Prepare sua solicitação e confira o status do serviço."],
  ),
  "/support/help-centre": localized(
    ["Tomverse Help Centre | Chat and Review", "Find practical guidance on choosing Chat or Review, models, files, saved conversations, sharing, credits and support."],
    ["Tomverse 도움말 센터 | Chat과 Review", "Chat과 Review 선택부터 모델·파일·저장한 대화·공유·크레딧과 지원까지 실제 이용에 필요한 안내를 확인하세요."],
    ["Tomverse 帮助中心 | Chat 与 Review", "查看选择 Chat 或 Review、模型、文件、已保存对话、分享、积分和支持的实用说明。"],
    ["Centre d’aide Tomverse | Chat et Review", "Retrouvez des conseils pratiques sur Chat ou Review, les modèles, fichiers, conversations enregistrées, partages, crédits et l’assistance."],
    ["Tomverse Hilfecenter | Chat und Review", "Praktische Hilfe zu Chat oder Review, Modellen, Dateien, gespeicherten Gesprächen, Freigaben, Credits und Support."],
    ["Centro de ayuda de Tomverse | Chat y Review", "Encuentra guías prácticas para elegir Chat o Review y usar modelos, archivos, conversaciones guardadas, enlaces y créditos."],
    ["Central de ajuda do Tomverse | Chat e Review", "Veja orientações práticas para escolher Chat ou Review e usar modelos, arquivos, conversas salvas, compartilhamento e créditos."],
  ),
  "/support/help-centre/chat-workspace": localized(
    ["Tomverse Chat and Review Workspace Guide", "Learn when to use Chat or Review, choose models, refine questions, compare answers and work with files, saved conversations and credits."],
    ["Tomverse Chat·Review 작업 공간 가이드", "Chat과 Review를 언제 사용할지 알아보고, 모델 선택·질문 다듬기·답변 비교와 파일·저장한 대화·크레딧 사용을 살펴보세요."],
    ["Tomverse Chat 与 Review 工作区指南", "了解何时使用 Chat 或 Review，如何选择模型、优化提问、比较回答，以及使用文件、已保存对话和积分。"],
    ["Guide des espaces Chat et Review de Tomverse", "Découvrez quand utiliser Chat ou Review, choisir un modèle, préciser une question, comparer les réponses et utiliser fichiers, conversations et crédits."],
    ["Tomverse Anleitung für Chat und Review", "Wann Chat oder Review helfen, wie Sie Modelle wählen, Fragen präzisieren und Antworten vergleichen sowie Dateien, Gespräche und Credits nutzen."],
    ["Guía de espacios Chat y Review de Tomverse", "Aprende cuándo usar Chat o Review, elegir modelos, precisar preguntas, comparar respuestas y trabajar con archivos, conversaciones y créditos."],
    ["Guia dos espaços Chat e Review do Tomverse", "Aprenda quando usar Chat ou Review, escolher modelos, aprimorar perguntas, comparar respostas e usar arquivos, conversas e créditos."],
  ),
} satisfies Record<string, Record<Language, Copy>>;

export type PublicMarketingPagePath = keyof typeof publicMarketingMetadataCopy;
export type LocalizedPublicPageProps = { params: Promise<{ locale: string }> };

export const publicMarketingLocaleParams = () =>
  [...SEO_LOCALES, ...Object.keys(MARKETING_LOCALE_ALIASES)].map((locale) => ({ locale }));

export const publicMarketingPageMetadata = (basePath: PublicMarketingPagePath, locale: Language = "en", localizedRoute = false): Metadata => {
  const copy = publicMarketingMetadataCopy[basePath][locale];
  return createPageMetadata({
    ...copy,
    path: localizedRoute ? localizedPath(locale, basePath) : basePath,
    locale,
    localizedBasePath: basePath,
    absoluteTitle: true,
  });
};

export const localizedPublicPageMetadata = async ({ params }: LocalizedPublicPageProps, basePath: PublicMarketingPagePath): Promise<Metadata> => {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);
  return lang ? publicMarketingPageMetadata(basePath, lang, true) : {};
};

const knowledgeCopy = localized(
  ["Create an Assistant with Your Knowledge | Tomverse", "Create an AI assistant, add supported Knowledge files and check the relevant excerpts behind a reply. Follow the guide to use it in a conversation."],
  ["내 자료로 AI 어시스턴트 만들기 | Tomverse", "AI 어시스턴트를 만들고 지원되는 Knowledge 파일을 추가한 뒤 답변에 관련된 발췌를 확인하세요. 가이드를 따라 대화에서 활용할 수 있습니다."],
  ["用自己的资料创建 AI 助手 | Tomverse", "创建 AI 助手、添加支持的 Knowledge 文件，并查看回答相关的摘录。按照指南在对话中使用。"],
  ["Créer un assistant avec vos documents | Tomverse", "Créez un assistant IA, ajoutez des fichiers Knowledge pris en charge et consultez les extraits liés aux réponses. Suivez le guide pour l’utiliser."],
  ["Einen Assistenten mit Ihren Unterlagen erstellen | Tomverse", "Erstellen Sie einen KI-Assistenten, fügen Sie unterstützte Knowledge-Dateien hinzu und prüfen Sie passende Auszüge zu Antworten. Folgen Sie der Anleitung."],
  ["Crea un asistente con tus documentos | Tomverse", "Crea un asistente de IA, añade archivos Knowledge compatibles y consulta los extractos relacionados con las respuestas. Sigue la guía para usarlo."],
  ["Crie um assistente com seus documentos | Tomverse", "Crie um assistente de IA, adicione arquivos Knowledge compatíveis e confira os trechos relacionados às respostas. Siga o guia para utilizá-lo."],
);

export const assistantKnowledgeMetadata = (locale: Language): Metadata => {
  const basePath = "/guides/assistant-knowledge";
  const path = localizedQueryPath(locale, basePath);
  const metadata = createPageMetadata({ ...knowledgeCopy[locale], path, locale, absoluteTitle: true });
  return {
    ...metadata,
    alternates: {
      ...metadata.alternates,
      languages: queryLanguageAlternates(basePath),
    },
  };
};
