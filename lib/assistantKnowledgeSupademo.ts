import "server-only";

import { assistantKnowledgeSupademoEmbeds } from "@/lib/assistantKnowledgeSupademoCore";

/**
 * Build-time public variables are unnecessary here. The server reads the
 * public embed URLs at request time and sends only the selected, validated
 * values to the client component.
 */
export const configuredAssistantKnowledgeSupademoEmbeds = () =>
  assistantKnowledgeSupademoEmbeds({
    ko: process.env.ASSISTANT_KNOWLEDGE_SUPADEMO_KO_URL,
    en: process.env.ASSISTANT_KNOWLEDGE_SUPADEMO_EN_URL,
    zh: process.env.ASSISTANT_KNOWLEDGE_SUPADEMO_ZH_URL,
  });
