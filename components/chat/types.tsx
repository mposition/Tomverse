export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  data?: string;
  objectKey?: string;
  kind: "file" | "text";
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "normal" | "error" | "cancelled";
  attachments?: ChatAttachment[];
  modelId?: string;
};

export type Conversation = {
  id: string;
    title: string;
    selectedModels?: string[];
    disabledPanels?: string[];
    isLocked?: boolean;
    shareEnabled?: boolean;
    shareExpiresAt?: string | null;
};

export const MAX_SELECTED_MODELS = 3;

export {
    AVAILABLE_MODELS,
    ENABLED_MODELS,
    getEnabledModel,
    getModel,
    isEnabledModelId,
} from "@/lib/models";
export type {
    AiModel,
    AiProvider,
    ModelId,
    ModelStatus,
    ModelTier,
} from "@/lib/models";
