import type { Language } from "@/lib/language";

type PromptRefinerCopy = {
  action: string;
  actionDescription: string;
  requesting: string;
  proposalLabel: string;
  useProposal: string;
  keepOriginal: string;
  failed: string;
  retry: string;
};

export const promptRefinerCopy: Record<Language, PromptRefinerCopy> = {
  ko: {
    action: "문장 다듬기",
    actionDescription: "전송하지 않고 더 명확한 문장을 제안합니다.",
    requesting: "문장 제안을 준비하고 있습니다. 원문은 그대로 유지됩니다.",
    proposalLabel: "제안된 문장",
    useProposal: "이 문장 사용",
    keepOriginal: "원문 유지",
    failed: "문장을 제안하지 못했습니다. 원문은 바뀌지 않았습니다.",
    retry: "다시 시도",
  },
  en: {
    action: "Improve wording",
    actionDescription: "Prepare a clearer version without sending it.",
    requesting: "Preparing a suggestion. Your original stays unchanged.",
    proposalLabel: "Suggested wording",
    useProposal: "Use this wording",
    keepOriginal: "Keep original",
    failed: "A suggestion could not be prepared. Your original was not changed.",
    retry: "Try again",
  },
  zh: {
    action: "优化表述",
    actionDescription: "在发送前提供更清晰的表述建议。",
    requesting: "正在准备建议，原文保持不变。",
    proposalLabel: "建议表述",
    useProposal: "使用此表述",
    keepOriginal: "保留原文",
    failed: "无法生成建议，原文未被更改。",
    retry: "重试",
  },
  fr: {
    action: "Clarifier le texte",
    actionDescription: "Prépare une formulation plus claire sans l’envoyer.",
    requesting: "Préparation d’une suggestion. Le texte original reste inchangé.",
    proposalLabel: "Formulation proposée",
    useProposal: "Utiliser ce texte",
    keepOriginal: "Garder l’original",
    failed: "Aucune suggestion n’a pu être préparée. L’original est inchangé.",
    retry: "Réessayer",
  },
  de: {
    action: "Formulierung verbessern",
    actionDescription: "Erstellt vor dem Senden eine klarere Formulierung.",
    requesting: "Vorschlag wird vorbereitet. Das Original bleibt unverändert.",
    proposalLabel: "Vorgeschlagene Formulierung",
    useProposal: "Diese Formulierung nutzen",
    keepOriginal: "Original behalten",
    failed: "Kein Vorschlag möglich. Das Original wurde nicht geändert.",
    retry: "Erneut versuchen",
  },
  es: {
    action: "Mejorar redacción",
    actionDescription: "Prepara una versión más clara sin enviarla.",
    requesting: "Preparando una sugerencia. El original no cambia.",
    proposalLabel: "Redacción sugerida",
    useProposal: "Usar esta redacción",
    keepOriginal: "Conservar original",
    failed: "No se pudo preparar una sugerencia. El original no cambió.",
    retry: "Reintentar",
  },
  pt: {
    action: "Melhorar redação",
    actionDescription: "Prepara uma versão mais clara sem enviá-la.",
    requesting: "Preparando uma sugestão. O original permanece igual.",
    proposalLabel: "Redação sugerida",
    useProposal: "Usar esta redação",
    keepOriginal: "Manter original",
    failed: "Não foi possível preparar uma sugestão. O original não mudou.",
    retry: "Tentar novamente",
  },
};

