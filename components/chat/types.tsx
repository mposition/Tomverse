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
};

export const AVAILABLE_MODELS: AiModel[] = [
  { id: "gpt-4o", name: "GPT-4o", icon: "🤖" },
  { id: "claude-3-5", name: "Claude 3.5", icon: "🧠" },
  { id: "gemini-1-5", name: "Gemini 1.5", icon: "✨" },
];