import type { Language } from "@/lib/language";

type PromptRefinerCopy = {
  action: string;
  actionDescription: string;
  requesting: string;
  proposalLabel: string;
  previewOnly: string;
  previewAction: string;
  keepOriginal: string;
  failed: string;
  retry: string;
  promptEmpty: string;
  promptTooManyCharacters: string;
  promptTooManyBytes: string;
  composerLocked: string;
  compositionActive: string;
};

export const promptRefinerCopy: Record<Language, PromptRefinerCopy> = {
  ko: {
    action: "문장 다듬기",
    actionDescription: "전송하지 않고 더 명확한 문장을 제안합니다.",
    requesting: "문장 제안을 준비하고 있습니다. 원문은 그대로 유지됩니다.",
    proposalLabel: "제안된 문장",
    previewOnly: "검증용 미리보기입니다. 원문은 바뀌지 않았고 대화 메시지는 전송되지 않았습니다.",
    previewAction: "제안 미리보기 확인",
    keepOriginal: "원문 유지",
    failed: "문장을 제안하지 못했습니다. 원문은 바뀌지 않았습니다.",
    retry: "다시 시도",
    promptEmpty: "다듬을 문장을 먼저 입력하세요.",
    promptTooManyCharacters: "문장을 16,000자 이하로 줄여 주세요.",
    promptTooManyBytes: "문장을 32KiB 이하로 줄여 주세요.",
    composerLocked: "입력창을 편집할 수 있을 때 다시 시도하세요.",
    compositionActive: "글자 입력 조합을 마친 뒤 다시 시도하세요.",
  },
  en: {
    action: "Improve wording",
    actionDescription: "Prepare a clearer version without sending it.",
    requesting: "Preparing a suggestion. Your original stays unchanged.",
    proposalLabel: "Suggested wording",
    previewOnly: "Fixture preview only. Your original is unchanged. No chat message was sent.",
    previewAction: "Confirm preview",
    keepOriginal: "Keep original",
    failed: "A suggestion could not be prepared. Your original was not changed.",
    retry: "Try again",
    promptEmpty: "Enter wording to improve first.",
    promptTooManyCharacters: "Shorten the draft to 16,000 characters or fewer.",
    promptTooManyBytes: "Shorten the draft to 32 KiB or less.",
    composerLocked: "Try again when the composer can be edited.",
    compositionActive: "Finish composing the current character, then try again.",
  },
  zh: {
    action: "优化表述",
    actionDescription: "在发送前提供更清晰的表述建议。",
    requesting: "正在准备建议，原文保持不变。",
    proposalLabel: "建议表述",
    previewOnly: "仅供测试预览。原文未更改，未发送聊天消息。",
    previewAction: "确认预览",
    keepOriginal: "保留原文",
    failed: "无法生成建议，原文未被更改。",
    retry: "重试",
    promptEmpty: "请先输入需要优化的文字。",
    promptTooManyCharacters: "请将草稿缩短至 16,000 个字符以内。",
    promptTooManyBytes: "请将草稿缩短至 32 KiB 以内。",
    composerLocked: "输入框可编辑后再试。",
    compositionActive: "请先完成当前文字输入，再试一次。",
  },
  fr: {
    action: "Clarifier le texte",
    actionDescription: "Prépare une formulation plus claire sans l’envoyer.",
    requesting: "Préparation d’une suggestion. Le texte original reste inchangé.",
    proposalLabel: "Formulation proposée",
    previewOnly: "Aperçu de test uniquement. L’original reste inchangé. Aucun message de chat n’a été envoyé.",
    previewAction: "Confirmer l’aperçu",
    keepOriginal: "Garder l’original",
    failed: "Aucune suggestion n’a pu être préparée. L’original est inchangé.",
    retry: "Réessayer",
    promptEmpty: "Saisissez d’abord le texte à clarifier.",
    promptTooManyCharacters: "Réduisez le brouillon à 16 000 caractères maximum.",
    promptTooManyBytes: "Réduisez le brouillon à 32 Kio maximum.",
    composerLocked: "Réessayez lorsque la zone de saisie est modifiable.",
    compositionActive: "Terminez la saisie du caractère en cours, puis réessayez.",
  },
  de: {
    action: "Formulierung verbessern",
    actionDescription: "Erstellt vor dem Senden eine klarere Formulierung.",
    requesting: "Vorschlag wird vorbereitet. Das Original bleibt unverändert.",
    proposalLabel: "Vorgeschlagene Formulierung",
    previewOnly: "Nur Testvorschau. Das Original blieb unverändert. Keine Chat-Nachricht wurde gesendet.",
    previewAction: "Vorschau bestätigen",
    keepOriginal: "Original behalten",
    failed: "Kein Vorschlag möglich. Das Original wurde nicht geändert.",
    retry: "Erneut versuchen",
    promptEmpty: "Geben Sie zuerst einen Text zum Verbessern ein.",
    promptTooManyCharacters: "Kürzen Sie den Entwurf auf höchstens 16.000 Zeichen.",
    promptTooManyBytes: "Kürzen Sie den Entwurf auf höchstens 32 KiB.",
    composerLocked: "Versuchen Sie es erneut, wenn das Eingabefeld bearbeitbar ist.",
    compositionActive: "Schließen Sie die aktuelle Zeicheneingabe ab und versuchen Sie es erneut.",
  },
  es: {
    action: "Mejorar redacción",
    actionDescription: "Prepara una versión más clara sin enviarla.",
    requesting: "Preparando una sugerencia. El original no cambia.",
    proposalLabel: "Redacción sugerida",
    previewOnly: "Solo vista previa de prueba. El original no cambió. No se envió ningún mensaje de chat.",
    previewAction: "Confirmar vista previa",
    keepOriginal: "Conservar original",
    failed: "No se pudo preparar una sugerencia. El original no cambió.",
    retry: "Reintentar",
    promptEmpty: "Escribe primero el texto que quieres mejorar.",
    promptTooManyCharacters: "Reduce el borrador a 16.000 caracteres o menos.",
    promptTooManyBytes: "Reduce el borrador a 32 KiB o menos.",
    composerLocked: "Inténtalo de nuevo cuando el cuadro de texto se pueda editar.",
    compositionActive: "Termina de componer el carácter actual y vuelve a intentarlo.",
  },
  pt: {
    action: "Melhorar redação",
    actionDescription: "Prepara uma versão mais clara sem enviá-la.",
    requesting: "Preparando uma sugestão. O original permanece igual.",
    proposalLabel: "Redação sugerida",
    previewOnly: "Prévia de teste apenas. O original não mudou. Nenhuma mensagem de chat foi enviada.",
    previewAction: "Confirmar prévia",
    keepOriginal: "Manter original",
    failed: "Não foi possível preparar uma sugestão. O original não mudou.",
    retry: "Tentar novamente",
    promptEmpty: "Digite primeiro o texto que deseja melhorar.",
    promptTooManyCharacters: "Reduza o rascunho para no máximo 16.000 caracteres.",
    promptTooManyBytes: "Reduza o rascunho para no máximo 32 KiB.",
    composerLocked: "Tente novamente quando o campo de texto puder ser editado.",
    compositionActive: "Conclua a composição do caractere atual e tente novamente.",
  },
};
