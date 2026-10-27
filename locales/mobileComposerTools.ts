import type { MobileLanguage } from "./mobile";

const en = {
  title: "Message tools", photos: "Photos", files: "Files", photosAction: "Choose photos", filesAction: "Choose files",
  attachmentsHint: "Only the photos and files you select are shared.",
  search: "Web search", searchHint: "Use current web information in answers",
  location: "Current location",
  locationNote: "While on, each message shares your approximate location with AI providers for relevant answers. No background tracking.",
  assistant: "Assistant", defaultAssistant: "Default assistant", applies: "Applies to this conversation",
};

const copy: Record<MobileLanguage, typeof en> = {
  en,
  ko: {
    title: "메시지 도구", photos: "사진", files: "파일", photosAction: "사진 선택", filesAction: "파일 선택",
    attachmentsHint: "선택한 사진과 파일만 공유해요.",
    search: "웹 검색", searchHint: "최신 웹 정보를 답변에 활용해요",
    location: "현재 위치",
    locationNote: "켜면 메시지마다 대략적 위치를 AI 제공자에게 전달해 관련 답변에 사용해요. 백그라운드 추적은 하지 않아요.",
    assistant: "어시스턴트", defaultAssistant: "기본 어시스턴트", applies: "이 대화에 적용",
  },
  zh: {
    title: "消息工具", photos: "照片", files: "文件", photosAction: "选择照片", filesAction: "选择文件",
    attachmentsHint: "仅分享你选择的照片和文件。",
    search: "网页搜索", searchHint: "在回答中使用最新的网页信息",
    location: "当前位置",
    locationNote: "开启后，每条消息会向 AI 提供商分享大致位置，用于相关回答。不会在后台跟踪位置。",
    assistant: "助手", defaultAssistant: "默认助手", applies: "应用于此对话",
  },
  de: {
    title: "Nachrichtenwerkzeuge", photos: "Fotos", files: "Dateien", photosAction: "Fotos auswählen", filesAction: "Dateien auswählen",
    attachmentsHint: "Nur ausgewählte Fotos und Dateien werden geteilt.",
    search: "Websuche", searchHint: "Aktuelle Webinformationen für Antworten nutzen",
    location: "Aktueller Standort",
    locationNote: "Wenn aktiviert, wird dein ungefährer Standort bei jeder Nachricht für relevante Antworten an KI-Anbieter gesendet. Keine Ortung im Hintergrund.",
    assistant: "Assistent", defaultAssistant: "Standardassistent", applies: "Gilt für diesen Chat",
  },
  fr: {
    title: "Outils de message", photos: "Photos", files: "Fichiers", photosAction: "Choisir des photos", filesAction: "Choisir des fichiers",
    attachmentsHint: "Seuls les photos et fichiers choisis sont partagés.",
    search: "Recherche web", searchHint: "Utiliser des informations web récentes",
    location: "Position actuelle",
    locationNote: "Si activée, chaque message partage votre position approximative avec les fournisseurs d’IA pour les réponses pertinentes. Aucun suivi en arrière-plan.",
    assistant: "Assistant", defaultAssistant: "Assistant par défaut", applies: "S’applique à cette conversation",
  },
  es: {
    title: "Herramientas de mensaje", photos: "Fotos", files: "Archivos", photosAction: "Elegir fotos", filesAction: "Elegir archivos",
    attachmentsHint: "Solo se comparten las fotos y archivos que eliges.",
    search: "Búsqueda web", searchHint: "Usar información web reciente en las respuestas",
    location: "Ubicación actual",
    locationNote: "Al activarla, cada mensaje comparte tu ubicación aproximada con los proveedores de IA para respuestas pertinentes. Sin seguimiento en segundo plano.",
    assistant: "Asistente", defaultAssistant: "Asistente predeterminado", applies: "Se aplica a esta conversación",
  },
  pt: {
    title: "Ferramentas de mensagem", photos: "Fotos", files: "Ficheiros", photosAction: "Escolher fotos", filesAction: "Escolher ficheiros",
    attachmentsHint: "Só são partilhados os ficheiros e fotos que escolher.",
    search: "Pesquisa web", searchHint: "Usar informação web recente nas respostas",
    location: "Localização atual",
    locationNote: "Quando ativa, cada mensagem partilha a localização aproximada com os fornecedores de IA para respostas relevantes. Sem rastreio em segundo plano.",
    assistant: "Assistente", defaultAssistant: "Assistente predefinido", applies: "Aplica-se a esta conversa",
  },
};

export function mobileComposerToolsCopy(language: string) {
  return copy[language as MobileLanguage] ?? en;
}
