import type { Language } from "../lib/language";

const en = {
  generating: "Creating your image",
  workingHint: "Your image will appear in this reply when it is ready.",
  low: "Draft quality", medium: "Standard quality", high: "High quality",
  upgradeHint: "For a higher-quality version, send “Regenerate this image in high quality.”",
  costHint: "Generating again uses credits and may take longer.",
};

export const imageGenerationFeedbackCopy: Record<Language, typeof en> = {
  en,
  ko: {
    generating: "이미지를 만들고 있어요",
    workingHint: "완성되면 이 답변에 이미지가 표시됩니다.",
    low: "초안 품질", medium: "표준 품질", high: "고품질",
    upgradeHint: "더 선명한 결과가 필요하면 “이 이미지를 고품질로 다시 만들어 줘”라고 보내세요.",
    costHint: "다시 생성하면 크레딧이 사용되며, 시간이 더 걸릴 수 있습니다.",
  },
  zh: {
    generating: "正在生成图片",
    workingHint: "图片完成后会显示在这条回复中。",
    low: "草稿画质", medium: "标准画质", high: "高画质",
    upgradeHint: "如需更高画质，请发送“以高画质重新生成这张图片”。",
    costHint: "重新生成会消耗积分，并可能需要更长时间。",
  },
  de: {
    generating: "Dein Bild wird erstellt",
    workingHint: "Das fertige Bild erscheint in dieser Antwort.",
    low: "Entwurfsqualität", medium: "Standardqualität", high: "Hohe Qualität",
    upgradeHint: "Für eine höhere Qualität schreibe: „Erstelle dieses Bild erneut in hoher Qualität.“",
    costHint: "Eine erneute Erstellung verbraucht Credits und kann länger dauern.",
  },
  fr: {
    generating: "Création de votre image",
    workingHint: "L’image s’affichera dans cette réponse une fois prête.",
    low: "Qualité brouillon", medium: "Qualité standard", high: "Haute qualité",
    upgradeHint: "Pour une qualité supérieure, envoyez « Régénère cette image en haute qualité. »",
    costHint: "Une nouvelle génération utilise des crédits et peut prendre plus de temps.",
  },
  es: {
    generating: "Creando tu imagen",
    workingHint: "La imagen aparecerá en esta respuesta cuando esté lista.",
    low: "Calidad de borrador", medium: "Calidad estándar", high: "Alta calidad",
    upgradeHint: "Para obtener mayor calidad, envía «Vuelve a generar esta imagen en alta calidad».",
    costHint: "Generar otra imagen consume créditos y puede tardar más.",
  },
  pt: {
    generating: "A criar a sua imagem",
    workingHint: "A imagem aparecerá nesta resposta quando estiver pronta.",
    low: "Qualidade de rascunho", medium: "Qualidade padrão", high: "Alta qualidade",
    upgradeHint: "Para obter maior qualidade, envie «Gera novamente esta imagem em alta qualidade».",
    costHint: "Gerar novamente utiliza créditos e pode demorar mais.",
  },
};

/** Prefer the server's actual quality; never infer a label from an unknown value. */
export function imageResultQuality(quality?: string, preset?: string): "low" | "medium" | "high" | null {
  if (quality === "low" || quality === "medium" || quality === "high") return quality;
  if (quality) return null;
  return preset === "draft" ? "low" : preset === "standard" ? "medium" : preset === "final" ? "high" : null;
}
