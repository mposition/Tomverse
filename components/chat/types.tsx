export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "normal" | "error" | "cancelled";
  modelId?: string; // 💡 모델 ID 추가
};

export type Conversation = {
  id: string;
    title: string;
    selectedModels?: string[];
    disabledPanels?: string[];
    isLocked?: boolean; // 💡 잠금 여부 (백엔드에서 password 존재 여부로 true/false 반환)
};

export type AiModel = {
  id: string;
  name: string;
  icon: string;
};

export const AVAILABLE_MODELS: AiModel[] = [
  { id: "gpt-4o", name: "GPT-4o", icon: "🤖" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", icon: "🧠" },
  { id: "gemini-1-5", name: "Gemini 1.5", icon: "✨" },
];