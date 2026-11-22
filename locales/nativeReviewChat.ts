import type { MobileLanguage } from "./mobile";
import { reviewHandoffCopy } from "./reviewHandoff";

// Section labels mirror the web keys useReviewChatCopy() reads (chat.aiReview*,
// chat.quickSummary*), so a Native reference reads like the web one without
// pulling the full web dictionaries into the native bundle.
// tests/reviewToChat.test.mjs keeps these equal to locales/<language>.ts.
const sectionKeys = ["consensus", "differences", "contradictions", "missingPoints", "verificationNeeded", "models", "synthesis", "commonConclusions", "importantDifferences", "none", "strengths", "cautions"] as const;
const nativeKeys = ["changed", "currentDraft", "draftFiles", "checking"] as const;
type Row = readonly string[];
const sections: Record<MobileLanguage, Row> = {
  en: ["1. Consensus", "2. Important differences", "3. Contradictions", "4. Missing points", "5. Verification needed", "Key claims by model", "7. Optional synthesis", "Common conclusions", "Important differences", "No material item was identified.", "Strengths", "Cautions"],
  ko: ["1. 공통된 내용", "2. 중요한 차이", "3. 서로 모순되는 내용", "4. 빠진 내용", "5. 확인이 필요한 내용", "모델별 핵심 주장", "7. 선택형 종합안", "공통 결론", "중요한 차이", "중요한 항목이 확인되지 않았습니다.", "강점", "주의점"],
  zh: ["1. 共识", "2. 重要差异", "3. 矛盾之处", "4. 遗漏要点", "5. 需要核实", "各模型的核心观点", "7. 可选综合结论", "共同结论", "重要差异", "未发现实质性内容。", "优点", "注意事项"],
  "zh-Hant": ["1. 共識", "2. 重要差異", "3. 矛盾之處", "4. 遺漏要點", "5. 需要查證", "各模型的核心觀點", "7. 可選綜合結論", "共同結論", "重要差異", "未發現實質性內容。", "優點", "注意事項"],
  de: ["1. Übereinstimmung", "2. Wichtige Unterschiede", "3. Widersprüche", "4. Fehlende Punkte", "5. Prüfung erforderlich", "Kernaussagen je Modell", "7. Optionale Zusammenführung", "Gemeinsame Schlussfolgerungen", "Wichtige Unterschiede", "Kein wesentlicher Punkt gefunden.", "Stärken", "Vorbehalte"],
  fr: ["1. Consensus", "2. Différences importantes", "3. Contradictions", "4. Points manquants", "5. Vérification nécessaire", "Affirmations clés par modèle", "7. Synthèse facultative", "Conclusions communes", "Différences importantes", "Aucun élément significatif n'a été identifié.", "Points forts", "Points de vigilance"],
  es: ["1. Consenso", "2. Diferencias importantes", "3. Contradicciones", "4. Puntos ausentes", "5. Verificación necesaria", "Afirmaciones clave por modelo", "7. Síntesis opcional", "Conclusiones comunes", "Diferencias importantes", "No se identificó ningún elemento relevante.", "Fortalezas", "Advertencias"],
  pt: ["1. Consenso", "2. Diferenças importantes", "3. Contradições", "4. Pontos ausentes", "5. Verificação necessária", "Principais afirmações por modelo", "7. Síntese opcional", "Conclusões em comum", "Diferenças importantes", "Nenhum item relevante foi identificado.", "Pontos fortes", "Ressalvas"],
};
const native: Record<MobileLanguage, Row> = {
  en: ["Your Chat draft changed while the result was being checked. Review the current draft below and confirm again.", "Current new Chat draft", "Attached files stay in the draft: {count}", "Checking the saved result…"],
  ko: ["결과를 확인하는 동안 채팅 초안이 바뀌었습니다. 아래 현재 초안을 확인한 뒤 다시 눌러주세요.", "현재 새 채팅 초안", "초안에 첨부된 파일은 그대로 유지됩니다: {count}개", "저장된 결과를 확인하고 있습니다…"],
  zh: ["核对结果期间聊天草稿已更改。请查看下方当前草稿后再次确认。", "当前新聊天草稿", "草稿中的附件将保留：{count}个", "正在核对已保存的结果…"],
  "zh-Hant": ["核對結果期間聊天草稿已變更。請檢視下方目前草稿後再次確認。", "目前新聊天草稿", "草稿中的附件將保留：{count}個", "正在核對已儲存的結果…"],
  de: ["Ihr Chatentwurf hat sich während der Prüfung geändert. Prüfen Sie den aktuellen Entwurf unten und bestätigen Sie erneut.", "Aktueller neuer Chatentwurf", "Angehängte Dateien bleiben im Entwurf: {count}", "Gespeichertes Ergebnis wird geprüft…"],
  fr: ["Votre brouillon Chat a changé pendant la vérification. Vérifiez le brouillon actuel ci-dessous et confirmez à nouveau.", "Brouillon actuel du nouveau Chat", "Les fichiers joints restent dans le brouillon : {count}", "Vérification du résultat enregistré…"],
  es: ["Tu borrador de Chat cambió mientras se comprobaba el resultado. Revisa el borrador actual abajo y confirma de nuevo.", "Borrador actual del nuevo Chat", "Los archivos adjuntos se conservan en el borrador: {count}", "Comprobando el resultado guardado…"],
  pt: ["Seu rascunho do Chat mudou enquanto o resultado era verificado. Confira o rascunho atual abaixo e confirme novamente.", "Rascunho atual do novo Chat", "Os arquivos anexados permanecem no rascunho: {count}", "Verificando o resultado salvo…"],
};
const zip = <K extends string>(keys: readonly K[], row: Row) => Object.fromEntries(keys.map((key, index) => [key, row[index]])) as Record<K, string>;
export type NativeReviewChatCopy = typeof reviewHandoffCopy.en & Record<typeof sectionKeys[number] | typeof nativeKeys[number], string>;

/** Complete ReviewChatCopy for formatReviewChat plus the Native preview strings. */
export const nativeReviewChatCopy = (language: MobileLanguage): NativeReviewChatCopy => ({
  ...reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language],
  ...zip(sectionKeys, sections[language]), ...zip(nativeKeys, native[language]),
});
export const nativeReviewChatSectionKeys = sectionKeys;
