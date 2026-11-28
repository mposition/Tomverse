/**
 * Words for the reasoning summary above a Chat answer: "Thinking" while the
 * model reasons and "Thought for N seconds" once the answer has started.
 *
 * A side table keyed by language (the shape locales/chatTurnTools.ts uses) so
 * this screen does not share a merge hot spot with the large locale files.
 * `{seconds}` and `{minutes}` are replaced by the whole numbers.
 */
import type { Language } from "@/lib/language";

export type ChatReasoningCopy = {
  /** While the model is still reasoning. */
  thinking: string;
  /** Finished, duration unknown (a reloaded or recovered answer). */
  thought: string;
  thoughtSeconds: string;
  thoughtMinutes: string;
  /** Accessible name of the opened summary. */
  summaryLabel: string;
};

export const chatReasoningCopy: Record<Language, ChatReasoningCopy> = {
  en: {
    thinking: "Thinking",
    thought: "Thought",
    thoughtSeconds: "Thought for {seconds}s",
    thoughtMinutes: "Thought for {minutes}m {seconds}s",
    summaryLabel: "Reasoning summary",
  },
  ko: {
    thinking: "생각하는 중",
    thought: "생각함",
    thoughtSeconds: "{seconds}초 동안 생각함",
    thoughtMinutes: "{minutes}분 {seconds}초 동안 생각함",
    summaryLabel: "생각 과정 요약",
  },
  zh: {
    thinking: "思考中",
    thought: "已思考",
    thoughtSeconds: "已思考 {seconds} 秒",
    thoughtMinutes: "已思考 {minutes} 分 {seconds} 秒",
    summaryLabel: "推理摘要",
  },
  "zh-Hant": {
    thinking: "思考中",
    thought: "已思考",
    thoughtSeconds: "已思考 {seconds} 秒",
    thoughtMinutes: "已思考 {minutes} 分 {seconds} 秒",
    summaryLabel: "推理摘要",
  },
  fr: {
    thinking: "Réflexion en cours",
    thought: "A réfléchi",
    thoughtSeconds: "A réfléchi pendant {seconds} s",
    thoughtMinutes: "A réfléchi pendant {minutes} min {seconds} s",
    summaryLabel: "Résumé du raisonnement",
  },
  de: {
    thinking: "Denkt nach",
    thought: "Hat nachgedacht",
    thoughtSeconds: "{seconds} Sek. nachgedacht",
    thoughtMinutes: "{minutes} Min. {seconds} Sek. nachgedacht",
    summaryLabel: "Zusammenfassung der Überlegungen",
  },
  es: {
    thinking: "Pensando",
    thought: "Pensó",
    thoughtSeconds: "Pensó durante {seconds} s",
    thoughtMinutes: "Pensó durante {minutes} min {seconds} s",
    summaryLabel: "Resumen del razonamiento",
  },
  pt: {
    thinking: "Pensando",
    thought: "Pensou",
    thoughtSeconds: "Pensou por {seconds} s",
    thoughtMinutes: "Pensou por {minutes} min {seconds} s",
    summaryLabel: "Resumo do raciocínio",
  },
};

/** "Thought for 12s", or just "Thought" when the time is not known. */
export const thoughtLabel = (copy: ChatReasoningCopy, durationMs: number | null): string => {
  if (durationMs === null) return copy.thought;
  const total = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return (minutes > 0 ? copy.thoughtMinutes : copy.thoughtSeconds)
    .replace("{minutes}", String(minutes))
    .replace("{seconds}", String(seconds));
};
